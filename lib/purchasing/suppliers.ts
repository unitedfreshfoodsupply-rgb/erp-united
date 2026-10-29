import { Prisma, type Supplier } from "@prisma/client";
import { partyCode } from "@/lib/sales/customers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany, type AuditInput } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { active, optText, parse, text, version } from "@/lib/core/validation";
import { egpCurrencyCode } from "@/lib/core/currency";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { nextDocumentNumber } from "@/lib/core/sequences";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * Supplier master, commercial side.
 *
 * The stock module keeps creating suppliers by name (a receiver meeting a new farmer
 * at the gate must not be blocked); this module owns what purchasing and finance
 * need on top: a code, tax registration, payment terms, lead time, contacts — and
 * what each supplier charges, dated, so every purchase can be checked against the
 * price agreed for that day.
 */

export const SUPPLIER_TYPES = ["farm", "grower", "wholesaler", "market_trader", "importer", "packaging", "services", "other"] as const;

const audit = (actor: ServiceActor, a: Omit<AuditInput, "userId" | "userName" | "role" | "source" | "deviceId">): AuditInput => ({
  userId: actor.id,
  userName: actor.name,
  role: actor.role,
  source: "user",
  deviceId: actor.deviceId,
  ...a,
});

const taxId = z
  .string()
  .trim()
  .nullable()
  .transform((v) => (v ? v.replace(/[\s-]/g, "") : null))
  .refine((v) => v === null || /^[0-9]{9}$/.test(v), "رقم التسجيل الضريبي 9 أرقام");
const days = (label: string) => z.number({ invalid_type_error: `${label} لازم يكون رقم` }).int(`${label} أيام صحيحة`).min(0).max(365);

const termsInput = z.object({
  name_ar: optText("اسم المورد بالعربي").optional(),
  type: z.enum(SUPPLIER_TYPES, { errorMap: () => ({ message: "نوع المورد غير معروف" }) }).optional(),
  tax_registration_no: taxId.optional(),
  commercial_reg_no: optText("السجل التجاري", 40).optional(),
  email: optText("الإيميل").optional(),
  city: optText("المدينة", 80).optional(),
  address: optText("العنوان", 500).optional(),
  payment_terms_days: days("مدة السداد").optional(),
  lead_time_days: days("مدة التوريد").nullable().optional(),
  currency_code: egpCurrencyCode.optional(),
  expected_version: version,
});

const FIELDS: [keyof z.infer<typeof termsInput>, keyof Supplier][] = [
  ["name_ar", "nameAr"],
  ["type", "type"],
  ["tax_registration_no", "taxRegistrationNo"],
  ["commercial_reg_no", "commercialRegNo"],
  ["email", "email"],
  ["city", "city"],
  ["address", "address"],
  ["payment_terms_days", "paymentTermsDays"],
  ["lead_time_days", "leadTimeDays"],
  ["currency_code", "currencyCode"],
];

export async function getSupplier(id: string) {
  const s = await prisma.supplier.findUnique({
    where: { id },
    include: { contacts: { orderBy: [{ isPrimary: "desc" }, { name: "asc" }] }, _count: { select: { intakes: true } } },
  });
  if (!s) throw new ApiError(404, "المورد مش موجود");
  return s;
}

export async function listSuppliersFull(opts: { q?: string; includeInactive?: boolean } = {}) {
  const q = opts.q?.trim();
  return prisma.supplier.findMany({
    where: {
      ...(opts.includeInactive ? {} : { active: true }),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }, { code: { contains: q.toUpperCase() } }, { phone: { contains: q } }] } : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    take: 300,
  });
}

/** A new supplier with its commercial terms (the buyer's door; the stock screens keep
 * their quick name-only creation for a farmer arriving unannounced). */
export async function createSupplierFull(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.suppliers.manage");
  const v = parse(termsInput.extend({ code: partyCode.optional(), name: text("اسم المورد"), phone: optText("التليفون", 40).optional(), notes: optText("ملاحظات", 1000).optional() }), input);
  try {
    return await inTx(async (tx) => {
      if (v.code && /^(CUS|SUP)-\d+$/.test(v.code)) throw new ApiError(400, "أكواد CUS-/SUP- برقم محجوزة للترقيم التلقائي — استخدم كودكم أو سيب العمود فاضي");
      if (v.code && (await tx.supplier.findUnique({ where: { code: v.code }, select: { id: true } }))) throw new ApiError(409, `كود المورد ${v.code} مستخدم لمورد تاني`);
      const s = await tx.supplier.create({
        data: {
          code: v.code ?? (await nextDocumentNumber(tx, "purchasing.supplier", todayLocalISO())),
          name: v.name,
          nameAr: v.name_ar ?? null,
          phone: v.phone ?? null,
          notes: v.notes ?? null,
          type: v.type ?? "other",
          taxRegistrationNo: v.tax_registration_no ?? null,
          commercialRegNo: v.commercial_reg_no ?? null,
          email: v.email ?? null,
          city: v.city ?? null,
          address: v.address ?? null,
          paymentTermsDays: v.payment_terms_days ?? 0,
          leadTimeDays: v.lead_time_days ?? null,
          currencyCode: v.currency_code ?? "EGP",
        },
      });
      await writeAudit(audit(actor, { action: "supplier_created", entityType: "supplier", entityId: s.id, newValue: `${s.code} · ${s.name}${s.nameAr ? ` / ${s.nameAr}` : ""}` }), tx);
      return s;
    });
  } catch (err) {
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e?.code === "P2002") throw new ApiError(409, String(e.meta?.target ?? "").includes("tax") ? "الرقم الضريبي ده متسجل لمورد تاني" : `المورد "${v.name}" موجود بالفعل`);
    if (e?.code === "P2003") throw new ApiError(400, "العملة مش معروفة");
    throw err;
  }
}

export async function updateSupplierTerms(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.suppliers.manage");
  const v = parse(termsInput, input);
  try {
    return await inTx(async (tx) => {
      const cur = await tx.supplier.findUnique({ where: { id } });
      if (!cur) throw new ApiError(404, "المورد مش موجود");
      if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "بيانات المورد اتغيرت، حدّث الشاشة");
      const data: Record<string, unknown> = {};
      const audits: AuditInput[] = [];
      for (const [k, col] of FIELDS) {
        if (v[k] === undefined) continue;
        const next = v[k] as unknown;
        const prev = cur[col] as unknown;
        if (next === prev) continue;
        data[col] = next;
        audits.push(audit(actor, { action: "supplier_terms_changed", entityType: "supplier", entityId: id, fieldChanged: col, oldValue: prev == null ? null : String(prev), newValue: next == null ? null : String(next) }));
      }
      if (!audits.length) return cur;
      let updated: Supplier;
      try {
        updated = await tx.supplier.update({ where: { id, version: cur.version }, data: { ...data, version: { increment: 1 } } });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "بيانات المورد اتغيرت، حدّث الشاشة");
        throw err;
      }
      await writeAuditMany(audits, tx);
      return updated;
    });
  } catch (err) {
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e?.code === "P2002") throw new ApiError(409, "الرقم الضريبي ده متسجل لمورد تاني");
    if (e?.code === "P2003") throw new ApiError(400, "العملة مش معروفة");
    throw err;
  }
}

const contactInput = z.object({
  name: text("اسم جهة الاتصال"),
  role: optText("الوظيفة", 80).optional(),
  phone: optText("التليفون", 40).optional(),
  email: optText("الإيميل").optional(),
  is_primary: z.boolean().optional(),
  active: active().optional(),
  expected_version: version,
});

export async function saveSupplierContact(supplierId: string, contactId: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.suppliers.manage");
  const v = parse(contactInput, input);
  return inTx(async (tx) => {
    const s = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!s) throw new ApiError(404, "المورد مش موجود");
    if (v.is_primary) await tx.supplierContact.updateMany({ where: { supplierId, isPrimary: true, ...(contactId ? { id: { not: contactId } } : {}) }, data: { isPrimary: false, version: { increment: 1 } } });
    const data = { name: v.name, role: v.role ?? null, phone: v.phone ?? null, email: v.email ?? null, isPrimary: v.is_primary ?? false, active: v.active ?? true };
    let row;
    if (contactId) {
      const cur = await tx.supplierContact.findUnique({ where: { id: contactId } });
      if (!cur || cur.supplierId !== supplierId) throw new ApiError(404, "جهة الاتصال مش موجودة");
      if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "جهة الاتصال اتغيرت، حدّث الشاشة");
      row = await tx.supplierContact.update({ where: { id: contactId }, data: { ...data, version: { increment: 1 } } });
    } else {
      row = await tx.supplierContact.create({ data: { supplierId, ...data } });
    }
    await writeAudit(audit(actor, { action: contactId ? "supplier_contact_edited" : "supplier_contact_added", entityType: "supplier", entityId: supplierId, fieldChanged: "contact", newValue: `${row.name}${row.phone ? ` · ${row.phone}` : ""}` }), tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Supplier prices
// ---------------------------------------------------------------------------

const money4 = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "السعر لازم يكون رقم موجب بحد أقصى 4 خانات عشرية" });
    return z.NEVER;
  }
  return new Prisma.Decimal(s);
});

const pricesInput = z.object({
  valid_from: z.string().refine(isValidISODate, "تاريخ بداية السعر لازم يكون YYYY-MM-DD"),
  valid_to: z.string().refine(isValidISODate, "تاريخ النهاية لازم يكون YYYY-MM-DD").nullable().optional(),
  prices: z
    .array(z.object({ product_id: text("الصنف"), uom: z.string().trim().optional(), unit_price: money4, lead_time_days: days("مدة التوريد").optional(), notes: optText("ملاحظة").optional() }))
    .min(1, "مفيش أسعار")
    .max(500),
});

/** Records agreed prices from a date. A same-day correction replaces a row only while
 * no purchase order line has been priced from it. */
export async function setSupplierPrices(supplierId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.prices.manage");
  const v = parse(pricesInput, input);
  if (v.valid_to && v.valid_to < v.valid_from) throw new ApiError(400, "تاريخ النهاية قبل البداية");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `purchasing:supplier-prices:${supplierId}`);
    const s = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!s) throw new ApiError(404, "المورد مش موجود");
    if (!s.active) throw new ApiError(400, "المورد موقوف");
    const audits: AuditInput[] = [];
    let created = 0;
    let replaced = 0;
    for (const p of v.prices) {
      const product = await tx.stockProduct.findUnique({ where: { id: p.product_id }, include: { packagings: true } });
      if (!product) throw new ApiError(404, "الصنف مش موجود");
      const uom = p.uom || product.unit;
      if (uom !== product.unit && !product.packagings.some((x) => x.uomCode === uom && x.active)) {
        const u = await tx.unitOfMeasure.findUnique({ where: { code: uom } });
        const base = await tx.unitOfMeasure.findUnique({ where: { code: product.unit } });
        if (!u || !base || u.category !== base.category || u.category === "package") throw new ApiError(400, `الوحدة ${uom} مش متعرّفة للصنف "${product.name}"`);
      }
      const key = { supplierId_productId_uomCode_validFrom: { supplierId, productId: product.id, uomCode: uom, validFrom: v.valid_from } };
      const existing = await tx.supplierPrice.findUnique({ where: key });
      if (existing) {
        if (existing.unitPrice.equals(p.unit_price) && existing.validTo === (v.valid_to ?? null)) continue;
        const used = await tx.purchaseOrderLine.count({ where: { supplierPriceId: existing.id } });
        if (used) throw new ApiError(409, `سعر "${product.name}" من ${v.valid_from} اتعمل بيه أوامر شراء — سجّل السعر الجديد من تاريخ بعده`);
        await tx.supplierPrice.update({ where: { id: existing.id }, data: { unitPrice: p.unit_price, validTo: v.valid_to ?? null, leadTimeDays: p.lead_time_days ?? null, notes: p.notes ?? null, createdById: actor.id, createdBy: actor.name } });
        audits.push(audit(actor, { action: "supplier_price_corrected", entityType: "supplier", entityId: supplierId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, oldValue: existing.unitPrice.toString(), newValue: p.unit_price.toString() }));
        replaced++;
      } else {
        await tx.supplierPrice.create({
          data: { supplierId, productId: product.id, uomCode: uom, unitPrice: p.unit_price, currencyCode: s.currencyCode, validFrom: v.valid_from, validTo: v.valid_to ?? null, leadTimeDays: p.lead_time_days ?? null, notes: p.notes ?? null, createdById: actor.id, createdBy: actor.name },
        });
        audits.push(audit(actor, { action: "supplier_price_set", entityType: "supplier", entityId: supplierId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, newValue: p.unit_price.toString() }));
        created++;
      }
    }
    await writeAuditMany(audits, tx);
    return { created, replaced };
  });
}

type PriceDb = Pick<Tx, "supplierPrice" | "unitOfMeasure" | "productPackaging">;

/**
 * What a supplier charges for one `uom` of a product on a date: a price set for that
 * unit, else the base-unit price × the unit's size. Null when there is no agreed price.
 */
export async function effectiveSupplierPrice(db: PriceDb, input: { supplierId: string; product: { id: string; name: string; unit: string }; uom: string; date: string }) {
  const rows = await db.supplierPrice.findMany({
    where: {
      supplierId: input.supplierId,
      productId: input.product.id,
      uomCode: { in: [...new Set([input.uom, input.product.unit])] },
      validFrom: { lte: input.date },
      OR: [{ validTo: null }, { validTo: { gte: input.date } }],
    },
    orderBy: { validFrom: "desc" },
  });
  const exact = rows.find((r) => r.uomCode === input.uom);
  if (exact) return { row: exact, unitPrice: exact.unitPrice };
  const base = rows.find((r) => r.uomCode === input.product.unit);
  if (!base) return null;
  try {
    const factor = await toBaseQuantity(db, input.product, new Prisma.Decimal(1), input.uom);
    return { row: base, unitPrice: base.unitPrice.times(factor).toDecimalPlaces(4) };
  } catch {
    return null;
  }
}

/** Every supplier's current price for a product (per base unit), cheapest first —
 * the comparison a buyer makes before an RFQ or a purchase order. */
export async function productSupplierPrices(productId: string, date = todayLocalISO()) {
  const product = await prisma.stockProduct.findUnique({ where: { id: productId } });
  if (!product) throw new ApiError(404, "الصنف مش موجود");
  const rows = await prisma.supplierPrice.findMany({
    where: { productId, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }], supplier: { active: true } },
    orderBy: [{ supplierId: "asc" }, { uomCode: "asc" }, { validFrom: "desc" }],
    include: { supplier: { select: { id: true, code: true, name: true, nameAr: true, leadTimeDays: true, paymentTermsDays: true } } },
  });
  const seen = new Set<string>();
  const current = rows.filter((r) => {
    const k = `${r.supplierId}|${r.uomCode}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { product: { id: product.id, name: product.name, unit: product.unit }, date, prices: current.sort((a, b) => Number(a.unitPrice.minus(b.unitPrice))) };
}

export async function supplierPriceHistory(supplierId: string) {
  return prisma.supplierPrice.findMany({
    where: { supplierId },
    orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }],
    take: 300,
    include: { product: { select: { name: true, nameAr: true, unit: true } } },
  });
}
