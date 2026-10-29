import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { optText, parse, text } from "@/lib/core/validation";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { cancelPendingApproval, requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";
import { writeDay } from "@/lib/hr/attendance";
import { ENGINE_VERSION, calculatePayroll, type Calculation } from "@/lib/hr/payroll-engine";

/**
 * Payroll runs up to approval (docs/erp/HR_PAYROLL_GAP_AUDIT.md §4.1, §4.2).
 *
 *   draft → calculated → pending_approval → approved;   draft / calculated → cancelled
 *   pending_approval → calculated (returned by the approver, or withdrawn by the preparer)
 *   approved → calculated (approval withdrawn before posting)
 *
 * Prepared and submitted by hr.payroll.prepare; approved by hr.payroll.approve, never by whoever
 * prepared or submitted it (service check and DB CHECK). Submitting locks the period's attendance
 * of the included employees; approving re-runs the calculation and refuses if anything changed.
 * Posting, payments and reversal after approval: lib/hr/payroll-posting.ts.
 */

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
const READ: Permission[] = ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"];
function assertCanRead(actor: ServiceActor) {
  if (!READ.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.payroll.view");
}
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الشهر لازم يكون YYYY-MM");

function bounds(p: string) {
  const [y, m] = p.split("-").map(Number);
  return { from: `${p}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/** Employees with an employment row (not terminated) on any day of the period. */
async function employedIn(db: Pick<Tx, "employeeEmployment">, from: string, to: string) {
  const rows = await db.employeeEmployment.findMany({
    where: { effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }], status: { not: "terminated" } },
    select: { employeeId: true, effectiveFrom: true, effectiveTo: true },
  });
  return [...new Set(rows.filter((r) => !(r.effectiveTo && r.effectiveTo < r.effectiveFrom)).map((r) => r.employeeId))];
}

async function lockRun(tx: Tx, id: string) {
  await advisoryXactLock(tx, `payroll-run:${id}`);
  const run = await tx.payrollRun.findUnique({ where: { id } });
  if (!run) throw new ApiError(404, "مسير المرتبات مش موجود");
  return run;
}

// ---------------------------------------------------------------------------
// Create, read
// ---------------------------------------------------------------------------

/** POST /api/hr/payroll/runs — the month's regular run, with a payslip for everyone employed in it. */
export async function createRun(body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  const v = parse(z.object({ period }), body);
  if (v.period > todayLocalISO().slice(0, 7)) throw new ApiError(400, "مينفعش تعمل مسير لشهر لسه مجاش");
  const { from, to } = bounds(v.period);
  try {
    return await inTx(async (tx) => {
      await advisoryXactLock(tx, `payroll-period:${v.period}`);
      if (await tx.payrollRun.findFirst({ where: { period: v.period, runType: "regular", status: { notIn: ["cancelled", "reversed"] } } })) throw new ApiError(409, `فيه مسير مرتبات لشهر ${v.period} بالفعل`);
      const number = await nextDocumentNumber(tx, "hr.payroll_run", todayLocalISO());
      const run = await tx.payrollRun.create({ data: { number, period: v.period, attendanceFrom: from, attendanceTo: to, preparedById: actor.id, preparedBy: actor.name } });
      const ids = await employedIn(tx, from, to);
      if (ids.length) await tx.payrollRunEmployee.createMany({ data: ids.map((employeeId) => ({ runId: run.id, employeeId })) });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_created", entityType: "payroll_run", entityId: run.id, fieldChanged: v.period, newValue: `${number} · ${ids.length} employees`, source: "user", deviceId: actor.deviceId }, tx);
      return run;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, `فيه مسير مرتبات لشهر ${v.period} بالفعل`);
    throw err;
  }
}

export async function listRuns(actor: ServiceActor) {
  assertCanRead(actor);
  return prisma.payrollRun.findMany({ orderBy: [{ period: "desc" }, { createdAt: "desc" }], take: 60 });
}

/** GET /api/hr/payroll/runs/:id — the run, its payslips (lines included) and what blocks it. */
export async function getRun(id: string, actor: ServiceActor) {
  assertCanRead(actor);
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: {
      employees: {
        orderBy: { employee: { code: "asc" } },
        include: { employee: { select: { id: true, code: true, name: true, nameAr: true, jobTitle: true, department: { select: { name: true, nameAr: true } } } }, lines: { orderBy: [{ sortOrder: "asc" }, { code: "asc" }] } },
      },
      snapshots: { orderBy: { sequence: "desc" }, select: { sequence: true, calculationHash: true, totals: true, calculatedBy: true, calculatedAt: true } },
    },
  });
  if (!run) throw new ApiError(404, "مسير المرتبات مش موجود");
  const prepare = actorCan(actor, "hr.payroll.prepare");
  const approver = actorCan(actor, "hr.payroll.approve");
  const blocking = run.employees.some((e) => e.inclusion === "included" && Array.isArray(e.exceptions) && (e.exceptions as { severity: string }[]).some((x) => x.severity === "error"));
  const mine = actor.id && (actor.id === run.preparedById || actor.id === run.submittedById);
  const livePayments = run.status === "posted" ? await prisma.payrollPayment.count({ where: { runId: id, reversedAt: null } }) : 0;
  return {
    ...run,
    can: {
      edit: prepare && ["draft", "calculated"].includes(run.status),
      calculate: prepare && ["draft", "calculated"].includes(run.status),
      submit: prepare && run.status === "calculated" && !blocking,
      withdraw: prepare && run.status === "pending_approval",
      decide: approver && run.status === "pending_approval" && !mine,
      reopen: approver && run.status === "approved",
      cancel: prepare && ["draft", "calculated"].includes(run.status),
      post: actorCan(actor, "hr.payroll.post") && run.status === "approved",
      // Reversal waits until every payment of the run is reversed (server-checked too).
      reverse: actorCan(actor, "hr.payroll.post") && run.status === "posted" && livePayments === 0,
      pay: actorCan(actor, "hr.payroll.pay") && run.status === "posted",
      bankFile: actorCan(actor, "hr.payroll.pay") && actorCan(actor, "hr.private.view") && run.status === "posted",
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs: inclusion, holds, advance recovery, one-off adjustments
// ---------------------------------------------------------------------------

const slipInput = z.object({
  inclusion: z.enum(["included", "on_hold"]).optional(),
  hold_reason: optText("سبب الإيقاف", 300).optional(),
  advance_recovery_requested: z.number().min(0).max(1e10).optional(),
});

/** PATCH /api/hr/payroll/runs/:id/employees/:employeeId — while the run is a draft or calculated. */
export async function updateRunEmployee(runId: string, employeeId: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  const v = parse(slipInput, body);
  return inTx(async (tx) => {
    const run = await lockRun(tx, runId);
    if (!["draft", "calculated"].includes(run.status)) throw new ApiError(409, "المسير اتبعت للاعتماد — رجّعه الأول");
    const slip = await tx.payrollRunEmployee.findUnique({ where: { runId_employeeId: { runId, employeeId } } });
    if (!slip) throw new ApiError(404, "الموظف مش في المسير ده");
    const inclusion = v.inclusion ?? slip.inclusion;
    if (inclusion === "on_hold" && !(v.hold_reason ?? slip.holdReason)) throw new ApiError(400, "اكتب سبب إيقاف مرتب الموظف");
    const row = await tx.payrollRunEmployee.update({
      where: { id: slip.id },
      data: {
        inclusion, holdReason: inclusion === "on_hold" ? v.hold_reason ?? slip.holdReason : null,
        ...(v.advance_recovery_requested !== undefined ? { advanceRecoveryRequested: D(v.advance_recovery_requested) } : {}),
        version: { increment: 1 },
      },
    });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_slip_updated", entityType: "payroll_run", entityId: runId, fieldChanged: employeeId, newValue: `${inclusion}${v.advance_recovery_requested !== undefined ? ` · recovery ${v.advance_recovery_requested}` : ""}`, reason: v.hold_reason ?? undefined, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

const adjustmentInput = z.object({
  employee_id: z.string().min(1),
  target_period: period,
  pay_component_id: z.string().min(1),
  amount: z.number().positive("المبلغ لازم يكون أكبر من صفر").max(1e10),
  reason: text("السبب", 500),
});

export async function listAdjustments(actor: ServiceActor, filter: { period?: string | null }) {
  assertCanRead(actor);
  return prisma.payrollAdjustment.findMany({
    where: filter.period ? { targetPeriod: filter.period } : {},
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { employee: { select: { id: true, code: true, name: true, nameAr: true } }, payComponent: { select: { code: true, nameAr: true, nameEn: true, kind: true } } },
  });
}

/** A one-off input for a month; it appears as its own line on the payslip the approver reviews. */
export async function createAdjustment(body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  const v = parse(adjustmentInput, body);
  return inTx(async (tx) => {
    const [emp, comp] = await Promise.all([tx.employee.findUnique({ where: { id: v.employee_id } }), tx.payComponent.findUnique({ where: { id: v.pay_component_id } })]);
    if (!emp) throw new ApiError(404, "الموظف مش موجود");
    if (!comp || !comp.active || comp.method !== "input") throw new ApiError(400, "البند لازم يكون مفعّل ومن نوع إدخال شهري");
    const run = await tx.payrollRun.findFirst({ where: { period: v.target_period, runType: "regular", status: { in: ["pending_approval", "approved", "posted"] } } });
    if (run) throw new ApiError(409, `مسير ${v.target_period} اتبعت للاعتماد — رجّعه الأول`);
    const number = await nextDocumentNumber(tx, "hr.payroll_adjustment", todayLocalISO());
    const row = await tx.payrollAdjustment.create({ data: { number, employeeId: emp.id, targetPeriod: v.target_period, payComponentId: comp.id, amount: D(v.amount), reason: v.reason, createdById: actor.id, createdBy: actor.name } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_adjustment_created", entityType: "payroll_adjustment", entityId: row.id, fieldChanged: emp.code, newValue: `${number} · ${comp.code} · ${v.target_period}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

export async function cancelAdjustment(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  return inTx(async (tx) => {
    const a = await tx.payrollAdjustment.findUnique({ where: { id }, include: { reservedOn: { include: { run: true } } } });
    if (!a) throw new ApiError(404, "التسوية مش موجودة");
    if (a.status === "reserved" && a.reservedOn && !["draft", "calculated"].includes(a.reservedOn.run.status)) throw new ApiError(409, "التسوية على مسير اتبعت للاعتماد");
    if (!["open", "reserved"].includes(a.status)) throw new ApiError(409, "التسوية اتقفلت بالفعل");
    const row = await tx.payrollAdjustment.update({ where: { id }, data: { status: "cancelled", reservedRunEmployeeId: null, cancelledBy: actor.name, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_adjustment_cancelled", entityType: "payroll_adjustment", entityId: id, fieldChanged: a.number, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Calculate
// ---------------------------------------------------------------------------

async function store(tx: Tx, runId: string, calc: Calculation, actor: { id: string | null; name: string }) {
  await tx.payrollRunLine.deleteMany({ where: { runEmployee: { runId } } });
  // Adjustments follow their payslip: reserved where calculated, released where no longer there.
  await tx.payrollAdjustment.updateMany({ where: { status: "reserved", reservedOn: { runId } }, data: { status: "open", reservedRunEmployeeId: null, version: { increment: 1 } } });
  for (const p of calc.payslips) {
    await tx.payrollRunEmployee.update({
      where: { id: p.runEmployeeId },
      data: {
        gross: p.gross, employeeDeductions: p.employeeDeductions, employerContributions: p.employerContributions, netEntitlement: p.netEntitlement,
        advanceRecovery: p.advanceRecovery, netPayable: p.netPayable, exceptions: p.exceptions as Prisma.InputJsonValue, compensationIds: p.compensationIds,
        employmentSnapshot: p.employmentSnapshot, inputsSnapshot: p.inputsSnapshot, inputsHash: p.inputsHash, version: { increment: 1 },
      },
    });
    if (p.lines.length) await tx.payrollRunLine.createMany({ data: p.lines.map((l) => ({ runEmployeeId: p.runEmployeeId, ...l })) });
    if (p.inclusion === "included" && p.adjustmentIds.length) {
      await tx.payrollAdjustment.updateMany({ where: { id: { in: p.adjustmentIds }, status: "open" }, data: { status: "reserved", reservedRunEmployeeId: p.runEmployeeId, version: { increment: 1 } } });
    }
  }
  const seq = (await tx.payrollCalculationSnapshot.count({ where: { runId } })) + 1;
  const totals = Object.fromEntries(Object.entries(calc.totals).map(([k, v]) => [k, v.toString()]));
  await tx.payrollCalculationSnapshot.create({
    data: {
      runId, sequence: seq, calculationHash: calc.hash, totals: { ...totals, rules: calc.rulesUsed },
      payslips: calc.payslips.map((p) => ({ e: p.employeeId, i: p.inclusion, net: p.netPayable.toString(), lines: p.lines.map((l) => [l.code, l.kind, l.amount.toString()]), x: p.exceptions })) as Prisma.InputJsonValue,
      calculatedById: actor.id, calculatedBy: actor.name,
    },
  });
  return seq;
}

/** POST /api/hr/payroll/runs/:id/calculate — (re)computes every payslip; every calculation is kept. */
export async function calculateRun(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  return inTx(async (tx) => {
    const run = await lockRun(tx, id);
    if (!["draft", "calculated"].includes(run.status)) throw new ApiError(409, "المسير اتبعت للاعتماد — رجّعه الأول");
    // Anyone employed in the period since the run was created joins it.
    const { from, to } = bounds(run.period);
    const have = new Set((await tx.payrollRunEmployee.findMany({ where: { runId: id }, select: { employeeId: true } })).map((e) => e.employeeId));
    const missing = (await employedIn(tx, from, to)).filter((e) => !have.has(e));
    if (missing.length) await tx.payrollRunEmployee.createMany({ data: missing.map((employeeId) => ({ runId: id, employeeId })) });
    const calc = await calculatePayroll(tx, run);
    const seq = await store(tx, id, calc, actor);
    const row = await tx.payrollRun.update({
      where: { id },
      data: {
        status: "calculated", calculatedAt: new Date(), calculationHash: calc.hash, engineVersion: ENGINE_VERSION, preparedById: actor.id, preparedBy: actor.name,
        gross: calc.totals.gross, employeeDeductions: calc.totals.employeeDeductions, employerContributions: calc.totals.employerContributions,
        advanceRecovery: calc.totals.advanceRecovery, netPayable: calc.totals.netPayable, headcount: calc.totals.headcount,
        exceptions: calc.exceptions as Prisma.InputJsonValue, version: { increment: 1 },
      },
    });
    const errors = calc.exceptions.filter((e) => e.severity === "error").length;
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_calculated", entityType: "payroll_run", entityId: id, fieldChanged: `#${seq}`, newValue: `${calc.totals.headcount} employees · ${errors} blocking issues · ${calc.hash.slice(0, 12)}`, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Submit, decide, return, cancel
// ---------------------------------------------------------------------------

async function lockAttendance(tx: Tx, run: { id: string; attendanceFrom: string; attendanceTo: string }, actor: { id: string | null; name: string; role: string }) {
  const included = (await tx.payrollRunEmployee.findMany({ where: { runId: run.id, inclusion: "included" }, select: { employeeId: true } })).map((e) => e.employeeId);
  const days = await tx.attendanceDay.findMany({ where: { employeeId: { in: included }, date: { gte: run.attendanceFrom, lte: run.attendanceTo } } });
  const draft = days.find((d) => d.state === "draft");
  if (draft) throw new ApiError(409, `فيه أيام حضور لسه مسودة (${draft.date}) — أكدها الأول`);
  const lockedElsewhere = days.find((d) => d.state === "locked" && d.lockedRunId !== run.id);
  if (lockedElsewhere) throw new ApiError(409, `يوم ${lockedElsewhere.date} مقفول في مسير تاني`);
  for (const d of days.filter((x) => x.state === "confirmed")) {
    await writeDay(tx, d, d, { state: "locked", lockedRunId: run.id }, { action: "locked", reason: run.id }, actor);
  }
}

/** Unlocks the run's days. A correction applied while they were locked is absorbed by this
 * still-unposted run's next calculation, so it no longer needs a retro adjustment. */
export async function unlockAttendance(tx: Tx, runId: string, actor: { id: string | null; name: string; role: string }) {
  const days = await tx.attendanceDay.findMany({ where: { lockedRunId: runId } });
  for (const d of days) {
    await tx.attendanceCorrection.updateMany({ where: { employeeId: d.employeeId, date: d.date, status: "approved", retroStatus: "pending" }, data: { retroStatus: "none" } });
    await writeDay(tx, d, d, { state: "confirmed", lockedRunId: null }, { action: "unlocked", reason: runId }, actor);
  }
}

/** POST /api/hr/payroll/runs/:id/submit — freezes the figures and sends them for approval. */
export async function submitRun(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  return inTx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== "calculated") throw new ApiError(409, "احسب المسير الأول");
    const calc = await calculatePayroll(tx, run);
    if (calc.hash !== run.calculationHash) throw new ApiError(409, "المدخلات اتغيرت من آخر حساب — احسب المسير تاني");
    const blocking = calc.exceptions.filter((e) => e.severity === "error");
    if (blocking.length) throw new ApiError(409, `فيه ${blocking.length} مشكلة لازم تتحل قبل الإرسال`);
    if (calc.totals.headcount === 0) throw new ApiError(409, "مفيش موظفين في المسير");
    await lockAttendance(tx, run, actor);
    const { request } = await requestApproval(tx, {
      type: "hr.payroll_run",
      entityId: id,
      title: `${run.number} · ${run.period}`,
      summary: `${calc.totals.headcount}`,
      amount: calc.totals.netPayable,
      payload: { runId: id, hash: calc.hash },
      requester: actor,
    });
    const row = await tx.payrollRun.update({ where: { id }, data: { status: "pending_approval", submittedById: actor.id, submittedBy: actor.name, submittedAt: new Date(), approvalRequestId: request.id, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_submitted", entityType: "payroll_run", entityId: id, fieldChanged: run.period, newValue: `${calc.totals.headcount} employees · ${calc.hash.slice(0, 12)}`, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/**
 * The approval handler's effect. Approved: only by someone who neither prepared nor submitted
 * the run, and only if a fresh calculation gives the submitted hash. Rejected = returned to the
 * preparer: back to calculated, attendance unlocked.
 */
export async function applyRunDecision(tx: Tx, id: string, approved: boolean, decider: Decider, comment?: string) {
  const run = await lockRun(tx, id);
  if (run.status !== "pending_approval") throw new ApiError(409, "المسير مش مستني اعتماد");
  if (decider.id && (decider.id === run.preparedById || decider.id === run.submittedById)) throw new ApiError(403, "مينفعش تعتمد مسير انت اللي حسبته أو بعته");
  if (!approved) {
    await unlockAttendance(tx, id, decider);
    await tx.payrollRun.update({ where: { id }, data: { status: "calculated", submittedById: null, submittedBy: null, submittedAt: null, approvalRequestId: null, version: { increment: 1 } } });
    await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "payroll_run_returned", entityType: "payroll_run", entityId: id, fieldChanged: run.period, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
    return;
  }
  const calc = await calculatePayroll(tx, run);
  if (calc.hash !== run.calculationHash) throw new ApiError(409, "أرقام المسير اتغيرت من وقت الإرسال — رجّعه للمُعد يحسبه تاني");
  await tx.payrollRun.update({ where: { id }, data: { status: "approved", approvedById: decider.id, approvedBy: decider.name, approvedAt: new Date(), version: { increment: 1 } } });
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "payroll_run_approved", entityType: "payroll_run", entityId: id, fieldChanged: run.period, newValue: `${run.headcount} employees · ${run.calculationHash?.slice(0, 12)}`, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
}

/** The preparer pulls a submitted run back (its approval request is cancelled). */
export async function withdrawRun(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  const v = parse(z.object({ reason: text("السبب", 300) }), body);
  return inTx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== "pending_approval") throw new ApiError(409, "المسير مش مستني اعتماد");
    await cancelPendingApproval(tx, { type: "hr.payroll_run", entityId: id, reason: v.reason, actor });
    await unlockAttendance(tx, id, actor);
    const row = await tx.payrollRun.update({ where: { id }, data: { status: "calculated", submittedById: null, submittedBy: null, submittedAt: null, approvalRequestId: null, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_withdrawn", entityType: "payroll_run", entityId: id, fieldChanged: run.period, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/** An approver withdraws an approval before posting: back to calculated, attendance unlocked. */
export async function reopenRun(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.approve");
  const v = parse(z.object({ reason: text("السبب", 300) }), body);
  return inTx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== "approved") throw new ApiError(409, "المسير مش معتمد");
    await unlockAttendance(tx, id, actor);
    const row = await tx.payrollRun.update({ where: { id }, data: { status: "calculated", submittedById: null, submittedBy: null, submittedAt: null, approvalRequestId: null, approvedById: null, approvedBy: null, approvedAt: null, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_reopened", entityType: "payroll_run", entityId: id, fieldChanged: run.period, oldValue: "approved", newValue: "calculated", reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/** Before submission only. Releases the run's adjustments; the period can then get a new run. */
export async function cancelRun(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  const v = parse(z.object({ reason: text("السبب", 300) }), body);
  return inTx(async (tx) => {
    const run = await lockRun(tx, id);
    if (!["draft", "calculated"].includes(run.status)) throw new ApiError(409, "المسير اتبعت للاعتماد — رجّعه الأول");
    await tx.payrollAdjustment.updateMany({ where: { status: "reserved", reservedOn: { runId: id } }, data: { status: "open", reservedRunEmployeeId: null, version: { increment: 1 } } });
    const row = await tx.payrollRun.update({ where: { id }, data: { status: "cancelled", cancelledReason: v.reason, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_cancelled", entityType: "payroll_run", entityId: id, fieldChanged: run.period, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}
