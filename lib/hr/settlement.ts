import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { parse, text } from "@/lib/core/validation";
import { nextDocumentNumber } from "@/lib/core/sequences";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";
import { custodyBalance } from "@/lib/hr/custody";

/**
 * Final settlement of a leaver (WS5, audit HR-12; docs/erp/REMEDIATION_PLAN_2026-11.md).
 *
 * A settlement is a payroll run of type `final_settlement` with one payslip, plus its inputs:
 *  - pay of the month up to the last working day, inclusive (the termination row's date, HR-20),
 *    prorated by the verified pay_proration rule;
 *  - the unused balance of every encashable leave type (HR-11), days × the daily rate of the
 *    same rule, written to the leave ledger as `encashment` when the run posts;
 *  - manual items (notice in lieu, contractual or legal compensation, a deduction…), each with
 *    an input pay component and a reason — no entitlement is computed by law here, the amounts
 *    are HR's decision (Law 14/2025 entitlements are not verified);
 *  - recovery of the open advance balance (editable; above the recovery cap it is shown to the
 *    approver as a warning — the settlement's approval is the exception's approval);
 *  - statutory lines on the whole, as for any payslip.
 * The run is calculated, submitted and approved by someone other than its preparer, posted
 * through the ordinary payroll posting and paid like any run; it prints as a payslip and
 * exports as a register. Until it is posted, the month's regular run is blocked for the leaver;
 * afterwards the regular payslip is empty ("paid by settlement").
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
const READ: Permission[] = ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"];
function assertCanRead(actor: ServiceActor) {
  if (!READ.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.payroll.view");
}

const item = z.object({
  pay_component_id: z.string().min(1),
  amount: z.number().positive("المبلغ لازم يكون أكبر من صفر").max(1e10),
  reason: text("سبب البند", 300),
});
const createInput = z.object({
  employee_id: z.string().min(1),
  reason: text("السبب", 500),
  encash_leave: z.boolean().optional(),
  /** Default: the whole open advance balance (less this month's on-account salary, recovered anyway). */
  advance_recovery: z.number().min(0).max(1e10).optional(),
  items: z.array(item).max(30).optional(),
});
const updateInput = createInput.omit({ employee_id: true }).partial();

const include = {
  run: { select: { id: true, number: true, period: true, status: true, netPayable: true, gross: true } },
  employee: { select: { id: true, code: true, name: true, nameAr: true } },
  items: { include: { payComponent: { select: { id: true, code: true, nameAr: true, nameEn: true, kind: true } } }, orderBy: { id: "asc" as const } },
} as const;

async function checkItems(tx: Tx, items: z.infer<typeof item>[]) {
  if (!items.length) return;
  const ids = [...new Set(items.map((i) => i.pay_component_id))];
  const comps = await tx.payComponent.findMany({ where: { id: { in: ids } } });
  if (comps.length !== ids.length) throw new ApiError(400, "بند المرتب مش موجود");
  const bad = comps.find((c) => !c.active || c.method !== "input" || !["earning", "deduction"].includes(c.kind));
  if (bad) throw new ApiError(400, `البند ${bad.code} لازم يكون مفعّل، إدخال لمرة، واستحقاق أو استقطاع`);
}

/**
 * The open advance balance of an employee (journal, employee advances) less recoveries counted by
 * unposted runs. Purchasing custody is left out: it is never recovered from a leaver's pay by
 * default (it is settled by a return or supplier payments and shown for review — pending owner decision).
 */
async function openAdvance(tx: Tx, employeeId: string) {
  const [bal, pending, custody] = await Promise.all([
    tx.journalLine.aggregate({ where: { partyType: "employee", partyId: employeeId, account: { systemKey: "employee_advances" } }, _sum: { debit: true, credit: true } }),
    tx.payrollRunEmployee.aggregate({ where: { employeeId, inclusion: "included", run: { status: { notIn: ["cancelled", "posted", "reversed"] } } }, _sum: { advanceRecovery: true } }),
    custodyBalance(tx, employeeId),
  ]);
  return D(bal._sum.debit ?? 0).minus(bal._sum.credit ?? 0).minus(custody).minus(pending._sum.advanceRecovery ?? 0);
}

/** POST /api/hr/payroll/settlements — the settlement run of a terminated employee. */
export async function createSettlement(body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  const v = parse(createInput, body);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `hr-settlement:${v.employee_id}`);
    const employee = await tx.employee.findUnique({ where: { id: v.employee_id }, select: { id: true, code: true, name: true } });
    if (!employee) throw new ApiError(404, "الموظف مش موجود");
    const open = await tx.employeeEmployment.findFirst({ where: { employeeId: v.employee_id, effectiveTo: null } });
    if (!open || open.status !== "terminated") throw new ApiError(409, "خدمة الموظف لسه منتهتش — سجّل انتهاء الخدمة الأول");
    const live = await tx.employeeFinalSettlement.findFirst({ where: { employeeId: v.employee_id, terminationEmploymentId: open.id, run: { status: { notIn: ["cancelled", "reversed"] } } }, include: { run: true } });
    if (live) throw new ApiError(409, `فيه تسوية نهائية للموظف ده بالفعل (${live.run.number})`);
    await checkItems(tx, v.items ?? []);
    const lastDay = open.effectiveFrom;
    const period = lastDay.slice(0, 7);
    const onAccount = (await tx.employeeTransaction.aggregate({ where: { employeeId: v.employee_id, type: "salary_on_account", payrollPeriod: period }, _sum: { amount: true } }))._sum.amount ?? ZERO;
    const recovery = v.advance_recovery !== undefined ? D(v.advance_recovery) : Prisma.Decimal.max(ZERO, (await openAdvance(tx, v.employee_id)).minus(onAccount));
    const number = await nextDocumentNumber(tx, "hr.payroll_run", todayLocalISO());
    const run = await tx.payrollRun.create({
      data: { number, period, runType: "final_settlement", reason: v.reason, attendanceFrom: `${period}-01`, attendanceTo: lastDay, preparedById: actor.id, preparedBy: actor.name },
    });
    await tx.payrollRunEmployee.create({ data: { runId: run.id, employeeId: v.employee_id, advanceRecoveryRequested: recovery } });
    const settlement = await tx.employeeFinalSettlement.create({
      data: {
        employeeId: v.employee_id, runId: run.id, terminationEmploymentId: open.id, lastWorkingDay: lastDay, encashLeave: v.encash_leave ?? true, reason: v.reason,
        createdById: actor.id, createdBy: actor.name,
        items: { create: (v.items ?? []).map((i) => ({ payComponentId: i.pay_component_id, amount: D(i.amount), reason: i.reason })) },
      },
      include,
    });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "final_settlement_created", entityType: "payroll_run", entityId: run.id, fieldChanged: employee.code, newValue: `${number} · last day ${lastDay} · ${(v.items ?? []).length} items · leave ${settlement.encashLeave ? "encashed" : "kept"}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return settlement;
  });
}

/** PATCH /api/hr/payroll/settlements/:id — inputs change while the run is a draft or calculated (recalculate after). */
export async function updateSettlement(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.prepare");
  const v = parse(updateInput, body);
  return inTx(async (tx) => {
    const s = await tx.employeeFinalSettlement.findUnique({ where: { id }, include: { run: true } });
    if (!s) throw new ApiError(404, "التسوية النهائية مش موجودة");
    await advisoryXactLock(tx, `payroll-run:${s.runId}`);
    if (!["draft", "calculated"].includes(s.run.status)) throw new ApiError(409, "التسوية اتبعتت للاعتماد — رجّعها الأول");
    if (v.items) {
      await checkItems(tx, v.items);
      await tx.employeeFinalSettlementItem.deleteMany({ where: { settlementId: id } });
      if (v.items.length) await tx.employeeFinalSettlementItem.createMany({ data: v.items.map((i) => ({ settlementId: id, payComponentId: i.pay_component_id, amount: D(i.amount), reason: i.reason })) });
    }
    if (v.advance_recovery !== undefined) await tx.payrollRunEmployee.updateMany({ where: { runId: s.runId, employeeId: s.employeeId }, data: { advanceRecoveryRequested: D(v.advance_recovery), version: { increment: 1 } } });
    const row = await tx.employeeFinalSettlement.update({ where: { id }, data: { ...(v.encash_leave !== undefined ? { encashLeave: v.encash_leave } : {}), ...(v.reason ? { reason: v.reason } : {}), version: { increment: 1 } }, include });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "final_settlement_updated", entityType: "payroll_run", entityId: s.runId, fieldChanged: s.run.number, newValue: `${row.items.length} items · leave ${row.encashLeave ? "encashed" : "kept"}${v.advance_recovery !== undefined ? ` · recovery ${v.advance_recovery}` : ""}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

export async function getSettlement(id: string, actor: ServiceActor) {
  assertCanRead(actor);
  const s = await prisma.employeeFinalSettlement.findUnique({ where: { id }, include });
  if (!s) throw new ApiError(404, "التسوية النهائية مش موجودة");
  return s;
}

export async function listSettlements(actor: ServiceActor) {
  assertCanRead(actor);
  return prisma.employeeFinalSettlement.findMany({ orderBy: { createdAt: "desc" }, take: 200, include });
}
