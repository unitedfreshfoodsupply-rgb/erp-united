import { Prisma, type PurchaseRequest } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany, type AuditInput } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock, advisoryXactLocks } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber, nextDocumentNumbers } from "@/lib/core/sequences";
import { newId } from "@/lib/core/ids";
import { cancelPendingApproval, cancelPendingApprovals, requestApproval, requestApprovals } from "@/lib/core/approvals";
import { optText, parse, text, version } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { isoDate, money, qty, createPoInTx } from "@/lib/purchasing/orders";
import { assertQuantityFitsUnit, assessOrderStock, sellableNow } from "@/lib/sales/stock-commitment";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { searchWhere } from "@/lib/core/search";
import { resolveWarehouse } from "@/lib/inventory/context";

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

/** casUpdate of several requests with the same change, in one statement (each at the version it was read). */
async function casUpdateMany(tx: Tx, rows: PurchaseRequest[], data: Prisma.PurchaseRequestUncheckedUpdateManyInput) {
  if (!rows.length) return;
  const res = await tx.purchaseRequest.updateMany({ where: { OR: rows.map((r) => ({ id: r.id, version: r.version })) }, data: { ...data, version: { increment: 1 } } });
  if (res.count !== rows.length) throw new ApiError(409, "طلب الشراء اتغيّر، حدّث الشاشة");
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
    } else if (v.customer_id) {
      // The same request twice (a double tap on the order form, LOG-4): while the first is still
      // waiting for approval, an identical one is refused with its number — buying twice.
      await advisoryXactLock(tx, `purchasing:customer-request:${v.customer_id}:${product.id}`);
      const same = await tx.purchaseRequest.findFirst({
        where: { orderId: null, customerId: v.customer_id, productId: product.id, uomCode: uom, quantity: v.quantity, neededBy: v.needed_by ?? null, customerReference: v.customer_reference ?? null, status: "pending_approval" },
        select: { number: true },
      });
      if (same) throw new ApiError(409, `طلب الشراء ${same.number} بنفس الصنف والكمية للعميل ده اتعمل بالفعل ومستني الموافقة`, "purchase_request_exists");
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
//
// "On a purchase order" means still to come from it (release gate D-1, Nov 2026): what a LIVE PO
// line has yet to deliver (ordered − accepted), plus what it delivered that is still held in
// quarantine (a grading loss waiting for approval — it is in the house, not yet sellable). It used
// to be the full quantity of every converted request, whatever became of its PO — a closed PO,
// a rejected delivery or a short one kept "covering" the line, and the order waited with no
// suggestion open.

type SuggestionActor = Actorish & { source?: string };

const OPEN_SUGGESTION = ["pending_approval", "approved"];
const PO_DONE = ["cancelled", "closed"];

/**
 * What each converted ("ordered") request still brings to its line, base unit, by request id:
 *  - its PO line's outstanding quantity (ordered − accepted over posted receipts, every grade —
 *    the PO's own receiving rule) while the PO is live, nothing once it is cancelled or closed;
 *  - plus what that line delivered of the product that is still in quarantine (its receipts'
 *    lots), whatever the PO's state: held for a grading-loss approval, it is not sellable yet but
 *    it is not to be bought again either. When it leaves quarantine — released or written off —
 *    the line is re-sized (syncSuggestionsForLots).
 * What a line delivered and released is stock now (or graded out of it), not "on order".
 */
export async function stillOnOrder(tx: Tx, rows: PurchaseRequest[]): Promise<Map<string, Prisma.Decimal>> {
  const ordered = rows.filter((r) => r.status === "ordered");
  const out = new Map<string, Prisma.Decimal>();
  if (!ordered.length) return out;
  const lineIds = ordered.map((r) => r.purchaseOrderLineId).filter((x): x is string => !!x);
  const poIds = ordered.map((r) => r.purchaseOrderId).filter((x): x is string => !!x);
  const [pos, lines, receipts, lots, quarantines] = await Promise.all([
    tx.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, status: true } }),
    tx.purchaseOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, productId: true, baseQuantity: true } }),
    tx.stockIntake.groupBy({ by: ["purchaseOrderLineId"], where: { status: "posted", purchaseOrderLineId: { in: lineIds } }, _sum: { receivedQty: true, rejectedQty: true } }),
    // A lot past its expiry will never be sold: it is not "coming" either.
    tx.stockIntake.findMany({ where: { status: "posted", purchaseOrderLineId: { in: lineIds }, lot: { OR: [{ expiryDate: null }, { expiryDate: { gte: todayLocalISO() } }] } }, select: { purchaseOrderLineId: true, lotId: true } }),
    // The warehouse whose stock the order lines are judged against.
    resolveWarehouse(tx, undefined).then((wh) => tx.storageLocation.findMany({ where: { type: "quarantine", warehouseId: wh.id }, select: { id: true } })),
  ]);
  const zero = new Prisma.Decimal(0);
  const lineBy = new Map(lines.map((l) => [l.id, l]));
  const heldByLine = new Map<string, Prisma.Decimal>();
  if (lots.length && quarantines.length) {
    const held = await tx.stockMovement.groupBy({ by: ["lotId", "productId"], where: { lotId: { in: [...new Set(lots.map((l) => l.lotId!))] }, locationId: { in: quarantines.map((q) => q.id) } }, _sum: { quantity: true } });
    const heldBy = new Map(held.map((h) => [`${h.lotId}|${h.productId}`, new Prisma.Decimal(h._sum.quantity ?? 0)]));
    for (const lineId of new Set(lots.map((l) => l.purchaseOrderLineId!))) {
      const productId = lineBy.get(lineId)?.productId;
      const lotIds = new Set(lots.filter((l) => l.purchaseOrderLineId === lineId).map((l) => l.lotId!));
      heldByLine.set(lineId, [...lotIds].reduce((a, lot) => a.plus(Prisma.Decimal.max(zero, heldBy.get(`${lot}|${productId}`) ?? zero)), zero));
    }
  }
  const poStatus = new Map(pos.map((p) => [p.id, p.status]));
  const accepted = new Map(receipts.map((g) => [g.purchaseOrderLineId!, new Prisma.Decimal(g._sum.receivedQty ?? 0).minus(g._sum.rejectedQty ?? 0)]));
  for (const r of ordered) {
    const status = r.purchaseOrderId ? poStatus.get(r.purchaseOrderId) : undefined;
    const live = !!status && !PO_DONE.includes(status);
    const line = r.purchaseOrderLineId ? lineBy.get(r.purchaseOrderLineId) : undefined;
    // A link to the PO without its line (never written since conversions record both): the request's own quantity.
    if (!line) out.set(r.id, live ? r.quantity : zero);
    else if (line.productId !== r.productId) out.set(r.id, zero);
    else out.set(r.id, (live ? Prisma.Decimal.max(zero, line.baseQuantity.minus(accepted.get(line.id) ?? zero)) : zero).plus(heldByLine.get(line.id) ?? zero));
  }
  return out;
}

const suggestionAuditInput = (actor: SuggestionActor, r: { id: string; number: string }, orderId: string, action: string, detail: string, reason?: string): AuditInput =>
  ({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "purchase_request", entityId: r.id, orderId, newValue: `${r.number} · ${detail}`, reason, source: actor.source === "n8n" || actor.source === "hermes" ? actor.source : actor.source === "system" ? "system" : "user", deviceId: actor.deviceId });

/**
 * Closes open suggestions no longer needed — what closing them one by one did (the pending
 * approval withdrawn, the request cancelled at the version it was read, one audit row each) in a
 * fixed number of statements.
 */
async function closeSuggestions(tx: Tx, closes: { r: PurchaseRequest; reason: string }[], actor: SuggestionActor) {
  if (!closes.length) return;
  await cancelPendingApprovals(tx, closes.filter(({ r }) => r.status === "pending_approval").map(({ r, reason }) => ({ type: "purchasing.request" as const, entityId: r.id, reason, actor })));
  const byReason = new Map<string, PurchaseRequest[]>();
  for (const { r, reason } of closes) {
    let rows = byReason.get(reason);
    if (!rows) byReason.set(reason, (rows = []));
    rows.push(r);
  }
  for (const [reason, rows] of byReason) await casUpdateMany(tx, rows, { status: "cancelled", cancelReason: reason });
  await writeAuditMany(closes.map(({ r, reason }) => suggestionAuditInput(actor, r, r.orderId!, "purchase_request_cancelled", "إلغاء تلقائي", reason)), tx);
}

/**
 * Re-sizes open suggestions in one statement — what casUpdate did row by row: the new sizing, a
 * grown approved one back to pending (its decision cleared), version + 1 and updatedAt now (UTC
 * wall time, as Prisma stores it), each row only at the version it was read (else 409).
 */
async function resizeSuggestions(tx: Tx, resizes: { r: PurchaseRequest; sizing: { quantity: Prisma.Decimal; requiredQty: Prisma.Decimal; availableQty: Prisma.Decimal; neededBy: string; customerReference: string | null }; reapprove: boolean }[]) {
  if (!resizes.length) return;
  const at = new Date().toISOString().replace("T", " ").replace("Z", "");
  const values = Prisma.join(
    resizes.map(({ r, sizing: s, reapprove }) =>
      Prisma.sql`(${r.id}::text, ${r.version}::int, ${s.quantity.toString()}::numeric, ${s.requiredQty.toString()}::numeric, ${s.availableQty.toString()}::numeric, ${s.neededBy}::text, ${s.customerReference}::text, ${reapprove}::boolean)`
    )
  );
  const n = await tx.$executeRaw`
    UPDATE "PurchaseRequest" AS r
    SET "quantity" = v.quantity, "requiredQty" = v.required_qty, "availableQty" = v.available_qty,
        "neededBy" = v.needed_by, "customerReference" = v.customer_reference,
        "status" = CASE WHEN v.reapprove THEN 'pending_approval' ELSE r."status" END,
        "decidedById" = CASE WHEN v.reapprove THEN NULL ELSE r."decidedById" END,
        "decidedBy" = CASE WHEN v.reapprove THEN NULL ELSE r."decidedBy" END,
        "decidedAt" = CASE WHEN v.reapprove THEN NULL ELSE r."decidedAt" END,
        "decisionNote" = CASE WHEN v.reapprove THEN NULL ELSE r."decisionNote" END,
        "version" = r."version" + 1, "updatedAt" = ${at}::timestamp(3)
    FROM (VALUES ${values}) AS v(id, version, quantity, required_qty, available_qty, needed_by, customer_reference, reapprove)
    WHERE r."id" = v.id AND r."version" = v.version`;
  if (n !== resizes.length) throw new ApiError(409, "طلب الشراء اتغيّر، حدّث الشاشة");
}

/**
 * Brings an order's line suggestions in step with its current shortage: creates the missing
 * one, resizes an open one whose quantity changed, closes one no longer needed. Runs in the
 * caller's transaction; safe to call any number of times (idempotent). For an order that is
 * not (or no longer) awaiting stock it closes every open suggestion.
 *
 * New suggestions and the approvals they ask for are written together after the lines are
 * judged (PW-2, Nov 2026: ~14 round trips per short line before — a 30-line order saved awaiting
 * stock ran past 20 s): one block of numbers in line order, one insert, one requestApprovals for
 * every approval in line order (so their numbers follow the lines as before), one audit insert.
 */
export async function syncOrderSuggestions(tx: Tx, orderId: string, actor: SuggestionActor, opts: { forOrder?: boolean } = {}) {
  await advisoryXactLock(tx, `purchasing:order-suggestions:${orderId}`);
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, stockStatus: true, customerAccountId: true, customerPoRef: true, deliveryDate: true } });
  if (!order) return { created: 0, updated: 0, closed: 0 };
  const held = order.stockStatus === "awaiting_stock" && order.status === "new";
  const assessment = held ? await assessOrderStock(tx, orderId) : null;
  const coverage = new Map((assessment?.coverage ?? []).map((c) => [c.itemId, c]));
  const where = { orderId, orderItemId: { not: null }, status: { in: [...OPEN_SUGGESTION, "ordered"] } };
  // An open suggestion may be approved or converted right now (the request's own lock): take
  // those locks, then read, so a resize never trips over a decision (it used to answer 409).
  const openRows = await tx.purchaseRequest.findMany({ where: { ...where, status: { in: OPEN_SUGGESTION } }, select: { id: true }, orderBy: { id: "asc" } });
  await advisoryXactLocks(tx, openRows.map((r) => `purchasing:request:${r.id}`));
  const existing = await tx.purchaseRequest.findMany({ where, orderBy: { createdAt: "asc" } });
  const coming = await stillOnOrder(tx, existing);
  const itemIds = [...new Set([...coverage.keys(), ...existing.map((e) => e.orderItemId!)])];
  // The base unit's precision of every short line (unitPrecision's rule), read once.
  const shortUnits = [...new Set([...coverage.values()].filter((c) => c.shortage.gt(0)).map((c) => c.baseUnit))];
  const precisionOf = new Map((shortUnits.length ? await tx.unitOfMeasure.findMany({ where: { code: { in: shortUnits } } }) : []).map((u) => [u.code, u.active ? u.precision : null]));
  // Approvals to ask, in line order: an approved suggestion that grew, or a new one (by index).
  const asks: ({ kind: "reapprove"; request: PurchaseRequest; need: Prisma.Decimal } | { kind: "create"; at: number })[] = [];
  const creates: { c: NonNullable<ReturnType<typeof coverage.get>>; itemId: string; sizing: { quantity: Prisma.Decimal; requiredQty: Prisma.Decimal; availableQty: Prisma.Decimal; neededBy: string; customerReference: string | null } }[] = [];
  // Closes and resizes are judged line by line and written together after the loop (PW-2: ~6
  // round trips per closed suggestion and ~2 per resized one before — a delivery-date change on a
  // 50-line order waiting for stock resized every line).
  const closes: { r: PurchaseRequest; reason: string }[] = [];
  const resizes: { r: PurchaseRequest; sizing: (typeof creates)[number]["sizing"]; reapprove: boolean }[] = [];
  const audits: AuditInput[] = [];
  let created = 0, updated = 0, closed = 0;
  for (const itemId of itemIds) {
    const c = coverage.get(itemId);
    const mine = existing.filter((e) => e.orderItemId === itemId);
    let open = mine.find((e) => OPEN_SUGGESTION.includes(e.status)) ?? null;
    // The line now names another product (a re-mapping): the old suggestion no longer fits.
    if (open && c && open.productId !== c.productId) {
      closes.push({ r: open, reason: "صنف السطر اتغيّر" });
      closed++;
      open = null;
    }
    // Still to come on a live purchase order for this line (base unit: suggestions are raised in it).
    const ordered = mine.filter((e) => e.status === "ordered" && (!c || e.productId === c.productId)).reduce((a, e) => a.plus(coming.get(e.id) ?? 0), new Prisma.Decimal(0));
    let need = new Prisma.Decimal(0);
    if (c && c.shortage.gt(0)) {
      const precision = precisionOf.get(c.baseUnit) ?? 3;
      need = Prisma.Decimal.max(0, c.shortage.minus(ordered)).toDecimalPlaces(precision, Prisma.Decimal.ROUND_UP);
    }
    if (need.lte(0)) {
      if (open) {
        closes.push({ r: open, reason: held ? "الناقص اتغطى" : "الأوردر مبقاش مستني بضاعة" });
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
      resizes.push({ r: open, sizing, reapprove });
      if (!open.quantity.equals(need)) {
        audits.push(suggestionAuditInput(actor, open, orderId, "purchase_request_quantity_changed", `${open.quantity.toFixed()} ← ${need.toFixed()} ${open.uomCode}`, `أوردر ${order.orderNumber}`));
      }
      // The approval reads the request's number, product, unit and requester: a resize keeps them.
      if (reapprove) asks.push({ kind: "reapprove", request: open, need });
      updated++;
      continue;
    }
    asks.push({ kind: "create", at: creates.length });
    creates.push({ c: c!, itemId, sizing });
  }
  await closeSuggestions(tx, closes, actor);
  await resizeSuggestions(tx, resizes);
  await writeAuditMany(audits, tx);
  if (!asks.length) return { created, updated, closed };

  const products = new Map((await tx.stockProduct.findMany({
    where: { id: { in: [...new Set([...creates.map((x) => x.c.productId), ...asks.flatMap((a) => (a.kind === "reapprove" ? [a.request.productId] : []))])] } },
    select: { id: true, name: true, nameAr: true, unit: true },
  })).map((p) => [p.id, p]));
  const productOf = (id: string) => {
    const p = products.get(id);
    if (!p) throw new Prisma.PrismaClientKnownRequestError("No StockProduct found", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
    return p;
  };
  // Raised by whoever acts on the order; when a PO-side event raises it (a PO closed, a
  // receipt, grading, stock leaving quarantine), on behalf of whoever saved the order, as at
  // saving — the buyer who closed the PO must still be able to approve it (four eyes).
  const raiser = creates.length && opts.forOrder ? await orderCreator(tx, orderId, actor) : actor;
  const numbers = creates.length ? await nextDocumentNumbers(tx, "purchasing.request", todayLocalISO(), creates.length) : [];
  // Created one after another, as before: lists ordered by createdAt keep the line order.
  const now = Date.now();
  const rows = creates.map(({ c, itemId, sizing }, n) => ({
    id: newId(),
    number: numbers[n],
    createdAt: new Date(now + n),
    productId: c.productId,
    uomCode: productOf(c.productId).unit,
    ...sizing,
    customerId: order.customerAccountId,
    orderId,
    orderItemId: itemId,
    notes: `ناقص في أوردر ${order.orderNumber} (سطر ${c.line})`,
    requestedById: raiser.id,
    requestedBy: raiser.name,
  }));
  if (rows.length) await tx.purchaseRequest.createMany({ data: rows });
  const ref = `أوردر ${order.orderNumber}${order.customerPoRef ? ` · ${order.customerPoRef}` : ""}`;
  await requestApprovals(
    tx,
    asks.map((a) => {
      if (a.kind === "reapprove") {
        const product = productOf(a.request.productId);
        return {
          type: "purchasing.request" as const,
          entityId: a.request.id,
          title: `طلب شراء ${a.request.number} · ${product.nameAr ?? product.name}`,
          summary: `${a.need.toFixed()} ${a.request.uomCode} · ${ref}`,
          requester: { id: a.request.requestedById, name: a.request.requestedBy, role: actor.role, deviceId: actor.deviceId },
        };
      }
      const r = rows[a.at];
      const product = productOf(r.productId);
      return {
        type: "purchasing.request" as const,
        entityId: r.id,
        title: `طلب شراء ${r.number} · ${product.nameAr ?? product.name}`,
        summary: `${r.quantity.toFixed()} ${product.unit} · ${ref}`,
        requester: { id: raiser.id, name: raiser.name, role: raiser.role, deviceId: actor.deviceId },
      };
    })
  );
  await writeAuditMany(rows.map((r) => {
    const product = productOf(r.productId);
    return suggestionAuditInput(actor, r, orderId, "purchase_request_created", `${product.name} · ${r.quantity.toFixed()} ${product.unit} · أوردر ${order.orderNumber}`);
  }), tx);
  created += rows.length;
  return { created, updated, closed };
}

async function orderCreator(tx: Tx, orderId: string, fallback: SuggestionActor): Promise<{ id: string | null; name: string; role: string }> {
  const row = await tx.auditLog.findFirst({ where: { orderId, action: "order_created" }, orderBy: { timestamp: "asc" }, select: { userId: true, userName: true, role: true } });
  return row ? { id: row.userId, name: row.userName, role: row.role } : fallback;
}

/** Re-sizes the suggestions of every order a purchase order serves (its converted line requests). */
export async function syncSuggestionsOfPo(tx: Tx, poId: string, actor: SuggestionActor) {
  const rows = await tx.purchaseRequest.findMany({ where: { purchaseOrderId: poId, status: "ordered", orderItemId: { not: null } }, select: { orderId: true } });
  for (const orderId of new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))) await syncOrderSuggestions(tx, orderId, actor, { forOrder: true });
}

/**
 * Stock left quarantine from these lots (released, written off, moved): when a lot came in on a
 * PO, what that PO still "brings" changed (stillOnOrder counts its held part), so the orders it
 * serves are re-sized. Called at commit by lib/inventory/availability-changes.ts.
 */
export async function syncSuggestionsForLots(tx: Tx, lotIds: string[], actor: SuggestionActor) {
  if (!lotIds.length) return;
  const intakes = await tx.stockIntake.findMany({ where: { lotId: { in: lotIds }, purchaseOrderLineId: { not: null } }, select: { purchaseOrderLine: { select: { poId: true } } } });
  for (const poId of new Set(intakes.map((i) => i.purchaseOrderLine!.poId))) await syncSuggestionsOfPo(tx, poId, actor);
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
  if (!rows.length) return 0;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNumber: true } });
  // What closing and casUpdate did row by row, in a fixed number of statements (PW-2,
  // Nov 2026: ~6 round trips per suggestion when a held order is released or cancelled).
  const closeReason = outcome === "cancelled" ? `الأوردر اتلغى: ${reason}` : `البضاعة اتوفرت والأوردر اتفرج عنه`;
  const closing = rows.filter((r) => OPEN_SUGGESTION.includes(r.status));
  const fulfilling = outcome === "released" ? rows.filter((r) => !OPEN_SUGGESTION.includes(r.status)) : [];
  await cancelPendingApprovals(tx, closing.filter((r) => r.status === "pending_approval").map((r) => ({ type: "purchasing.request" as const, entityId: r.id, reason: closeReason, actor })));
  await casUpdateMany(tx, closing, { status: "cancelled", cancelReason: closeReason });
  await casUpdateMany(tx, fulfilling, { status: "fulfilled", fulfilledOrderId: orderId });
  await writeAuditMany(
    rows.map((r) =>
      OPEN_SUGGESTION.includes(r.status)
        ? suggestionAuditInput(actor, r, orderId, "purchase_request_cancelled", "إلغاء تلقائي", closeReason)
        : outcome === "released"
          ? suggestionAuditInput(actor, r, orderId, "purchase_request_fulfilled", `أوردر ${order.orderNumber}`)
          : suggestionAuditInput(actor, r, orderId, "purchase_request_origin_cancelled", `أوردر ${order.orderNumber}`, reason)
    ),
    tx
  );
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
