import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { inTx } from "@/lib/tx";
import { parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";

/**
 * Advance instalment plans (WS5, audit HR-17).
 *
 * One plan per advance: a total (at most the advance), an instalment and the first payroll
 * month. Proposed by whoever manages advances, approved by someone else with
 * hr.payroll.approve (service check and DB CHECK). Once active, every regular payroll run
 * deducts the instalment automatically until the total is recovered — reduced to the cap
 * (setting hr.advance_recovery_max_pct of the month's net entitlement, default 10%, needs
 * legal confirmation) unless the approved plan allows exceeding it, and never above the open
 * advance balance. Recovered amounts are the plan's recovery lines on posted payslips.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
const READ: Permission[] = ["hr.advances.manage", "hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve"];
function assertCanRead(actor: ServiceActor) {
  if (!READ.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.advances.manage");
}
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الشهر لازم يكون YYYY-MM");

const createInput = z.object({
  advance_transaction_id: z.string().min(1),
  instalment_amount: z.number().positive("القسط لازم يكون أكبر من صفر").max(1e10),
  total_amount: z.number().positive().max(1e10).optional(),
  start_period: period,
  allow_above_cap: z.boolean().optional(),
  reason: text("السبب", 300),
});

/** What each plan has recovered on posted payslips, and what is left. */
async function withProgress<T extends { id: string; totalAmount: Prisma.Decimal }>(rows: T[]) {
  const done = rows.length
    ? await prisma.payrollRunLine.groupBy({ by: ["sourceId"], where: { sourceType: "advance_recovery", sourceId: { in: rows.map((r) => r.id) }, runEmployee: { inclusion: "included", run: { status: "posted" } } }, _sum: { amount: true } })
    : [];
  const by = new Map(done.map((d) => [d.sourceId, d._sum.amount ?? ZERO]));
  return rows.map((r) => ({ ...r, recovered: (by.get(r.id) ?? ZERO).toFixed(2), remaining: Prisma.Decimal.max(ZERO, r.totalAmount.minus(by.get(r.id) ?? ZERO)).toFixed(2) }));
}

export async function listAdvancePlans(actor: ServiceActor, filter: { employeeId?: string | null }) {
  assertCanRead(actor);
  const rows = await prisma.employeeAdvancePlan.findMany({
    where: filter.employeeId ? { employeeId: filter.employeeId } : {},
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { employee: { select: { id: true, code: true, name: true, nameAr: true } }, advance: { select: { id: true, date: true, amount: true } } },
  });
  const approver = actorCan(actor, "hr.payroll.approve");
  return (await withProgress(rows)).map((r) => ({ ...r, canDecide: approver && r.status === "pending" && !!actor.id && r.createdById !== actor.id }));
}

/** POST /api/hr/advance-plans — proposed; nothing is deducted until someone else approves it. */
export async function createAdvancePlan(body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.advances.manage");
  const v = parse(createInput, body);
  try {
    return await inTx(async (tx) => {
      const adv = await tx.employeeTransaction.findUnique({ where: { id: v.advance_transaction_id }, include: { employee: { select: { code: true } } } });
      if (!adv || adv.type !== "advance") throw new ApiError(400, "خطة السداد بتكون لسلفة متسجلة");
      const total = v.total_amount !== undefined ? D(v.total_amount) : adv.amount;
      if (total.gt(adv.amount)) throw new ApiError(400, `إجمالي الخطة أكبر من السلفة (${adv.amount.toFixed(2)})`);
      if (D(v.instalment_amount).gt(total)) throw new ApiError(400, "القسط أكبر من إجمالي الخطة");
      const row = await tx.employeeAdvancePlan.create({
        data: {
          employeeId: adv.employeeId, advanceTransactionId: adv.id, totalAmount: total, instalmentAmount: D(v.instalment_amount), startPeriod: v.start_period,
          allowAboveCap: !!v.allow_above_cap, reason: v.reason, createdById: actor.id, createdBy: actor.name,
        },
      });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "advance_plan_created", entityType: "employee_transaction", entityId: adv.id, fieldChanged: `plan ${row.id} · ${adv.employee.code}`, newValue: `${total.toFixed(2)} · ${v.instalment_amount} / month from ${v.start_period}${v.allow_above_cap ? " · above cap" : ""}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "السلفة دي ليها خطة سداد بالفعل");
    throw err;
  }
}

/** POST /api/hr/advance-plans/:id/approve — by someone other than its author (and never an unknown actor). */
export async function approveAdvancePlan(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.approve");
  return inTx(async (tx) => {
    const p = await tx.employeeAdvancePlan.findUnique({ where: { id } });
    if (!p) throw new ApiError(404, "خطة السداد مش موجودة");
    if (p.status !== "pending") throw new ApiError(409, "خطة السداد مش مستنية اعتماد");
    if (!actor.id || !p.createdById || actor.id === p.createdById) throw new ApiError(403, "الاعتماد لازم يكون من شخص معروف غير اللي عمل الخطة");
    const row = await tx.employeeAdvancePlan.update({ where: { id, version: p.version }, data: { status: "active", approvedById: actor.id, approvedBy: actor.name, approvedAt: new Date(), version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "advance_plan_approved", entityType: "employee_transaction", entityId: p.advanceTransactionId, fieldChanged: `plan ${id}`, oldValue: "pending", newValue: "active", source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/** POST /api/hr/advance-plans/:id/cancel — stops further instalments; what was recovered stays. */
export async function cancelAdvancePlan(id: string, body: unknown, actor: ServiceActor) {
  if (!actorCan(actor, "hr.payroll.approve")) assertPermission(actor, "hr.advances.manage");
  const v = parse(z.object({ reason: text("السبب", 300) }), body);
  return inTx(async (tx) => {
    const p = await tx.employeeAdvancePlan.findUnique({ where: { id } });
    if (!p) throw new ApiError(404, "خطة السداد مش موجودة");
    if (p.status === "cancelled") throw new ApiError(409, "خطة السداد اتلغت بالفعل");
    const row = await tx.employeeAdvancePlan.update({ where: { id, version: p.version }, data: { status: "cancelled", cancelledBy: actor.name, cancelReason: v.reason, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "advance_plan_cancelled", entityType: "employee_transaction", entityId: p.advanceTransactionId, fieldChanged: `plan ${id}`, oldValue: p.status, newValue: "cancelled", reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}
