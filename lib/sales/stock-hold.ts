import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { assertPermission, actorCan } from "@/lib/authz-core";
import { notifyMany, usersWithPermission } from "@/lib/core/notifications";
import type { ServiceActor } from "@/lib/core/actor";
import { assessOrderStock, assessOrdersStock, commitOrderStock, REASON_AR, StockUnavailableError, type StockShortfall } from "@/lib/sales/stock-commitment";
import { orderSuggestions, settleOrderSuggestions, syncOrderSuggestions } from "@/lib/purchasing/requests";

/**
 * Orders waiting for stock (Nov 2026).
 *
 * WF-01 refuses an order whose lines the shelf cannot cover. A customer's PO is not lost
 * that way any more: the person entering it may choose "save as awaiting stock"
 * (allow_shortage). The order is then saved as it was asked — lines, prices, PO reference,
 * delivery — but:
 *
 *  - it reserves NOTHING (not even its fully available lines): a held order is not a
 *    confirmed sale and must not lock stock other orders could ship today;
 *  - it cannot leave "new" and is kept off the floor boards, the picking sheet and trip
 *    planning until it is released;
 *  - each short line raises one procurement suggestion (a purchase request linked to the
 *    order and the line), kept in step when the line changes;
 *  - when sellable stock arrives, the order's coverage is re-read and its people are told
 *    once per change — nothing is reserved or moved automatically;
 *  - "re-check stock and release" runs the ordinary commitOrderStock: every line reserved in
 *    full and the order continues the normal workflow, or nothing changes and the current
 *    shortages come back.
 *
 * Only a plain shortage can be held. A line that is unmapped, in a unit the product does not
 * carry, or of the wrong precision is still refused — those are data errors, not stock.
 */

export type HoldActor = { id: string | null; name: string; role: string; deviceId?: string; source?: string; permissions?: readonly string[] };

const auditSource = (a: HoldActor) => (a.source === "n8n" || a.source === "hermes" || a.source === "system" ? a.source : "user");

/** True when every shortfall is a plain lack of stock (the only kind an order may wait on). */
export function holdable(err: unknown): err is StockUnavailableError {
  return err instanceof StockUnavailableError && err.shortfalls.length > 0 && err.shortfalls.every((s) => s.reason === "insufficient");
}

function shortfallSummary(shortfalls: StockShortfall[]) {
  return shortfalls
    .map((s) => `${s.productName}: المطلوب ${s.requested} ${s.unit}، المتاح ${s.available}${s.unit === (s.baseUnit ?? s.unit) ? ` ${s.unit}` : ""}، الناقص ${s.shortage ?? "?"} ${s.baseUnit ?? s.unit}`)
    .join(" · ");
}

/**
 * Inside the creating transaction: the order (just created, nothing reserved) waits for stock.
 * Records the per-line shortfalls on the order's timeline and raises the line suggestions.
 */
export async function holdOrderForStockInTx(tx: Tx, orderId: string, shortfalls: StockShortfall[], actor: HoldActor) {
  await advisoryXactLock(tx, `order-stock:${orderId}`);
  const order = await tx.order.update({ where: { id: orderId }, data: { stockStatus: "awaiting_stock" } });
  // A purchase request raised by hand for this customer's short product, for this delivery day,
  // already covers the shortage (LOG-4, Nov 2026): holding the order would raise a second one for
  // the same line, and fulfilling the first would then create a second order — double buying and
  // a duplicate delivery. Refused (the order is not saved) with the request named.
  const short = [...new Set(shortfalls.map((s) => s.productId).filter((x): x is string => !!x))];
  if (order.customerAccountId && short.length) {
    const raised = await tx.purchaseRequest.findMany({
      where: { orderId: null, customerId: order.customerAccountId, neededBy: order.deliveryDate, productId: { in: short }, status: { in: ["pending_approval", "approved", "ordered"] } },
      select: { number: true, productId: true },
      orderBy: { createdAt: "asc" },
    });
    if (raised.length) {
      throw new ApiError(
        409,
        `مينفعش يتحفظ مستني بضاعة: طلب الشراء ${raised.map((r) => r.number).join("، ")} اتعمل بالفعل للعميل ده لنفس يوم التسليم وبيغطي الناقص — قلّل السطر للمتاح واحفظ عادي`,
        "purchase_request_exists",
        { requests: raised }
      );
    }
  }
  await writeAudit({
    userId: actor.id, userName: actor.name, role: actor.role,
    action: "order_held_for_stock", entityType: "order", entityId: orderId, orderId,
    fieldChanged: "stockStatus", oldValue: "ok", newValue: shortfallSummary(shortfalls),
    reason: "اتحفظ مستني بضاعة — مفيش أي كمية محجوزة لحد الإفراج", source: auditSource(actor), deviceId: actor.deviceId,
  }, tx);
  await syncOrderSuggestions(tx, orderId, actor);
}

/** The per-line picture of an order's stock, read-only (no lock, no reservation). */
export async function orderStockView(orderId: string, actor: HoldActor & { permissions: readonly string[] }) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, stockStatus: true, version: true } });
  if (!order) throw new ApiError(404, "الأوردر مش موجود");
  const a = await assessOrderStock(prisma, orderId);
  const lines = (a?.coverage ?? []).map((c) => ({
    itemId: c.itemId,
    line: c.line,
    productName: c.productName,
    unit: c.unit,
    baseUnit: c.baseUnit,
    requested: c.requested.toFixed(),
    requestedBase: c.requestedBase.toFixed(),
    available: c.available.toFixed(),
    covered: c.requestedBase.minus(c.shortage).toFixed(),
    shortage: c.shortage.toFixed(),
  }));
  return {
    stockStatus: order.stockStatus,
    status: order.status,
    version: order.version,
    lines,
    // What commitOrderStock would refuse with now; empty = a release would succeed.
    shortfalls: a?.shortfalls ?? [],
    releasable: order.stockStatus === "awaiting_stock" && order.status === "new" && !!a && a.shortfalls.length === 0,
    // The purchasing side is shown only to whoever may see purchase requests (server-side).
    suggestions: actorCan(actor, "purchasing.requests.view") ? await orderSuggestions(orderId) : null,
  };
}

/**
 * Re-check stock and release: reserves every line in full (the ordinary commitOrderStock,
 * under its locks) and the order continues the normal workflow — or nothing is written and
 * the current shortages come back (409 stock_unavailable). Lines, prices, PO reference,
 * delivery and history stay exactly as they are.
 */
export async function releaseHeldOrder(orderId: string, actor: HoldActor & { permissions: readonly string[] }, opts: { expectedVersion?: number; reason?: string } = {}) {
  assertPermission(actor, "orders.edit", "بس اللي يقدر يعدّل الأوردر يقدر يفرج عنه");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `order-stock:${orderId}`);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "الأوردر مش موجود");
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== order.version) {
      throw new ApiError(409, `الأوردر اتغيّر من واحد تاني، حدّث الشاشة وحاول تاني (نسخة الطلب: ${order.version})`);
    }
    if (order.stockStatus !== "awaiting_stock") throw new ApiError(409, "الأوردر مش مستني بضاعة");
    if (order.status !== "new") throw new ApiError(409, "الأوردر مش في مرحلة جديد");
    // Throws StockUnavailableError (409, every current shortfall) with nothing written.
    await commitOrderStock(tx, orderId, actor as unknown as ServiceActor);
    const res = await tx.order.updateMany({ where: { id: orderId, version: order.version, stockStatus: "awaiting_stock" }, data: { stockStatus: "ok", version: { increment: 1 } } });
    if (res.count !== 1) throw new ApiError(409, `الأوردر اتغيّر من واحد تاني، حدّث الشاشة وحاول تاني (نسخة الطلب: ${order.version})`);
    await writeAudit({
      userId: actor.id, userName: actor.name, role: actor.role,
      action: "order_stock_released", entityType: "order", entityId: orderId, orderId,
      fieldChanged: "stockStatus", oldValue: "awaiting_stock", newValue: "ok",
      reason: opts.reason?.trim() || "البضاعة اتوفرت — كل السطور اتحجزت", source: auditSource(actor), deviceId: actor.deviceId,
    }, tx);
    await settleOrderSuggestions(tx, orderId, "released", "", actor);
    return tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { include: { stockProduct: { select: { name: true, nameAr: true } } } }, customerAccount: { select: { name: true, nameAr: true, code: true } } },
    });
  });
}

/**
 * The awaiting-stock check. Run at the end of every transaction that raised the sellable
 * availability of these products (lib/inventory/availability-changes.ts: a receipt or an upward
 * correction, grading after receipt, opening stock, a quarantine or hold release, a return, a
 * released reservation), inside it — and once more after commit when orders were waiting (see
 * availability-changes). Re-reads the coverage of EVERY order waiting for them and
 * tells the order's creator and whoever may release it — once per change: a line newly covered,
 * or the whole order releasable — with what is still missing. Reserves, moves and buys nothing:
 * the release is "re-check and release" (releaseHeldOrder), procurement stays with the suggestions.
 *
 * A fixed number of queries whatever the number of orders (release gate D-3, Nov 2026): it used
 * to read each order on its own, a dozen round trips each, inside the receipt — past ~150
 * waiting orders a receipt on the remote database ran out of time, and orders after the 200th
 * were never told at all.
 */
export async function noteStockArrival(tx: Tx, productIds: (string | null | undefined)[], actor: HoldActor): Promise<{ held: number; sent: number }> {
  const ids = [...new Set(productIds.filter((x): x is string => !!x))];
  if (!ids.length) return { held: 0, sent: 0 };
  const held = await tx.order.findMany({
    where: { stockStatus: "awaiting_stock", status: "new", items: { some: { stockProductId: { in: ids } } } },
    select: { id: true, orderNumber: true, customerName: true, assignedToId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!held.length) return { held: 0, sent: 0 };
  const orderIds = held.map((o) => o.id);
  const [assessed, raised, created, editors] = await Promise.all([
    assessOrdersStock(tx, orderIds),
    tx.purchaseRequest.findMany({ where: { orderId: { in: orderIds }, orderItemId: { not: null } }, select: { orderId: true, orderItemId: true } }),
    tx.auditLog.findMany({ where: { orderId: { in: orderIds }, action: "order_created" }, select: { orderId: true, userId: true }, orderBy: { timestamp: "asc" } }),
    usersWithPermission(tx, "orders.edit"),
  ]);
  // Lines that were short when saved carry a suggestion; "covered" counts only those.
  const shortLinesOf = new Map<string, Set<string>>();
  for (const r of raised) shortLinesOf.set(r.orderId!, (shortLinesOf.get(r.orderId!) ?? new Set()).add(r.orderItemId!));
  const creatorOf = new Map<string, string | null>();
  for (const c of created) if (!creatorOf.has(c.orderId!)) creatorOf.set(c.orderId!, c.userId);

  const events: Parameters<typeof notifyMany>[1] = [];
  for (const o of held) {
    const a = assessed.get(o.id);
    if (!a) continue;
    const shortLines = shortLinesOf.get(o.id) ?? new Set<string>();
    const covered = a.coverage.filter((c) => shortLines.has(c.itemId) && c.shortage.lte(0)).map((c) => c.itemId).sort();
    const ready = a.shortfalls.length === 0;
    if (!ready && covered.length === 0) continue;
    const state = ready ? "ready" : `partial:${createHash("sha1").update(covered.join(",")).digest("hex").slice(0, 16)}`;
    // Everything that still stops the release: a quantity short, or a line that cannot be reserved at all.
    const stillShort = a.shortfalls.slice(0, 3).map((f) => (f.reason === "insufficient" ? `${f.productName} ${f.shortage} ${f.baseUnit ?? f.unit}` : `${f.productName} (${REASON_AR[f.reason]})`)).join("، ") + (a.shortfalls.length > 3 ? ` (+${a.shortfalls.length - 3})` : "");
    const userIds = [creatorOf.get(o.id), o.assignedToId, ...editors].filter((x): x is string => !!x && x !== actor.id);
    if (!userIds.length) continue;
    events.push({
      userIds,
      n: {
        type: ready ? "order.stock_ready" : "order.stock_partial",
        severity: ready ? "warning" : "info",
        title: ready ? `البضاعة اتوفرت لأوردر ${o.orderNumber} — اعمل إعادة فحص وإفراج` : `وصلت بضاعة لجزء من أوردر ${o.orderNumber}`,
        body: ready ? `${o.customerName} · كل السطور متغطية` : `${o.customerName} · ${covered.length} من ${shortLines.size} سطر ناقص اتغطى · لسه ناقص: ${stillShort}`,
        entityType: "order",
        entityId: o.id,
        link: `/orders/${o.id}`,
        dedupeKey: `order-stock:${o.id}:${state}`,
      },
    });
  }
  return { held: held.length, sent: await notifyMany(tx, events) };
}
