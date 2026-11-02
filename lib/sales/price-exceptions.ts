import { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/tx";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { getSetting } from "@/lib/core/settings-service";
import { cancelPendingApproval, findPending, requestApproval } from "@/lib/core/approvals";
import { productValuation } from "@/lib/inventory/ledger";
import { toBaseQuantity } from "@/lib/inventory/packaging";

/**
 * Price exceptions on an order (remediation 2026-11).
 *
 * A line is an exception when its discount is above sales.max_discount_pct, or when
 * its net unit price — per base unit, after discount — is below the product's current
 * average stock cost. With sales.price_exception_approval on (default), an order with
 * any exception has pricingStatus "pending_approval" and cannot start preparation or be
 * invoiced until someone other than the pricer approves (sales.price_exception).
 * Re-evaluated whenever prices change; a clean re-evaluation clears the hold and
 * withdraws an open request. A product with no stock cost yet is not judged on cost.
 */

type Actorish = { id: string | null; name: string; role: string; deviceId?: string };
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export type PriceException = { itemId: string; productName: string; kind: "discount" | "below_cost"; detail: string };

export async function priceExceptions(tx: Tx, orderId: string): Promise<PriceException[]> {
  const maxDiscount = D(await getSetting("sales.max_discount_pct"));
  const items = await tx.orderItem.findMany({ where: { orderId }, include: { price: true, stockProduct: true }, orderBy: { createdAt: "asc" } });
  const out: PriceException[] = [];
  for (const i of items) {
    const p = i.price;
    if (!p) continue;
    const name = i.stockProduct?.nameAr ?? i.stockProduct?.name ?? i.productName;
    if (D(p.discountPct).gt(maxDiscount)) {
      out.push({ itemId: i.id, productName: name, kind: "discount", detail: `خصم ${D(p.discountPct).toFixed()}% أكبر من الحد ${maxDiscount.toFixed()}%` });
    }
    if (!i.stockProduct || !i.stockProduct.stockTracked) continue;
    const val = await productValuation(tx, i.stockProduct.id);
    if (!val.qty.gt(0) || !val.value.gt(0)) continue; // no cost on the books yet
    const avgCost = val.value.dividedBy(val.qty);
    let perBase: Prisma.Decimal;
    try {
      perBase = await toBaseQuantity(tx, i.stockProduct, D(1), i.unit);
    } catch (err) {
      if (err instanceof ApiError) continue; // an unconvertible unit is refused elsewhere
      throw err;
    }
    if (!perBase.gt(0)) continue;
    const netPerBase = D(p.unitPrice).times(D(100).minus(D(p.discountPct))).dividedBy(100).dividedBy(perBase);
    if (netPerBase.lessThan(avgCost)) {
      out.push({ itemId: i.id, productName: name, kind: "below_cost", detail: `صافي ${netPerBase.toFixed(2)} لكل ${i.stockProduct.unit} أقل من التكلفة ${avgCost.toFixed(2)}` });
    }
  }
  return out;
}

/** Re-judges the order's prices and sets or clears the approval hold accordingly. */
export async function evaluateOrderPricing(tx: Tx, orderId: string, actor: Actorish) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, customerName: true, pricingStatus: true, status: true } });
  if (!order || order.status === "cancelled") return { status: "ok" as const, exceptions: [] };
  const enabled = await getSetting("sales.price_exception_approval");
  const exceptions = enabled ? await priceExceptions(tx, orderId) : [];
  const pending = await findPending(tx, "sales.price_exception", orderId);
  if (!exceptions.length) {
    if (pending) await cancelPendingApproval(tx, { type: "sales.price_exception", entityId: orderId, reason: "الأسعار اتعدلت ومبقاش فيها استثناء", actor });
    if (order.pricingStatus !== "ok") await tx.order.update({ where: { id: orderId }, data: { pricingStatus: "ok" } });
    return { status: "ok" as const, exceptions };
  }
  // A changed set of exceptions needs a fresh decision: withdraw the old request.
  if (pending) await cancelPendingApproval(tx, { type: "sales.price_exception", entityId: orderId, reason: "الأسعار اتعدلت — طلب موافقة جديد", actor });
  await requestApproval(tx, {
    type: "sales.price_exception",
    entityId: orderId,
    title: `اعتماد أسعار أوردر ${order.orderNumber ?? ""} · ${order.customerName}`,
    summary: exceptions.map((e) => `${e.productName}: ${e.detail}`).join(" · "),
    payload: { exceptions },
    requester: { id: actor.id, name: actor.name, role: actor.role, deviceId: actor.deviceId },
  });
  if (order.pricingStatus !== "pending_approval") await tx.order.update({ where: { id: orderId }, data: { pricingStatus: "pending_approval" } });
  await writeAudit(
    { userId: actor.id, userName: actor.name, role: actor.role, action: "order_price_exception", entityType: "order", entityId: orderId, orderId, newValue: exceptions.map((e) => `${e.productName}: ${e.detail}`).join(" · "), source: "user", deviceId: actor.deviceId },
    tx
  );
  return { status: "pending_approval" as const, exceptions };
}

/** Approval handler (decided by someone else — engine rule). */
export async function applyPriceExceptionDecision(tx: Tx, orderId: string, approved: boolean, decider: Actorish, comment?: string) {
  await tx.order.update({ where: { id: orderId }, data: { pricingStatus: approved ? "ok" : "rejected" } });
  await writeAudit(
    { userId: decider.id, userName: decider.name, role: decider.role, action: approved ? "order_price_exception_approved" : "order_price_exception_rejected", entityType: "order", entityId: orderId, orderId, reason: comment, source: "user", deviceId: decider.deviceId },
    tx
  );
}

/** Refuses a step that needs approved prices. */
export function assertPricingCleared(order: { pricingStatus: string }, what: string) {
  if (order.pricingStatus === "pending_approval") throw new ApiError(409, `${what}: أسعار الأوردر مستنية موافقة (سعر أقل من التكلفة أو خصم فوق الحد)`, "pricing_pending");
  if (order.pricingStatus === "rejected") throw new ApiError(409, `${what}: أسعار الأوردر اترفضت — عدّل السعر الأول`, "pricing_rejected");
}
