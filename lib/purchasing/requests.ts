import { Prisma, type PurchaseRequest } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { cancelPendingApproval, requestApproval } from "@/lib/core/approvals";
import { optText, parse, text, version } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { isoDate, money, qty, createPoInTx } from "@/lib/purchasing/orders";
import { assertQuantityFitsUnit, assessOrderStock, sellableNow, unitPrecision } from "@/lib/sales/stock-commitment";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { searchWhere } from "@/lib/core/search";

/**
 * Purchase requests (remediation 2026-11, WF-01).
 *
 * When a customer asks for more than the shelf can promise, the order goes ahead
 * without that quantity and the need becomes a purchase request instead:
 *
 *   pending_approval ─(someone else approves)→ approved ─(PO)→ ordered ─(sales order)→ fulfilled
 *          │                                       │
 *          └─(rejected)→ rejected                  └─(cancel, reasoned)→ cancelled
 *
 * Nothing here confirms a sale: the goods are received and graded through the normal
 * intake, become sellable there, and only then does "fulfil" create an ordinary sales
 * order — which reserves its stock like any other and is refused if it is not there.
 * No availability date is promised beyond the supplier's expected date on the PO.
 */

type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

const createInput = z.object({
  product_id: text("الصنف"),
  quantity: qty("الكمية"),
  uom: z.string().trim().min(1).max(20).optional(),
  customer_id: z.string().trim().min(1).optional(),
  order_id: z.string().trim().min(1).optional(),
  customer_reference: optText("مرجع العميل", 200).optional(),
  needed_by: isoDate("مطلوب قبل").optional(),
  notes: optText("ملاحظات", 1000).optional(),
});

const convertInput = z.object({
  supplier_id: text("المورد"),
  expected_date: isoDate("تاريخ التوريد المتوقع").nullable().optional(),
  unit_price: money.optional(),
  notes: optText("ملاحظات", 1000).optional(),
  expected_version: version,
});

const fulfilInput = z.object({
  delivery_date: isoDate("تاريخ التسليم"),
  delivery_time: z.string().trim().optional(),
  quantity: qty("الكمية").optional(),
  notes: optText("ملاحظات", 1000).optional(),
  expected_version: version,
});

const INCLUDE = {
  product: { select: { id: true, name: true, nameAr: true, unit: true, sku: true } },
  customer: { select: { id: true, code: true, name: true, nameAr: true } },
  order: { select: { id: true, orderNumber: true, status: true, stockStatus: true, customerPoRef: true } },
  orderItem: { select: { id: true, productName: true, unit: true, requiredQuantity: true } },
  purchaseOrder: { select: { id: true, number: true, status: true, expectedDate: true, supplier: { select: { id: true, name: true } } } },
  purchaseOrderLine: { select: { id: true, quantity: true, uomCode: true, intakes: { where: { status: "posted" }, select: { goodQty: true } } } },
  fulfilledOrder: { select: { id: true, orderNumber: true, status: true } },
} satisfies Prisma.PurchaseRequestInclude;

const audit = (tx: Tx, actor: Actorish, r: { id: string; number: string }, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "purchase_request", entityId: r.id, newValue: `${r.number} · ${detail}`, reason, source: "user", deviceId: actor.deviceId }, tx);

async function lockRequest(tx: Tx, id: string) {
  await advisoryXactLock(tx, `purchasing:request:${id}`);
  const r = await tx.purchaseRequest.findUnique({ where: { id } });
  if (!r) throw new ApiError(404, "طلب الشراء مش موجود");
  return r;
}

function assertVersion(r: PurchaseRequest, expected: number | undefined) {
  if (expected !== undefined && expected !== r.version) throw new ApiError(409, "طلب الشراء اتغيّر، حدّث الشاشة");
}

async function casUpdate(tx: Tx, r: PurchaseRequest, data: Prisma.PurchaseRequestUncheckedUpdateInput) {
  try {
    return await tx.purchaseRequest.update({ where: { id: r.id, version: r.version }, data: { ...data, version: { increment: 1 } } });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "طلب الشراء اتغيّر، حدّث الشاشة");
    throw err;
  }
}

export async function createPurchaseRequest(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.requests.create");
  const v = parse(createInput, input);
  return inTx(async (tx) => {
    const product = await tx.stockProduct.findUnique({ where: { id: v.product_id } });
    if (!product || !product.active) throw new ApiError(400, "الصنف مش موجود أو موقوف");
    const uom = v.uom ?? product.unit;
    await assertQuantityFitsUnit(tx, uom, v.quantity, `"${product.nameAr ?? product.name}"`);
    await toBaseQuantity(tx, product, v.quantity, uom); // the unit must convert to stock
    if (v.customer_id && !(await tx.customer.findUnique({ where: { id: v.customer_id }, select: { id: true } }))) throw new ApiError(400, "العميل مش موجود");
    if (v.order_id) {
      const o = await tx.order.findUnique({ where: { id: v.order_id }, select: { customerAccountId: true } });
      if (!o) throw new ApiError(400, "الأوردر مش موجود");
      if (v.customer_id && o.customerAccountId && o.customerAccountId !== v.customer_id) throw new ApiError(400, "الأوردر ده لعميل تاني");
    }
    const today = todayLocalISO();
    const created = await tx.purchaseRequest.create({
      data: {
        number: await nextDocumentNumber(tx, "purchasing.request", today),
        productId: product.id,
        uomCode: uom,
        quantity: v.quantity,
        customerId: v.customer_id ?? null,
        orderId: v.order_id ?? null,
        customerReference: v.customer_reference ?? null,
        neededBy: v.needed_by ?? null,
        notes: v.notes ?? null,
        requestedById: actor.id,
        requestedBy: actor.name,
      },
    });
    await requestApproval(tx, {
      type: "purchasing.request",
      entityId: created.id,
      title: `طلب شراء ${created.number} · ${product.nameAr ?? product.name}`,
      summary: `${v.quantity.toFixed()} ${uom}${v.customer_reference ? ` · ${v.customer_reference}` : ""}`,
      requester: { id: actor.id, name: actor.name, role: actor.role, deviceId: actor.deviceId },
    });
    await audit(tx, actor, created, "purchase_request_created", `${product.name} · ${v.quantity.toFixed()} ${uom}`);
    return tx.purchaseRequest.findUniqueOrThrow({ where: { id: created.id }, include: INCLUDE });
  });
}

/** Approval handler: decided by someone other than the requester (engine + DB rule). */
export async function applyPurchaseRequestDecision(tx: Tx, id: string, approved: boolean, decider: Actorish, comment?: string) {
  const r = await lockRequest(tx, id);
  if (r.status !== "pending_approval") return r;
  const updated = await casUpdate(tx, r, {
    status: approved ? "approved" : "rejected",
    decidedById: decider.id,
    decidedBy: decider.name,
    decidedAt: new Date(),
    decisionNote: comment?.trim() || null,
  });
  await audit(tx, decider, r, approved ? "purchase_request_approved" : "purchase_request_rejected", approved ? "موافقة" : "رفض", comment);
  return updated;
}

/** An approved request becomes one line on a new purchase order to the chosen supplier. */
export async function convertPurchaseRequest(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.orders.manage");
  const v = parse(convertInput, input);
  return inTx(async (tx) => {
    const r = await lockRequest(tx, id);
    assertVersion(r, v.expected_version);
    if (r.status !== "approved") throw new ApiError(409, r.status === "pending_approval" ? "طلب الشراء لسه مستني الموافقة" : "طلب الشراء ده مش في حالة تسمح بأمر شراء");
    const po = await createPoInTx(
      tx,
      {
        supplierId: v.supplier_id,
        expectedDate: v.expected_date ?? null,
        notes: [`من طلب الشراء ${r.number}`, v.notes].filter(Boolean).join(" · "),
        lines: [{ product_id: r.productId, quantity: r.quantity, uom: r.uomCode, ...(v.unit_price ? { unit_price: v.unit_price } : {}) }],
      },
      actor
    );
    const line = await tx.purchaseOrderLine.findFirstOrThrow({ where: { poId: po.id }, orderBy: { lineNo: "asc" } });
    await casUpdate(tx, r, { status: "ordered", purchaseOrderId: po.id, purchaseOrderLineId: line.id });
    await audit(tx, actor, r, "purchase_request_ordered", `أمر شراء ${po.number}`);
    return tx.purchaseRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  });
}

export async function cancelPurchaseRequest(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.requests.create");
  const v = parse(z.object({ reason: text("سبب الإلغاء", 500), expected_version: version }), input);
  return inTx(async (tx) => {
    const r = await lockRequest(tx, id);
    assertVersion(r, v.expected_version);
    if (!["pending_approval", "approved"].includes(r.status)) {
      throw new ApiError(409, r.status === "ordered" ? "طلب الشراء اتحول لأمر شراء — الإلغاء من أمر الشراء نفسه" : "طلب الشراء مقفول بالفعل");
    }
    if (r.status === "pending_approval") await cancelPendingApproval(tx, { type: "purchasing.request", entityId: r.id, reason: v.reason, actor });
    await casUpdate(tx, r, { status: "cancelled", cancelReason: v.reason });
    await audit(tx, actor, r, "purchase_request_cancelled", "إلغاء", v.reason);
    return tx.purchaseRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  });
}

/**
 * Back to the customer: once the goods are sellable, an ordinary sales order is created
 * for the request's customer — through createOrder, so it reserves the stock and is
 * refused like any other if the stock is not (or no longer) there.
 */
export async function fulfilPurchaseRequest(id: string, input: unknown, actor: ServiceActor & { source?: string }) {
  assertPermission(actor, "orders.create");
  const v = parse(fulfilInput, input);
  const r = await prisma.purchaseRequest.findUnique({ where: { id }, include: { product: true } });
  if (!r) throw new ApiError(404, "طلب الشراء مش موجود");
  assertVersion(r, v.expected_version);
  if (r.status !== "ordered") throw new ApiError(409, r.status === "fulfilled" ? "طلب الشراء اتنفذ بالفعل" : "طلب الشراء لسه ما اتحولش لأمر شراء");
  if (!r.customerId) throw new ApiError(409, "طلب الشراء مش مربوط بعميل — اعمل أوردر عادي");
  // A suggestion raised for a line of an order waiting for stock is served by that same order
  // (re-check and release on the order) — a second order here would sell the goods twice.
  if (r.orderItemId) throw new ApiError(409, "طلب الشراء ده لسطر في أوردر مستني بضاعة — كمّل من الأوردر نفسه (إعادة فحص المخزون والإفراج)");
  const { createOrder } = await import("@/lib/orders-service");
  const order = await createOrder(
    {
      customer_account_id: r.customerId,
      customer_name: "",
      delivery_date: v.delivery_date,
      delivery_time: v.delivery_time,
      notes: [`من طلب الشراء ${r.number}`, v.notes].filter(Boolean).join(" · "),
      items: [{ stock_product_id: r.productId, product_name: r.product.nameAr ?? r.product.name, quantity: Number(v.quantity ?? r.quantity), unit: r.uomCode }],
    },
    { ...actor, source: "manual" } as never,
    {
      afterCreate: async (tx, created) => {
        const cur = await lockRequest(tx, id);
        if (cur.status !== "ordered" || cur.version !== r.version) throw new ApiError(409, "طلب الشراء اتغيّر، حدّث الشاشة");
        await casUpdate(tx, cur, { status: "fulfilled", fulfilledOrderId: created.id });
        await audit(tx, actor, cur, "purchase_request_fulfilled", `أوردر ${created.orderNumber}`);
      },
    }
  );
  return { order, request: await prisma.purchaseRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE }) };
}

function present(r: Prisma.PurchaseRequestGetPayload<{ include: typeof INCLUDE }>, available: Prisma.Decimal | null) {
  const received = r.purchaseOrderLine ? r.purchaseOrderLine.intakes.reduce((a, i) => a.plus(i.goodQty), new Prisma.Decimal(0)) : null;
  return { ...r, quantity: r.quantity.toFixed(), requiredQty: r.requiredQty?.toFixed() ?? null, availableQty: r.availableQty?.toFixed() ?? null, receivedGood: received?.toFixed() ?? null, availableNow: available?.toFixed() ?? null };
}

export async function listPurchaseRequests(filters: { status?: string; customerId?: string; orderId?: string; limit?: number; q?: string }, actor: ServiceActor) {
  assertPermission(actor, "purchasing.requests.view");
  const rows = await prisma.purchaseRequest.findMany({
    where: { ...(filters.status ? { status: filters.status } : {}), ...(filters.customerId ? { customerId: filters.customerId } : {}), ...(filters.orderId ? { orderId: filters.orderId } : {}), ...(await searchWhere("purchaseRequest", filters.q)) },
    include: INCLUDE,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
  });
  const avail = new Map<string, Prisma.Decimal>();
  for (const id of [...new Set(rows.filter((x) => x.status === "ordered").map((x) => x.productId))]) avail.set(id, (await sellableNow(prisma, id)).available);
  return { items: rows.map((x) => present(x, avail.get(x.productId) ?? null)) };
}

export async function getPurchaseRequest(id: string, actor: ServiceActor) {
  assertPermission(actor, "purchasing.requests.view");
  const r = await prisma.purchaseRequest.findUnique({ where: { id }, include: INCLUDE });
  if (!r) throw new ApiError(404, "طلب الشراء مش موجود");
  return present(r, (await sellableNow(prisma, r.productId)).available);
}

// --- Procurement suggestions from awaiting-stock orders (Nov 2026) -------------------------
//
// An order saved "awaiting stock" gets one purchase request per short line, raised by the
// system on behalf of whoever saved the order. It is the same request as a hand-raised one —
// same approval by someone else, same conversion to a supplier PO by purchasing — and carries
// the order AND the line. The quantity is what the line still needs beyond what is already on
// a purchase order for it; re-saving or editing the line resizes the one open request instead
// of adding another (a partial unique index backs this). It is a recommendation: nothing here
// buys, reserves or moves stock.

type SuggestionActor = Actorish & { source?: string };

const OPEN_SUGGESTION = ["pending_approval", "approved"];

const suggestionAudit = (tx: Tx, actor: SuggestionActor, r: { id: string; number: string }, orderId: string, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "purchase_request", entityId: r.id, orderId, newValue: `${r.number} · ${detail}`, reason, source: actor.source === "n8n" || actor.source === "hermes" ? actor.source : actor.source === "system" ? "system" : "user", deviceId: actor.deviceId }, tx);

async function closeSuggestion(tx: Tx, r: PurchaseRequest, actor: SuggestionActor, reason: string) {
  if (r.status === "pending_approval") await cancelPendingApproval(tx, { type: "purchasing.request", entityId: r.id, reason, actor });
  await casUpdate(tx, r, { status: "cancelled", cancelReason: reason });
  await suggestionAudit(tx, actor, r, r.orderId!, "purchase_request_cancelled", "إلغاء تلقائي", reason);
}

/**
 * Brings an order's line suggestions in step with its current shortage: creates the missing
 * one, resizes an open one whose quantity changed, closes one no longer needed. Runs in the
 * caller's transaction; safe to call any number of times (idempotent). For an order that is
 * not (or no longer) awaiting stock it closes every open suggestion.
 */
export async function syncOrderSuggestions(tx: Tx, orderId: string, actor: SuggestionActor) {
  await advisoryXactLock(tx, `purchasing:order-suggestions:${orderId}`);
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, stockStatus: true, customerAccountId: true, customerPoRef: true, deliveryDate: true } });
  if (!order) return { created: 0, updated: 0, closed: 0 };
  const held = order.stockStatus === "awaiting_stock" && order.status === "new";
  const assessment = held ? await assessOrderStock(tx, orderId) : null;
  const coverage = new Map((assessment?.coverage ?? []).map((c) => [c.itemId, c]));
  const existing = await tx.purchaseRequest.findMany({ where: { orderId, orderItemId: { not: null }, status: { in: [...OPEN_SUGGESTION, "ordered"] } }, orderBy: { createdAt: "asc" } });
  const itemIds = [...new Set([...coverage.keys(), ...existing.map((e) => e.orderItemId!)])];
  let created = 0, updated = 0, closed = 0;
  for (const itemId of itemIds) {
    const c = coverage.get(itemId);
    const mine = existing.filter((e) => e.orderItemId === itemId);
    let open = mine.find((e) => OPEN_SUGGESTION.includes(e.status)) ?? null;
    // The line now names another product (a re-mapping): the old suggestion no longer fits.
    if (open && c && open.productId !== c.productId) {
      await closeSuggestion(tx, open, actor, "صنف السطر اتغيّر");
      closed++;
      open = null;
    }
    // Already on a purchase order for this line (base unit: suggestions are raised in it).
    const ordered = mine.filter((e) => e.status === "ordered" && (!c || e.productId === c.productId)).reduce((a, e) => a.plus(e.quantity), new Prisma.Decimal(0));
    let need = new Prisma.Decimal(0);
    if (c && c.shortage.gt(0)) {
      const precision = (await unitPrecision(tx, c.baseUnit)) ?? 3;
      need = Prisma.Decimal.max(0, c.shortage.minus(ordered)).toDecimalPlaces(precision, Prisma.Decimal.ROUND_UP);
    }
    if (need.lte(0)) {
      if (open) {
        await closeSuggestion(tx, open, actor, held ? "الناقص اتغطى" : "الأوردر مبقاش مستني بضاعة");
        closed++;
      }
      continue;
    }
    const sizing = { quantity: need, requiredQty: c!.requestedBase, availableQty: Prisma.Decimal.max(0, c!.available), neededBy: order.deliveryDate, customerReference: order.customerPoRef ?? null };
    if (open) {
      const same = open.quantity.equals(need) && D3(open.requiredQty).equals(sizing.requiredQty) && D3(open.availableQty).equals(sizing.availableQty) && open.neededBy === sizing.neededBy && (open.customerReference ?? null) === sizing.customerReference;
      if (same) continue;
      // A larger quantity on an approved suggestion goes back for approval: the approver
      // signed off a smaller buy. A smaller one keeps its approval.
      const reapprove = open.status === "approved" && need.gt(open.quantity);
      const next = await casUpdate(tx, open, {
        ...sizing,
        ...(reapprove ? { status: "pending_approval", decidedById: null, decidedBy: null, decidedAt: null, decisionNote: null } : {}),
      });
      if (!open.quantity.equals(need)) {
        await suggestionAudit(tx, actor, open, orderId, "purchase_request_quantity_changed", `${open.quantity.toFixed()} ← ${need.toFixed()} ${open.uomCode}`, `أوردر ${order.orderNumber}`);
      }
      if (reapprove) {
        const product = await tx.stockProduct.findUniqueOrThrow({ where: { id: open.productId }, select: { name: true, nameAr: true } });
        await requestApproval(tx, {
          type: "purchasing.request",
          entityId: next.id,
          title: `طلب شراء ${next.number} · ${product.nameAr ?? product.name}`,
          summary: `${need.toFixed()} ${next.uomCode} · أوردر ${order.orderNumber}${order.customerPoRef ? ` · ${order.customerPoRef}` : ""}`,
          requester: { id: next.requestedById, name: next.requestedBy, role: actor.role, deviceId: actor.deviceId },
        });
      }
      updated++;
      continue;
    }
    const product = await tx.stockProduct.findUniqueOrThrow({ where: { id: c!.productId }, select: { id: true, name: true, nameAr: true, unit: true } });
    const r = await tx.purchaseRequest.create({
      data: {
        number: await nextDocumentNumber(tx, "purchasing.request", todayLocalISO()),
        productId: product.id,
        uomCode: product.unit,
        ...sizing,
        customerId: order.customerAccountId,
        orderId,
        orderItemId: itemId,
        notes: `ناقص في أوردر ${order.orderNumber} (سطر ${c!.line})`,
        requestedById: actor.id,
        requestedBy: actor.name,
      },
    });
    await requestApproval(tx, {
      type: "purchasing.request",
      entityId: r.id,
      title: `طلب شراء ${r.number} · ${product.nameAr ?? product.name}`,
      summary: `${need.toFixed()} ${product.unit} · أوردر ${order.orderNumber}${order.customerPoRef ? ` · ${order.customerPoRef}` : ""}`,
      requester: { id: actor.id, name: actor.name, role: actor.role, deviceId: actor.deviceId },
    });
    await suggestionAudit(tx, actor, r, orderId, "purchase_request_created", `${product.name} · ${need.toFixed()} ${product.unit} · أوردر ${order.orderNumber}`);
    created++;
  }
  return { created, updated, closed };
}

/**
 * The order is done with its suggestions: cancelled (open ones are cancelled; one already on
 * a supplier PO stays with purchasing — the PO is theirs to keep or cancel — and is noted), or
 * released with every line reserved (open ones are cancelled as covered; one on a PO is
 * fulfilled by this order).
 */
export async function settleOrderSuggestions(tx: Tx, orderId: string, outcome: "cancelled" | "released", reason: string, actor: SuggestionActor) {
  await advisoryXactLock(tx, `purchasing:order-suggestions:${orderId}`);
  const rows = await tx.purchaseRequest.findMany({ where: { orderId, orderItemId: { not: null }, status: { in: [...OPEN_SUGGESTION, "ordered"] } }, orderBy: { createdAt: "asc" } });
  const order = rows.length ? await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNumber: true } }) : null;
  for (const r of rows) {
    if (OPEN_SUGGESTION.includes(r.status)) {
      await closeSuggestion(tx, r, actor, outcome === "cancelled" ? `الأوردر اتلغى: ${reason}` : `البضاعة اتوفرت والأوردر اتفرج عنه`);
    } else if (outcome === "released") {
      await casUpdate(tx, r, { status: "fulfilled", fulfilledOrderId: orderId });
      await suggestionAudit(tx, actor, r, orderId, "purchase_request_fulfilled", `أوردر ${order!.orderNumber}`);
    } else {
      await suggestionAudit(tx, actor, r, orderId, "purchase_request_origin_cancelled", `أوردر ${order!.orderNumber}`, reason);
    }
  }
  return rows.length;
}

/** The order's line suggestions, as its screen shows them (purchasing.requests.view). */
export async function orderSuggestions(orderId: string) {
  const rows = await prisma.purchaseRequest.findMany({ where: { orderId, orderItemId: { not: null } }, include: INCLUDE, orderBy: { createdAt: "asc" } });
  return rows.map((r) => present(r, null));
}

function D3(v: Prisma.Decimal | null) {
  return v ?? new Prisma.Decimal(-1);
}
