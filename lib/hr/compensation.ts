import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidCalendarDate } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { cancelPendingApproval, requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";
import { dayBefore } from "@/lib/hr/employment";

/**
 * Compensation (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.6).
 *
 * Salaries are confidential: every read needs hr.compensation.view and nothing here is ever
 * returned by the employee directory. A package is proposed (hr.compensation.manage) and
 * approved by someone else (hr.payroll.approve — also a DB CHECK). Approving closes the
 * employee's previous package the day before the new one starts; approved packages never
 * overlap and are never edited.
 */

const dec = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
export const SYSTEM_ROLES = [
  "overtime_day", "overtime_night", "overtime_rest_day", "overtime_holiday", "unpaid_absence", "partial_leave",
  "social_insurance_employee", "social_insurance_employer", "income_tax", "other_levy_employee", "other_levy_employer", "advance_recovery", "rounding",
] as const;

// ---------------------------------------------------------------------------
// Pay components
// ---------------------------------------------------------------------------

const componentInput = z.object({
  code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{1,29}$/, "الكود حروف إنجليزي وأرقام"),
  name_ar: text("الاسم", 100),
  name_en: optText("الاسم بالإنجليزي", 100).optional(),
  kind: z.enum(["earning", "deduction", "employer_contribution", "information"], { errorMap: () => ({ message: "نوع البند غير معروف" }) }),
  method: z.enum(["fixed", "input", "system"], { errorMap: () => ({ message: "طريقة حساب البند غير معروفة" }) }),
  system_role: z.enum(SYSTEM_ROLES).nullable().optional(),
  taxable: z.boolean().nullable().optional(),
  insurable: z.boolean().nullable().optional(),
  expense_account_id: z.string().nullable().optional(),
  liability_account_id: z.string().nullable().optional(),
  payslip_order: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
  expected_version: z.number().int().positive().optional(),
});

const COMPONENT_READERS: Permission[] = ["hr.compensation.view", "hr.compensation.manage", "hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve"];
export async function listComponents(actor: ServiceActor) {
  if (!COMPONENT_READERS.some((p) => actorCan(actor, p))) {
    assertPermission(actor, "hr.compensation.view");
  }
  return prisma.payComponent.findMany({
    orderBy: [{ payslipOrder: "asc" }, { code: "asc" }],
    include: { expenseAccount: { select: { code: true, name: true, nameAr: true } }, liabilityAccount: { select: { code: true, name: true, nameAr: true } } },
  });
}

/** Kind, method and role are fixed once a package uses the component. */
export async function saveComponent(id: string | null, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.compensation.manage");
  const v = parse(componentInput, body);
  if ((v.method === "system") !== !!v.system_role) throw new ApiError(400, "البند المحسوب من النظام بس اللي ليه دور");
  if (v.active && (v.taxable == null || v.insurable == null)) throw new ApiError(400, "حدد خضوع البند للضريبة والتأمينات قبل التفعيل (قرار المحاسب)");
  for (const [accId, label] of [[v.expense_account_id, "المصروف"], [v.liability_account_id, "الالتزام"]] as const) {
    if (accId && !(await prisma.account.findUnique({ where: { id: accId } }))) throw new ApiError(400, `حساب ${label} مش موجود`);
  }
  const data = {
    code: v.code, nameAr: v.name_ar, nameEn: v.name_en ?? null, kind: v.kind, method: v.method, systemRole: v.system_role ?? null,
    taxable: v.taxable ?? null, insurable: v.insurable ?? null, expenseAccountId: v.expense_account_id ?? null, liabilityAccountId: v.liability_account_id ?? null,
    payslipOrder: v.payslip_order ?? 100, active: v.active ?? false,
  };
  try {
    return await inTx(async (tx) => {
      let row;
      if (!id) row = await tx.payComponent.create({ data: { ...data, createdBy: actor.name } });
      else {
        const cur = await tx.payComponent.findUnique({ where: { id } });
        if (!cur) throw new ApiError(404, "بند المرتب مش موجود");
        if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "البند اتعدّل من واحد تاني، حدّث الشاشة");
        const used = await tx.employeeCompensationLine.count({ where: { payComponentId: id } });
        if (used && (cur.kind !== data.kind || cur.method !== data.method || cur.systemRole !== data.systemRole || cur.code !== data.code)) {
          throw new ApiError(409, "البند مستخدم في مرتبات — الكود والنوع والطريقة مبيتغيروش؛ اعمل بند جديد");
        }
        row = await tx.payComponent.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      }
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: id ? "pay_component_updated" : "pay_component_created", entityType: "pay_component", entityId: row.id, fieldChanged: row.code, newValue: `${row.kind} · ${row.method}${row.systemRole ? ` · ${row.systemRole}` : ""} · tax ${row.taxable ?? "?"} · SI ${row.insurable ?? "?"}${row.active ? "" : " · inactive"}`, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "الكود أو الدور مستخدم لبند تاني");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

const packageInput = z.object({
  employee_id: z.string().min(1),
  effective_from: z.string().refine(isValidCalendarDate, "التاريخ لازم يكون YYYY-MM-DD"),
  insurable_wage: z.number().min(0).max(1e10).nullable().optional(),
  reason: text("السبب", 500),
  lines: z.array(z.object({ pay_component_id: z.string().min(1), amount: z.number().positive("المبلغ لازم يكون أكبر من صفر").max(1e10) })).min(1, "اكتب بند واحد على الأقل").max(30),
});

const lineInclude = { lines: { include: { payComponent: { select: { id: true, code: true, nameAr: true, nameEn: true, kind: true } } } } } as const;

/** GET /api/hr/compensation?employee_id= — packages with their lines (hr.compensation.view). */
export async function listPackages(actor: ServiceActor, filter: { employeeId?: string | null; status?: string | null }) {
  assertPermission(actor, "hr.compensation.view");
  const rows = await prisma.employeeCompensation.findMany({
    where: { ...(filter.employeeId ? { employeeId: filter.employeeId } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take: 500,
    include: { employee: { select: { id: true, code: true, name: true, nameAr: true } }, ...lineInclude },
  });
  const approver = actorCan(actor, "hr.payroll.approve");
  return rows.map((r) => ({
    ...r,
    total: r.lines.reduce((a, l) => (l.payComponent.kind === "earning" ? a.plus(l.amount) : a), dec(0)),
    canDecide: approver && r.status === "pending" && r.createdById !== actor.id,
    canCancel: r.status === "pending" && (r.createdById === actor.id || approver),
  }));
}

/** The approved package in force on a date (used by payroll). */
export async function packageOn(db: Pick<Tx, "employeeCompensation">, employeeId: string, date: string) {
  return db.employeeCompensation.findFirst({
    where: { employeeId, status: "approved", effectiveFrom: { lte: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] },
    include: { lines: { include: { payComponent: true } } },
  });
}

/** POST /api/hr/compensation — a proposed package, sent for approval by someone else. */
export async function proposePackage(body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.compensation.manage");
  const v = parse(packageInput, body);
  const ids = v.lines.map((l) => l.pay_component_id);
  if (new Set(ids).size !== ids.length) throw new ApiError(400, "البند متكرر في نفس المرتب");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `hr-compensation:${v.employee_id}`);
    const employee = await tx.employee.findUnique({ where: { id: v.employee_id }, select: { id: true, code: true, name: true, nameAr: true } });
    if (!employee) throw new ApiError(404, "الموظف مش موجود");
    const components = await tx.payComponent.findMany({ where: { id: { in: ids } } });
    if (components.length !== ids.length) throw new ApiError(400, "بند المرتب مش موجود");
    const bad = components.find((c) => !c.active || c.method !== "fixed");
    if (bad) throw new ApiError(400, `البند ${bad.code} لازم يكون مفعّل وثابت شهري`);
    if (await tx.employeeCompensation.findFirst({ where: { employeeId: v.employee_id, status: "pending" } })) throw new ApiError(409, "فيه مرتب مقترح مستني قرار للموظف ده");
    const latest = await tx.employeeCompensation.findFirst({ where: { employeeId: v.employee_id, status: "approved" }, orderBy: { effectiveFrom: "desc" } });
    if (latest && v.effective_from <= latest.effectiveFrom) throw new ApiError(400, `المرتب الجديد لازم يبدأ بعد ${latest.effectiveFrom} (بداية المرتب الحالي)`);
    const number = await nextDocumentNumber(tx, "hr.compensation", todayLocalISO());
    const row = await tx.employeeCompensation.create({
      data: {
        number, employeeId: v.employee_id, effectiveFrom: v.effective_from, insurableWage: v.insurable_wage == null ? null : dec(v.insurable_wage), reason: v.reason,
        createdById: actor.id, createdBy: actor.name, lines: { create: v.lines.map((l) => ({ payComponentId: l.pay_component_id, amount: dec(l.amount) })) },
      },
      include: lineInclude,
    });
    const gross = row.lines.reduce((a, l) => (l.payComponent.kind === "earning" ? a.plus(l.amount) : a), dec(0));
    const { request } = await requestApproval(tx, {
      type: "hr.compensation_change",
      entityId: row.id,
      title: `${number} · ${employee.name}`,
      summary: `${v.effective_from}`,
      amount: gross,
      payload: { compensationId: row.id },
      reason: v.reason,
      requester: actor,
    });
    const out = await tx.employeeCompensation.update({ where: { id: row.id }, data: { approvalRequestId: request.id }, include: lineInclude });
    // The audit row names the package, not the amounts: amounts stay in the package itself.
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "compensation_proposed", entityType: "employee_compensation", entityId: row.id, fieldChanged: employee.code, newValue: `${number} · from ${v.effective_from} · ${v.lines.length} lines`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return out;
  });
}

/**
 * The approval handler's effect. Approved: the previous approved package ends the day before
 * this one starts (superseded when that leaves it empty), and this one is in force. The
 * proposer may not decide (also a DB CHECK).
 */
export async function applyCompensationDecision(tx: Tx, id: string, approved: boolean, decider: Decider, comment?: string) {
  const c = await tx.employeeCompensation.findUnique({ where: { id } });
  if (!c) throw new ApiError(404, "المرتب المقترح مش موجود");
  if (c.status !== "pending") throw new ApiError(409, "المرتب المقترح ده اتقفل بالفعل");
  if (decider.id && decider.id === c.createdById) throw new ApiError(403, "مينفعش تعتمد مرتب انت اللي اقترحته");
  await advisoryXactLock(tx, `hr-compensation:${c.employeeId}`);
  const decided = { decidedById: decider.id, decidedBy: decider.name, decidedAt: new Date(), decisionComment: comment?.trim() || null, version: { increment: 1 } };
  if (!approved) {
    await tx.employeeCompensation.update({ where: { id }, data: { status: "rejected", ...decided } });
    await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "compensation_rejected", entityType: "employee_compensation", entityId: id, fieldChanged: c.number, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
    return;
  }
  const latest = await tx.employeeCompensation.findFirst({ where: { employeeId: c.employeeId, status: "approved" }, orderBy: { effectiveFrom: "desc" } });
  if (latest && c.effectiveFrom <= latest.effectiveFrom) throw new ApiError(409, `فيه مرتب معتمد بيبدأ ${latest.effectiveFrom} — المقترح لازم يبدأ بعده`);
  if (latest && !latest.effectiveTo) {
    await tx.employeeCompensation.update({ where: { id: latest.id }, data: { effectiveTo: dayBefore(c.effectiveFrom), version: { increment: 1 } } });
  } else if (latest?.effectiveTo && latest.effectiveTo >= c.effectiveFrom) {
    throw new ApiError(409, "المرتب الحالي منتهي بعد بداية المقترح");
  }
  await tx.employeeCompensation.update({ where: { id }, data: { status: "approved", ...decided } });
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "compensation_approved", entityType: "employee_compensation", entityId: id, fieldChanged: c.number, newValue: `from ${c.effectiveFrom}${latest ? ` · closes ${latest.number}` : ""}`, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
}

/** The proposer (or an approver) withdraws a pending package. */
export async function cancelPackage(id: string, actor: ServiceActor) {
  return inTx(async (tx) => {
    const c = await tx.employeeCompensation.findUnique({ where: { id } });
    if (!c) throw new ApiError(404, "المرتب المقترح مش موجود");
    if (c.createdById !== actor.id) assertPermission(actor, "hr.payroll.approve");
    else assertPermission(actor, "hr.compensation.manage");
    if (c.status !== "pending") throw new ApiError(409, "المرتب المقترح ده اتقفل بالفعل");
    const row = await tx.employeeCompensation.update({ where: { id, version: c.version }, data: { status: "cancelled", version: { increment: 1 } } });
    await cancelPendingApproval(tx, { type: "hr.compensation_change", entityId: id, reason: "سحب المرتب المقترح", actor });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "compensation_withdrawn", entityType: "employee_compensation", entityId: id, fieldChanged: c.number, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}
