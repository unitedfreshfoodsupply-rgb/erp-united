import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { advisoryXactLock } from "@/lib/dbLock";
import type { Tx } from "@/lib/tx";
import { notify } from "@/lib/core/notifications";
import { cancelPendingApproval, findPending, requestApproval } from "@/lib/core/approvals";
import { valueOfItems } from "@/lib/sales/pricing";
import { customerReceivable } from "@/lib/sales/invoicing";

/**
 * Credit control.
 *
 * Applies to CREDIT customers (payment terms > 0) and to anyone on credit hold. A
 * cash customer pays on delivery and has no exposure to control; an order whose
 * customer is not mapped yet cannot be judged and is marked not applicable (the
 * mapping queue is where that gets fixed).
 *
 * Exposure = the value of the customer's orders not yet invoiced (in work, or left
 * without an issued invoice) + its receivable balance (issued invoices − credit
 * notes; payments are deducted from Phase 6).
 *
 * The policy is a setting: off | warn | block. Under "block" an order that fails the
 * check gets a "sales.credit" approval request and cannot start preparation until
 * finance approves it; under "warn" it proceeds and finance is notified.
 */

export type CreditMode = "off" | "warn" | "block";
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

/** Receivable balance: issued invoices − credit notes (payments arrive in Phase 6). */
async function receivableBalance(tx: Parameters<typeof customerReceivable>[0], customerId: string): Promise<Prisma.Decimal> {
  return customerReceivable(tx, customerId);
}

/** What customerExposure reads: a transaction, or the client itself for a read-only screen. */
type ExposureDb = Pick<Tx, "orderItem"> & Parameters<typeof customerReceivable>[0];

export async function customerExposure(tx: ExposureDb, customerId: string) {
  // Not yet a receivable: orders still in work, and orders that left but have no
  // issued invoice yet (their value is owed all the same). Every such order's lines are read
  // at once and valued per order exactly as orderValue does (PS-3, Nov 2026: it was two
  // queries per open order, inside the credit check of every create and edit).
  const lines = await tx.orderItem.findMany({
    where: {
      order: {
        customerAccountId: customerId,
        status: { not: "cancelled" },
        OR: [{ status: { not: "dispatched" } }, { invoices: { none: { status: "issued" } } }],
      },
    },
    select: { orderId: true, requiredQuantity: true, preparedQuantity: true, loadedQuantity: true, price: true },
  });
  const byOrder = new Map<string, typeof lines>();
  for (const l of lines) byOrder.set(l.orderId, [...(byOrder.get(l.orderId) ?? []), l]);
  let openValue = new Prisma.Decimal(0);
  let unpriced = 0;
  for (const items of byOrder.values()) {
    const v = valueOfItems(items);
    openValue = openValue.plus(v.total);
    unpriced += v.unpriced;
  }
  const receivable = await receivableBalance(tx, customerId);
  return { openOrders: openValue, receivable, exposure: openValue.plus(receivable), unpricedLines: unpriced };
}

/** `note` carries the figures and reasons (finance only: approval, notification,
 * audit). `headline` is what the ORDER carries — every floor role reads orders, so it
 * says what state the credit is in, never amounts or why a customer is on hold. */
type Verdict = { status: "not_applicable" | "ok" | "fail"; headline: string; note: string; exposure?: Prisma.Decimal; limit?: Prisma.Decimal | null };

async function judge(tx: Tx, orderId: string): Promise<Verdict> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { customerAccount: true } });
  const c = order.customerAccount;
  if (!c) return { status: "not_applicable", headline: "العميل مش مربوط بحساب", note: "العميل مش مربوط بحساب" };
  if (c.creditHold) return { status: "fail", headline: "العميل موقوف آجل", note: `العميل موقوف آجل: ${c.creditHoldReason ?? ""}` };
  if (c.paymentTermsDays === 0) return { status: "not_applicable", headline: "عميل كاش", note: "عميل كاش" };
  if (c.creditLimit === null) return { status: "fail", headline: "من غير حد ائتمان", note: "عميل آجل من غير حد ائتمان متحدد" };
  const e = await customerExposure(tx, c.id);
  if (e.exposure.greaterThan(c.creditLimit)) {
    return { status: "fail", headline: "تجاوز حد الائتمان", note: `المديونية + الأوردرات المفتوحة ${e.exposure.toFixed(2)} أكبر من الحد ${c.creditLimit.toFixed(2)}`, exposure: e.exposure, limit: c.creditLimit };
  }
  return { status: "ok", headline: "في حدود الائتمان", note: `${e.exposure.toFixed(2)} من ${c.creditLimit.toFixed(2)}`, exposure: e.exposure, limit: c.creditLimit };
}

/** Credit requests are raised by the control itself, not by whoever happened to move
 * the order (often a preparer, who must not find finance figures in their inbox). */
const CREDIT_CONTROL = { id: null, name: "رقابة الائتمان", role: "SYSTEM" };

/**
 * Evaluates an order and records the outcome on it (in the caller's transaction).
 * An order finance already approved stays approved; one finance rejected stays
 * rejected until re-evaluation finds it within limits.
 */
export async function evaluateOrderCredit(tx: Tx, orderId: string, mode: CreditMode, actor: Actorish) {
  if (mode === "off") return null;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status === "cancelled" || order.status === "dispatched") return order.creditStatus;
  if (order.creditStatus === "approved") return "approved";
  // One evaluation at a time per customer: two orders for the same customer must not
  // each see the other's value as "not yet there".
  if (order.customerAccountId) await advisoryXactLock(tx, `sales:credit:${order.customerAccountId}`);
  const v = await judge(tx, orderId);
  let status: string;
  if (v.status !== "fail") {
    status = v.status;
    const pending = await findPending(tx, "sales.credit", orderId);
    if (pending) await cancelPendingApproval(tx, { type: "sales.credit", entityId: orderId, reason: "الأوردر بقى في حدود الائتمان", actor: CREDIT_CONTROL });
  } else if (mode === "warn") {
    status = "warning";
    await notify(
      tx,
      { permission: "sales.credit.manage" },
      {
        type: "sales.credit_warning",
        severity: "warning",
        title: `أوردر ${order.orderNumber} لعميل عدّى حدود الائتمان`,
        body: v.note,
        entityType: "order",
        entityId: orderId,
        link: `/orders/${orderId}`,
        dedupeKey: `credit-warning:${orderId}`,
      }
    );
  } else {
    status = "pending_approval";
    await requestApproval(tx, {
      type: "sales.credit",
      entityId: orderId,
      title: `ائتمان أوردر ${order.orderNumber} · ${order.customerName}`,
      summary: v.note,
      amount: v.exposure ?? null,
      reason: v.note,
      requester: CREDIT_CONTROL,
    });
  }
  if (status !== order.creditStatus || v.headline !== order.creditNote) {
    await tx.order.update({ where: { id: orderId }, data: { creditStatus: status, creditNote: v.headline } });
    // The audit trail records outcomes someone must act on (or that ended one):
    // a first "nothing to check" / "within limits" is the normal case, not an event.
    const quiet = (s: string | null) => s === null || s === "not_applicable" || s === "ok";
    if (quiet(status) && quiet(order.creditStatus)) return status;
    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "order_credit_evaluated",
        entityType: "order",
        entityId: orderId,
        orderId,
        fieldChanged: "creditStatus",
        oldValue: order.creditStatus,
        newValue: status,
        reason: v.note,
        source: "system",
        deviceId: actor.deviceId,
      },
      tx
    );
  }
  return status;
}

/** The floor gate: may this order start preparation? */
export async function assertCreditCleared(tx: Tx, orderId: string, mode: CreditMode, actor: Actorish) {
  if (mode !== "block") {
    await evaluateOrderCredit(tx, orderId, mode, actor);
    return;
  }
  const status = await evaluateOrderCredit(tx, orderId, mode, actor);
  if (status === "pending_approval") throw new ApiError(409, "الأوردر مستني موافقة الحسابات على الائتمان قبل التجهيز");
  if (status === "rejected") throw new ApiError(409, "الحسابات رفضت ائتمان الأوردر ده");
}

/** Approval handlers (see lib/core/approval-handlers.ts). */
export async function applyCreditDecision(tx: Tx, orderId: string, approved: boolean, decider: Actorish, comment?: string) {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, "الأوردر مش موجود");
  const status = approved ? "approved" : "rejected";
  // The decision's comment stays on the approval and in the (permission-filtered)
  // audit; the order only says what was decided.
  await tx.order.update({ where: { id: orderId }, data: { creditStatus: status, creditNote: approved ? "الحسابات وافقت" : "الحسابات رفضت" } });
  await writeAudit(
    {
      userId: decider.id,
      userName: decider.name,
      role: decider.role,
      action: approved ? "order_credit_approved" : "order_credit_rejected",
      entityType: "order",
      entityId: orderId,
      orderId,
      fieldChanged: "creditStatus",
      oldValue: order.creditStatus,
      newValue: status,
      reason: comment,
      source: "user",
      deviceId: decider.deviceId,
    },
    tx
  );
}
