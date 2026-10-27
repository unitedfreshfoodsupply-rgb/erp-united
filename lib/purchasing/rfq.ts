import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { resolveWarehouse } from "@/lib/inventory/context";
import { createPoInTx } from "@/lib/purchasing/orders";

/**
 * Requests for quotation: ask several suppliers the same question, record what each
 * answers, compare line by line, and award each line to one supplier. The award
 * creates one draft purchase order per awarded supplier, priced from its quotation —
 * the PO then follows its normal approval path.
 *
 *   draft ──send──▶ sent ──(quotes recorded)──award──▶ awarded
 *     └──────────── cancel (before award)
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const num = (label: string, dp: number, allowZero = false) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    const re = new RegExp(`^\\d+(\\.\\d{1,${dp}})?$`);
    if (!re.test(s) || (!allowZero && Number(s) <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون رقم ${allowZero ? "موجب" : "أكبر من صفر"} بحد أقصى ${dp} خانات عشرية` });
      return z.NEVER;
    }
    return D(s);
  });
const isoDate = (label: string) => z.string().refine(isValidISODate, `${label} لازم يكون تاريخ YYYY-MM-DD`);

const auditRfq = (tx: Tx, actor: ServiceActor, rfq: { id: string; number: string }, action: string, detail: string | null, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "rfq", entityId: rfq.id, fieldChanged: rfq.number, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx);

const rfqInput = z.object({
  warehouse_id: z.string().optional(),
  needed_by: isoDate("مطلوب قبل").nullable().optional(),
  notes: optText("ملاحظات", 2000).optional(),
  lines: z.array(z.object({ product_id: text("الصنف"), quantity: num("الكمية", 3), uom: z.string().trim().optional(), notes: optText("ملاحظة").optional() })).min(1, "لازم صنف واحد على الأقل").max(100),
  supplier_ids: z.array(z.string()).min(1, "اختار مورد واحد على الأقل").max(30),
});

export async function createRfq(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.rfq.manage");
  const v = parse(rfqInput, input);
  return inTx(async (tx) => {
    const wh = await resolveWarehouse(tx, v.warehouse_id);
    const lines: Prisma.RfqLineCreateManyRfqInput[] = [];
    let n = 0;
    for (const l of v.lines) {
      const p = await tx.stockProduct.findUnique({ where: { id: l.product_id }, include: { packagings: true } });
      if (!p || !p.active) throw new ApiError(400, "صنف مش موجود أو موقوف");
      const uom = l.uom || p.unit;
      if (uom !== p.unit && !p.packagings.some((x) => x.uomCode === uom && x.active)) throw new ApiError(400, `الوحدة ${uom} مش متعرّفة للصنف "${p.name}"`);
      lines.push({ lineNo: ++n, productId: p.id, uomCode: uom, quantity: l.quantity, notes: l.notes ?? null });
    }
    const suppliers = await tx.supplier.findMany({ where: { id: { in: [...new Set(v.supplier_ids)] }, active: true } });
    if (suppliers.length !== new Set(v.supplier_ids).size) throw new ApiError(400, "مورد مش موجود أو موقوف");
    const rfq = await tx.rfq.create({
      data: {
        number: await nextDocumentNumber(tx, "purchasing.rfq", todayLocalISO()),
        warehouseId: wh.id,
        neededBy: v.needed_by ?? null,
        notes: v.notes ?? null,
        createdById: actor.id,
        createdBy: actor.name,
        lines: { createMany: { data: lines } },
        suppliers: { createMany: { data: suppliers.map((s) => ({ supplierId: s.id })) } },
      },
    });
    await auditRfq(tx, actor, rfq, "rfq_created", `${lines.length} صنف · ${suppliers.length} مورد`);
    return rfq;
  });
}

async function loadForUpdate(tx: Tx, id: string) {
  await advisoryXactLock(tx, `purchasing:rfq:${id}`);
  const rfq = await tx.rfq.findUnique({ where: { id }, include: { lines: true, suppliers: true } });
  if (!rfq) throw new ApiError(404, "طلب عرض السعر مش موجود");
  return rfq;
}

export async function sendRfq(id: string, actor: ServiceActor) {
  assertPermission(actor, "purchasing.rfq.manage");
  return inTx(async (tx) => {
    const rfq = await loadForUpdate(tx, id);
    if (rfq.status !== "draft") throw new ApiError(409, "الطلب اتبعت بالفعل");
    const r = await tx.rfq.update({ where: { id, version: rfq.version }, data: { status: "sent", version: { increment: 1 } } });
    await auditRfq(tx, actor, rfq, "rfq_sent", null);
    return r;
  });
}

const quoteInput = z.object({
  supplier_id: text("المورد"),
  valid_until: isoDate("صالح لحد").nullable().optional(),
  notes: optText("ملاحظات", 1000).optional(),
  declined: z.boolean().optional(),
  lines: z.array(z.object({ rfq_line_id: text("السطر"), unit_price: num("السعر", 4, true), quantity: num("الكمية", 3).nullable().optional(), lead_time_days: z.number().int().min(0).max(365).nullable().optional() })).max(100).optional(),
});

/** Records (or replaces) one supplier's answer. Lines it does not quote it does not supply. */
export async function recordSupplierQuote(rfqId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.rfq.manage");
  const v = parse(quoteInput, input);
  return inTx(async (tx) => {
    const rfq = await loadForUpdate(tx, rfqId);
    if (rfq.status !== "sent") throw new ApiError(409, rfq.status === "draft" ? "ابعت الطلب للموردين الأول" : "الطلب مقفول");
    const inv = rfq.suppliers.find((s) => s.supplierId === v.supplier_id);
    if (!inv) throw new ApiError(400, "المورد ده مش متدعي على الطلب");
    await tx.supplierQuoteLine.deleteMany({ where: { rfqSupplierId: inv.id } });
    if (v.declined) {
      await tx.rfqSupplier.update({ where: { id: inv.id }, data: { status: "declined", quotedAt: new Date(), notes: v.notes ?? null, recordedBy: actor.name, version: { increment: 1 } } });
      await auditRfq(tx, actor, rfq, "rfq_supplier_declined", v.supplier_id);
      return { declined: true };
    }
    const lines = v.lines ?? [];
    if (!lines.length) throw new ApiError(400, "سجّل سعر سطر واحد على الأقل أو اعتبره رفض");
    for (const l of lines) {
      if (!rfq.lines.some((x) => x.id === l.rfq_line_id)) throw new ApiError(400, "سطر مش تابع للطلب");
    }
    if (new Set(lines.map((l) => l.rfq_line_id)).size !== lines.length) throw new ApiError(400, "سطر متكرر");
    await tx.supplierQuoteLine.createMany({
      data: lines.map((l) => ({ rfqSupplierId: inv.id, rfqLineId: l.rfq_line_id, unitPrice: l.unit_price, quantity: l.quantity ?? null, leadTimeDays: l.lead_time_days ?? null })),
    });
    await tx.rfqSupplier.update({ where: { id: inv.id }, data: { status: "quoted", quotedAt: new Date(), validUntil: v.valid_until ?? null, notes: v.notes ?? null, recordedBy: actor.name, version: { increment: 1 } } });
    await auditRfq(tx, actor, rfq, "rfq_quote_recorded", `${v.supplier_id} · ${lines.length} سطر`);
    return { declined: false, lines: lines.length };
  });
}

/** Line by line: who quoted what, cheapest first, with the cheapest marked. */
export async function getRfq(id: string) {
  const rfq = await prisma.rfq.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNo: "asc" }, include: { product: { select: { name: true, nameAr: true, unit: true } } } },
      suppliers: { include: { supplier: { select: { id: true, code: true, name: true, nameAr: true, leadTimeDays: true, paymentTermsDays: true } }, lines: true } },
      orders: { select: { id: true, number: true, status: true, supplierId: true } },
    },
  });
  if (!rfq) throw new ApiError(404, "طلب عرض السعر مش موجود");
  const comparison = rfq.lines.map((l) => {
    const quotes = rfq.suppliers
      .flatMap((s) => s.lines.filter((q) => q.rfqLineId === l.id).map((q) => ({ supplier: s.supplier, unitPrice: q.unitPrice.toString(), quantity: q.quantity?.toString() ?? null, leadTimeDays: q.leadTimeDays, awarded: q.awarded, quoteLineId: q.id, validUntil: s.validUntil })))
      .sort((a, b) => Number(a.unitPrice) - Number(b.unitPrice));
    return { line: { id: l.id, lineNo: l.lineNo, productId: l.productId, product: l.product, uomCode: l.uomCode, quantity: l.quantity.toString() }, quotes, cheapestSupplierId: quotes[0]?.supplier.id ?? null };
  });
  return {
    id: rfq.id,
    number: rfq.number,
    status: rfq.status,
    neededBy: rfq.neededBy,
    notes: rfq.notes,
    version: rfq.version,
    createdBy: rfq.createdBy,
    createdAt: rfq.createdAt,
    invited: rfq.suppliers.map((s) => ({ supplier: s.supplier, status: s.status, quotedAt: s.quotedAt, validUntil: s.validUntil, notes: s.notes })),
    comparison,
    orders: rfq.orders,
  };
}

export async function listRfqs(filters: { status?: string }) {
  return prisma.rfq.findMany({
    where: filters.status ? { status: filters.status } : {},
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { _count: { select: { lines: true, suppliers: true } }, suppliers: { select: { status: true } } },
  });
}

const awardInput = z.object({
  awards: z.array(z.object({ rfq_line_id: text("السطر"), supplier_id: text("المورد") })).min(1, "رسّي سطر واحد على الأقل"),
  expected_date: isoDate("تاريخ التوريد").nullable().optional(),
});

/**
 * Awards lines to suppliers and creates one draft PO per awarded supplier at the
 * quoted prices, in one transaction. A line is awarded once; a supplier's quote must
 * still be valid. Unawarded lines are simply not ordered.
 */
export async function awardRfq(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.rfq.manage");
  assertPermission(actor, "purchasing.orders.manage");
  const v = parse(awardInput, input);
  const today = todayLocalISO();
  return inTx(async (tx) => {
    const rfq = await loadForUpdate(tx, id);
    if (rfq.status !== "sent") throw new ApiError(409, rfq.status === "awarded" ? "الطلب اترسّى بالفعل" : "بس الطلب المبعوت يترسّى");
    if (new Set(v.awards.map((a) => a.rfq_line_id)).size !== v.awards.length) throw new ApiError(400, "السطر بيترسّى على مورد واحد");
    const bySupplier = new Map<string, { quoteLineId: string; line: (typeof rfq.lines)[number]; unitPrice: Prisma.Decimal }[]>();
    for (const a of v.awards) {
      const line = rfq.lines.find((l) => l.id === a.rfq_line_id);
      if (!line) throw new ApiError(400, "سطر مش تابع للطلب");
      const inv = rfq.suppliers.find((s) => s.supplierId === a.supplier_id);
      if (!inv || inv.status !== "quoted") throw new ApiError(400, "المورد ده مقدمش عرض");
      if (inv.validUntil && inv.validUntil < today) throw new ApiError(409, `عرض المورد انتهت صلاحيته في ${inv.validUntil}`);
      const q = await tx.supplierQuoteLine.findUnique({ where: { rfqSupplierId_rfqLineId: { rfqSupplierId: inv.id, rfqLineId: line.id } } });
      if (!q) throw new ApiError(400, "المورد ده مسعّرش السطر ده");
      if (q.quantity && q.quantity.lessThan(line.quantity)) throw new ApiError(400, "المورد عرض كمية أقل من المطلوب — قسّم الطلب أو عدّل الكمية");
      await tx.supplierQuoteLine.update({ where: { id: q.id }, data: { awarded: true } });
      const list = bySupplier.get(a.supplier_id) ?? [];
      list.push({ quoteLineId: q.id, line, unitPrice: q.unitPrice });
      bySupplier.set(a.supplier_id, list);
    }
    const orders = [];
    for (const [supplierId, lines] of bySupplier) {
      orders.push(
        await createPoInTx(
          tx,
          {
            supplierId,
            warehouseId: rfq.warehouseId,
            expectedDate: v.expected_date ?? rfq.neededBy,
            notes: `من طلب عرض السعر ${rfq.number}`,
            rfqId: rfq.id,
            lines: lines.map((l) => ({ product_id: l.line.productId, quantity: l.line.quantity, uom: l.line.uomCode, unit_price: l.unitPrice, quote_line_id: l.quoteLineId })),
          },
          actor
        )
      );
    }
    await tx.rfq.update({ where: { id, version: rfq.version }, data: { status: "awarded", version: { increment: 1 } } });
    await auditRfq(tx, actor, rfq, "rfq_awarded", orders.map((o) => o.number).join("، "));
    return { orders };
  });
}

export async function cancelRfq(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.rfq.manage");
  const v = parse(z.object({ reason: text("السبب", 500) }), input);
  return inTx(async (tx) => {
    const rfq = await loadForUpdate(tx, id);
    if (!["draft", "sent"].includes(rfq.status)) throw new ApiError(409, "الطلب مقفول بالفعل");
    const r = await tx.rfq.update({ where: { id, version: rfq.version }, data: { status: "cancelled", version: { increment: 1 } } });
    await auditRfq(tx, actor, rfq, "rfq_cancelled", null, v.reason);
    return r;
  });
}
