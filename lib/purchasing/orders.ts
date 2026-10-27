import { Prisma, type PurchaseOrder } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { assertEgpCurrency } from "@/lib/core/currency";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { getSetting } from "@/lib/core/settings-service";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { cancelPendingApproval, requestApproval } from "@/lib/core/approvals";
import { optText, parse, text, version } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { resolveWarehouse } from "@/lib/inventory/context";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { amountsJSON, lineAmounts, sumAmounts } from "@/lib/sales/money";
import { effectiveSupplierPrice } from "@/lib/purchasing/suppliers";

/**
 * Purchase orders.
 *
 *   draft ──submit──▶ (total > threshold) pending_approval ──approve──▶ approved
 *     ▲                                    └──reject──▶ draft (with the reason)
 *     │              (otherwise)           approved
 *   edit (draft only)                      approved ──send──▶ sent
 *                                          sent / approved ──receipts──▶ partially_received ──▶ received
 *   cancel: anything not yet received from; close: stop waiting for the rest.
 *
 * A line is priced from the supplier's agreed price for the order date (or from the
 * quotation it was awarded from). Typing a different price is a pricing decision and
 * needs purchasing.prices.manage. Prices are visible only with purchasing.prices.view —
 * the receiver works from quantities.
 *
 * What has been received is never stored on the order: it is the sum of the posted
 * receipts against each line, so a corrected or voided receipt cannot leave the order
 * saying something else.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
type Actorish = ServiceActor;

export const qty = (label: string) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d+(\.\d{1,3})?$/.test(s) || Number(s) <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون أكبر من صفر وبحد أقصى 3 خانات عشرية` });
      return z.NEVER;
    }
    return D(s);
  });
export const money = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "السعر لازم يكون رقم موجب بحد أقصى 4 خانات عشرية" });
    return z.NEVER;
  }
  return D(s);
});
const pct = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "الخصم لازم يكون بين 0 و 100" });
    return z.NEVER;
  }
  return D(s);
});
export const isoDate = (label: string) => z.string().refine(isValidISODate, `${label} لازم يكون تاريخ YYYY-MM-DD`);

const lineInput = z.object({
  product_id: text("الصنف"),
  quantity: qty("الكمية"),
  uom: z.string().trim().optional(),
  unit_price: money.optional(),
  discount_pct: pct.optional(),
  notes: optText("ملاحظة").optional(),
});
const poInput = z.object({
  supplier_id: text("المورد"),
  warehouse_id: z.string().optional(),
  expected_date: isoDate("تاريخ التوريد المتوقع").nullable().optional(),
  notes: optText("ملاحظات", 2000).optional(),
  lines: z.array(lineInput).min(1, "لازم سطر واحد على الأقل").max(200),
  expected_version: version,
});

const auditPo = (tx: Tx, actor: { id: string | null; name: string; role: string; deviceId?: string }, po: { id: string; number: string }, action: string, detail: string | null, reason?: string | null) =>
  writeAudit(
    { userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "purchase_order", entityId: po.id, fieldChanged: po.number, newValue: detail, reason: reason ?? undefined, source: "user", deviceId: actor.deviceId },
    tx
  );

export type PoLineDraft = Prisma.PurchaseOrderLineCreateManyPoInput;

/** Prices, converts and validates lines for a supplier on a date. */
export async function buildPoLines(
  tx: Tx,
  supplierId: string,
  date: string,
  lines: { product_id: string; quantity: Prisma.Decimal; uom?: string; unit_price?: Prisma.Decimal; discount_pct?: Prisma.Decimal; notes?: string | null; quote_line_id?: string }[],
  actor: Actorish
): Promise<PoLineDraft[]> {
  const out: PoLineDraft[] = [];
  let n = 0;
  for (const l of lines) {
    const product = await tx.stockProduct.findUnique({ where: { id: l.product_id }, include: { salesTax: true } });
    if (!product || !product.active) throw new ApiError(400, "صنف مش موجود أو موقوف");
    if (!product.stockTracked) throw new ApiError(400, `"${product.name}" مش صنف مخزني`);
    const uom = l.uom || product.unit;
    let baseQuantity: Prisma.Decimal;
    try {
      baseQuantity = await toBaseQuantity(tx, product, l.quantity, uom);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw err;
    }
    const agreed = await effectiveSupplierPrice(tx, { supplierId, product, uom, date });
    let unitPrice: Prisma.Decimal;
    let priceSource: "supplier_price" | "quotation" | "manual";
    if (l.quote_line_id && l.unit_price) {
      unitPrice = l.unit_price;
      priceSource = "quotation";
    } else if (l.unit_price !== undefined && (!agreed || !agreed.unitPrice.equals(l.unit_price))) {
      if (!actorCan(actor, "purchasing.prices.manage")) throw new ApiError(403, `سعر "${product.name}" مختلف عن السعر المتفق عليه — محتاج صلاحية إدارة أسعار الموردين`);
      unitPrice = l.unit_price;
      priceSource = "manual";
    } else if (agreed) {
      unitPrice = agreed.unitPrice;
      priceSource = "supplier_price";
    } else {
      throw new ApiError(400, `مفيش سعر متفق عليه مع المورد لـ"${product.name}" (${uom}) في ${date} — اكتب السعر`);
    }
    const discount = l.discount_pct ?? D(0);
    if (discount.gt(0) && priceSource === "supplier_price" && !actorCan(actor, "purchasing.prices.manage")) {
      throw new ApiError(403, "الخصم على السعر المتفق عليه محتاج صلاحية إدارة أسعار الموردين");
    }
    out.push({
      lineNo: ++n,
      productId: product.id,
      uomCode: uom,
      quantity: l.quantity,
      baseQuantity,
      unitPrice,
      discountPct: discount,
      taxCode: product.salesTaxCode,
      taxRate: product.salesTax.rate,
      priceSource,
      supplierPriceId: priceSource === "supplier_price" ? agreed!.row.id : null,
      quoteLineId: l.quote_line_id ?? null,
      notes: l.notes ?? null,
    });
  }
  return out;
}

function totalsOf(lines: { quantity: Prisma.Decimal.Value; unitPrice: Prisma.Decimal.Value; discountPct: Prisma.Decimal.Value; taxRate: Prisma.Decimal.Value }[]) {
  const t = sumAmounts(lines.map((l) => lineAmounts({ quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate })));
  return { net: t.net, taxTotal: t.tax, total: t.total };
}

/** Creates a draft in the caller's transaction (used by the RFQ award too). */
export async function createPoInTx(
  tx: Tx,
  input: { supplierId: string; warehouseId?: string; expectedDate?: string | null; notes?: string | null; rfqId?: string | null; lines: Parameters<typeof buildPoLines>[3] },
  actor: Actorish
) {
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier || !supplier.active) throw new ApiError(400, "المورد مش موجود أو موقوف");
  assertEgpCurrency(supplier.currencyCode, "أمر الشراء");
  const wh = await resolveWarehouse(tx, input.warehouseId);
  const today = todayLocalISO();
  const lines = await buildPoLines(tx, supplier.id, today, input.lines, actor);
  const po = await tx.purchaseOrder.create({
    data: {
      number: await nextDocumentNumber(tx, "purchasing.order", today),
      supplierId: supplier.id,
      warehouseId: wh.id,
      rfqId: input.rfqId ?? null,
      orderDate: today,
      expectedDate: input.expectedDate ?? null,
      currencyCode: supplier.currencyCode,
      paymentTermsDays: supplier.paymentTermsDays,
      notes: input.notes ?? null,
      ...totalsOf(lines as never),
      createdById: actor.id,
      createdBy: actor.name,
      lines: { createMany: { data: lines } },
    },
  });
  await auditPo(tx, actor, po, "purchase_order_created", `${supplier.code} · ${lines.length} سطر · ${po.total.toFixed(2)}`);
  return po;
}

export async function createPurchaseOrder(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.orders.manage");
  const v = parse(poInput, input);
  return inTx((tx) => createPoInTx(tx, { supplierId: v.supplier_id, warehouseId: v.warehouse_id, expectedDate: v.expected_date, notes: v.notes, lines: v.lines }, actor));
}

export async function updatePurchaseOrder(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.orders.manage");
  const v = parse(poInput, input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `purchasing:po:${id}`);
    const po = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new ApiError(404, "أمر الشراء مش موجود");
    if (po.status !== "draft") throw new ApiError(409, "أمر الشراء اتقدّم — التعديل بس في المسودة");
    if (v.expected_version !== undefined && v.expected_version !== po.version) throw new ApiError(409, "أمر الشراء اتغير، حدّث الشاشة");
    if (v.supplier_id !== po.supplierId) throw new ApiError(400, "مينفعش تغيّر المورد — اعمل أمر جديد");
    const lines = await buildPoLines(tx, po.supplierId, po.orderDate, v.lines, actor);
    await tx.purchaseOrderLine.deleteMany({ where: { poId: id } });
    const updated = await tx.purchaseOrder.update({
      where: { id, version: po.version },
      data: { expectedDate: v.expected_date ?? null, notes: v.notes ?? null, ...totalsOf(lines as never), version: { increment: 1 }, lines: { createMany: { data: lines } } },
    });
    await auditPo(tx, actor, po, "purchase_order_edited", `${lines.length} سطر · ${updated.total.toFixed(2)}`);
    return updated;
  });
}

async function transition(tx: Tx, po: PurchaseOrder, data: Prisma.PurchaseOrderUpdateInput) {
  try {
    return await tx.purchaseOrder.update({ where: { id: po.id, version: po.version }, data: { ...data, version: { increment: 1 } } });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "أمر الشراء اتغير، حدّث الشاشة");
    throw err;
  }
}

/** Submit a draft: above the threshold it waits for finance; otherwise it is approved
 * by the rule itself (recorded as such). */
export async function submitPurchaseOrder(id: string, actor: ServiceActor) {
  assertPermission(actor, "purchasing.orders.manage");
  const threshold = D(await getSetting("purchasing.po_approval_threshold"));
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `purchasing:po:${id}`);
    const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { supplier: true, _count: { select: { lines: true } } } });
    if (!po) throw new ApiError(404, "أمر الشراء مش موجود");
    if (po.status !== "draft") throw new ApiError(409, "أمر الشراء اتقدّم بالفعل");
    if (po._count.lines === 0) throw new ApiError(400, "أمر شراء من غير سطور");
    const needsApproval = threshold.isZero() || po.total.greaterThan(threshold);
    if (needsApproval) {
      const updated = await transition(tx, po, { status: "pending_approval" });
      await requestApproval(tx, {
        type: "purchasing.order",
        entityId: po.id,
        title: `أمر شراء ${po.number} · ${po.supplier.name}`,
        summary: `${po.total.toFixed(2)} ${po.currencyCode} · ${po._count.lines} سطر`,
        amount: po.total,
        requester: actor,
      });
      await auditPo(tx, actor, po, "purchase_order_submitted", `مستني اعتماد (${po.total.toFixed(2)} > ${threshold.toFixed(2)})`);
      return updated;
    }
    const updated = await transition(tx, po, { status: "approved", approvedAt: new Date(), approvedById: null, approvedBy: `تحت حد الاعتماد (${threshold.toFixed(2)})` });
    await auditPo(tx, actor, po, "purchase_order_submitted", "اتعتمد تلقائياً — تحت حد الاعتماد");
    return updated;
  });
}

/** Approval handlers (lib/core/approval-handlers.ts). */
export async function applyPoDecision(tx: Tx, poId: string, approved: boolean, decider: { id: string | null; name: string; role: string; deviceId?: string }, comment?: string) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po) throw new ApiError(404, "أمر الشراء مش موجود");
  if (po.status !== "pending_approval") throw new ApiError(409, "أمر الشراء مش مستني اعتماد");
  if (approved) {
    await transition(tx, po, { status: "approved", approvedAt: new Date(), approvedById: decider.id, approvedBy: decider.name });
    await auditPo(tx, decider, po, "purchase_order_approved", null, comment);
  } else {
    // Back to the buyer to change and resubmit.
    await transition(tx, po, { status: "draft" });
    await auditPo(tx, decider, po, "purchase_order_rejected", null, comment);
  }
}

export async function sendPurchaseOrder(id: string, actor: ServiceActor) {
  assertPermission(actor, "purchasing.orders.manage");
  return inTx(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new ApiError(404, "أمر الشراء مش موجود");
    if (po.status !== "approved") throw new ApiError(409, po.status === "pending_approval" ? "أمر الشراء لسه مستني اعتماد" : "بس أمر الشراء المعتمد يتبعت");
    const updated = await transition(tx, po, { status: "sent", sentAt: new Date() });
    await auditPo(tx, actor, po, "purchase_order_sent", null);
    return updated;
  });
}

async function receivedSoFar(db: Pick<Tx, "stockIntake">, poId: string) {
  const rows = await db.stockIntake.groupBy({
    by: ["purchaseOrderLineId"],
    where: { status: "posted", purchaseOrderLine: { poId } },
    _sum: { goodQty: true, rejectedQty: true, receivedQty: true },
  });
  return new Map(rows.map((r) => [r.purchaseOrderLineId!, { good: D(r._sum.goodQty ?? 0), rejected: D(r._sum.rejectedQty ?? 0), received: D(r._sum.receivedQty ?? 0) }]));
}

export async function cancelPurchaseOrder(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.orders.manage");
  const v = parse(z.object({ reason: text("سبب الإلغاء", 500) }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `purchasing:po:${id}`);
    const po = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new ApiError(404, "أمر الشراء مش موجود");
    if (["cancelled", "closed", "received"].includes(po.status)) throw new ApiError(409, "أمر الشراء مقفول بالفعل");
    const got = await receivedSoFar(tx, id);
    if ([...got.values()].some((x) => x.received.gt(0))) throw new ApiError(409, "اتستلم جزء من الأمر — اقفله بدل ما تلغيه");
    if (po.status === "pending_approval") await cancelPendingApproval(tx, { type: "purchasing.order", entityId: id, reason: `أمر الشراء اتلغى: ${v.reason}`, actor });
    const updated = await transition(tx, po, { status: "cancelled", cancelReason: v.reason, closedAt: new Date() });
    await auditPo(tx, actor, po, "purchase_order_cancelled", null, v.reason);
    return updated;
  });
}

/** Stop waiting for what has not come (a short delivery the supplier will not make up). */
export async function closePurchaseOrder(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.orders.manage");
  const v = parse(z.object({ reason: text("سبب القفل", 500) }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `purchasing:po:${id}`);
    const po = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new ApiError(404, "أمر الشراء مش موجود");
    if (!["sent", "approved", "partially_received", "received"].includes(po.status)) throw new ApiError(409, "بس أمر الشراء الشغال يتقفل");
    const updated = await transition(tx, po, { status: "closed", closedAt: new Date(), cancelReason: v.reason });
    await auditPo(tx, actor, po, "purchase_order_closed", null, v.reason);
    return updated;
  });
}

/**
 * Re-derives an order's receiving status from its posted receipts, in the caller's
 * transaction (every receipt create / correction / void calls it). A line counts as
 * delivered when its good quantity reaches what was ordered.
 */
export async function refreshPoReceiptStatus(tx: Tx, poId: string, actor: { id: string | null; name: string; role: string; deviceId?: string }) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } });
  if (!po || ["cancelled", "closed", "draft", "pending_approval"].includes(po.status)) return po?.status ?? null;
  const got = await receivedSoFar(tx, poId);
  const anyIn = [...got.values()].some((x) => x.received.gt(0));
  const allIn = po.lines.every((l) => (got.get(l.id)?.good ?? D(0)).greaterThanOrEqualTo(l.baseQuantity));
  const next = allIn ? "received" : anyIn ? "partially_received" : po.sentAt ? "sent" : "approved";
  if (next !== po.status) {
    await transition(tx, po, { status: next });
    await auditPo(tx, actor, po, "purchase_order_receipt_status", `${po.status} → ${next}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function present(po: Prisma.PurchaseOrderGetPayload<{ include: { supplier: { select: { id: true; code: true; name: true; nameAr: true } }; lines: { include: { product: { select: { name: true; nameAr: true; unit: true } } } } } }>, got: Map<string, { good: Prisma.Decimal; rejected: Prisma.Decimal; received: Prisma.Decimal }>, withPrices: boolean) {
  const lines = po.lines
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => {
      const g = got.get(l.id) ?? { good: D(0), rejected: D(0), received: D(0) };
      // A cancelled or closed order expects nothing more.
      const remaining = ["cancelled", "closed"].includes(po.status) ? D(0) : Prisma.Decimal.max(D(l.baseQuantity).minus(g.good), 0);
      return {
        id: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        product: l.product,
        uomCode: l.uomCode,
        quantity: l.quantity.toString(),
        baseQuantity: l.baseQuantity.toString(),
        receivedGood: g.good.toString(),
        rejected: g.rejected.toString(),
        remaining: remaining.toString(),
        notes: l.notes,
        ...(withPrices
          ? { unitPrice: l.unitPrice.toString(), discountPct: l.discountPct.toString(), taxCode: l.taxCode, taxRate: l.taxRate.toString(), priceSource: l.priceSource, amounts: amountsJSON(lineAmounts({ quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate })) }
          : {}),
      };
    });
  const base = {
    id: po.id,
    number: po.number,
    status: po.status,
    supplier: po.supplier,
    warehouseId: po.warehouseId,
    rfqId: po.rfqId,
    orderDate: po.orderDate,
    expectedDate: po.expectedDate,
    notes: po.notes,
    cancelReason: po.cancelReason,
    approvedBy: po.approvedBy,
    approvedAt: po.approvedAt,
    sentAt: po.sentAt,
    closedAt: po.closedAt,
    version: po.version,
    createdBy: po.createdBy,
    createdAt: po.createdAt,
    lines,
  };
  return withPrices ? { ...base, currencyCode: po.currencyCode, paymentTermsDays: po.paymentTermsDays, net: po.net.toFixed(2), taxTotal: po.taxTotal.toFixed(2), total: po.total.toFixed(2) } : base;
}

const PO_INCLUDE = { supplier: { select: { id: true, code: true, name: true, nameAr: true } }, lines: { include: { product: { select: { name: true, nameAr: true, unit: true } } } } } as const;

export async function getPurchaseOrder(id: string, viewer: { permissions: readonly string[] } | { can: (p: never) => boolean }) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: PO_INCLUDE });
  if (!po) throw new ApiError(404, "أمر الشراء مش موجود");
  return present(po, await receivedSoFar(prisma, id), canSeePrices(viewer));
}

export async function listPurchaseOrders(filters: { status?: string; supplierId?: string; open?: boolean }, viewer: Parameters<typeof getPurchaseOrder>[1]) {
  const rows = await prisma.purchaseOrder.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.open ? { status: { in: ["approved", "sent", "partially_received"] } } : {}),
      ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: PO_INCLUDE,
  });
  const withPrices = canSeePrices(viewer);
  const out = [];
  for (const po of rows) out.push(present(po, await receivedSoFar(prisma, po.id), withPrices));
  return out;
}

export function canSeePrices(viewer: { permissions?: readonly string[] } | { can?: (p: never) => boolean }) {
  const v = viewer as { permissions?: readonly string[] | Set<string>; can?: (p: string) => boolean };
  if (typeof v.can === "function") return v.can("purchasing.prices.view");
  const p = v.permissions;
  return p instanceof Set ? p.has("purchasing.prices.view") : !!p?.includes("purchasing.prices.view");
}
