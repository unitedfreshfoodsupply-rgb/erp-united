import { Prisma, type Supplier, type SupplierPrice } from "@prisma/client";
import { partyCode } from "@/lib/sales/customers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany, type AuditInput } from "@/lib/audit";
import { actorCan, assertPermission, forbiddenMessage } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { active, optText, parse, text, version } from "@/lib/core/validation";
import { egpCurrencyCode } from "@/lib/core/currency";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { nextDocumentNumber } from "@/lib/core/sequences";
import type { ServiceActor } from "@/lib/core/actor";
import { searchIds } from "@/lib/core/search";

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
/**
 * The business's two supplier categories (Nov 2026). Every supplier created or edited here is
 * classified; NULL exists only for a supplier the stock gate added on the spot (createSupplier in
 * lib/stock-service.ts), which stays visibly "unclassified" until purchasing classifies it, and a
 * classified supplier cannot be made unclassified again (decision D-1).
 */
export const SUPPLIER_CATEGORIES = ["vegetable", "fruit", "other"] as const;
const category = z.enum(SUPPLIER_CATEGORIES, {
  errorMap: (issue) => ({ message: issue.code === "invalid_type" ? "فئة المورد مطلوبة — اختار خضار أو فاكهة أو أخرى/خدمات" : "فئة المورد لازم خضار أو فاكهة أو أخرى/خدمات" }),
});

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
  category: category.optional(),
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
  ["category", "category"],
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

export async function listSuppliersFull(opts: { q?: string; includeInactive?: boolean; type?: string; category?: string } = {}) {
  const q = opts.q?.trim();
  return prisma.supplier.findMany({
    where: {
      ...(opts.includeInactive ? {} : { active: true }),
      ...(opts.type ? { type: opts.type as never } : {}),
      // "none" = not classified yet; an unknown value filters nothing rather than matching nothing.
      ...(opts.category === "none" ? { category: null } : (SUPPLIER_CATEGORIES as readonly string[]).includes(opts.category ?? "") ? { category: opts.category } : {}),
      ...(q ? { OR: [{ id: { in: await searchIds("supplier", q) } }, { name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }, { code: { contains: q.toUpperCase() } }, { phone: { contains: q } }] } : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    take: 300,
  });
}

/** A new supplier with its commercial terms (the buyer's door; the stock screens keep
 * their quick name-only creation for a farmer arriving unannounced). */
export async function createSupplierFull(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.suppliers.manage");
  const v = parse(termsInput.extend({ code: partyCode.optional(), name: text("اسم المورد"), phone: optText("التليفون", 40).optional(), notes: optText("ملاحظات", 1000).optional(), category }), input);
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
          category: v.category,
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

/** Identity fields the stock screens may also edit (a receiver correcting a farmer's name or
 * phone at the gate); every other supplier attribute is purchasing's. */
const BASIC_FIELDS: [keyof z.infer<typeof masterInput>, keyof Supplier][] = [
  ["name", "name"],
  ["phone", "phone"],
  ["notes", "notes"],
  ["active", "active"],
];
const masterInput = termsInput.extend({
  name: text("اسم المورد").optional(),
  phone: optText("التليفون", 40).optional(),
  notes: optText("ملاحظات", 1000).optional(),
  active: active().optional(),
});

/**
 * The one way to change a supplier's master data (Nov 2026). Every screen and route — the
 * supplier profile, the purchasing list, the stock setup panel — comes here, so a change is
 * made once, checked once and audited field by field. The permission rule lives here, not in
 * the routes: name, phone, notes and active with purchasing.suppliers.manage or
 * stock.manage_suppliers; anything else with purchasing.suppliers.manage.
 */
export async function updateSupplierMaster(id: string, input: unknown, actor: ServiceActor) {
  if (!actorCan(actor, "purchasing.suppliers.manage") && !actorCan(actor, "stock.manage_suppliers")) throw new ApiError(403, forbiddenMessage(["purchasing.suppliers.manage"]));
  const v = parse(masterInput, input);
  const basicKeys = new Set(BASIC_FIELDS.map(([k]) => k));
  if (FIELDS.some(([k]) => v[k] !== undefined && !basicKeys.has(k))) assertPermission(actor, "purchasing.suppliers.manage");
  try {
    return await inTx(async (tx) => {
      const cur = await tx.supplier.findUnique({ where: { id } });
      if (!cur) throw new ApiError(404, "المورد مش موجود");
      if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "بيانات المورد اتغيرت، حدّث الشاشة");
      const data: Record<string, unknown> = {};
      const audits: AuditInput[] = [];
      for (const [k, col] of [...BASIC_FIELDS, ...FIELDS]) {
        if (v[k] === undefined) continue;
        const next = v[k] as unknown;
        const prev = cur[col] as unknown;
        if (next === prev) continue;
        data[col] = next;
        // The two action names already in the history: identity edits and commercial terms.
        const action = basicKeys.has(k) ? "supplier_updated" : "supplier_terms_changed";
        audits.push(audit(actor, { action, entityType: "supplier", entityId: id, fieldChanged: col, oldValue: prev == null ? null : String(prev), newValue: next == null ? null : String(next) }));
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
    if (e?.code === "P2002") throw new ApiError(409, String(e.meta?.target ?? "").includes("tax") ? "الرقم الضريبي ده متسجل لمورد تاني" : "فيه مورد بنفس الاسم");
    if (e?.code === "P2003") throw new ApiError(400, "العملة مش معروفة");
    throw err;
  }
}

/** The purchasing route's name for the same single editor. */
export const updateSupplierTerms = updateSupplierMaster;

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
    // Read once for every line (Nov 2026: one product at a time was ~4 statements per price, and
    // a few hundred prices ran past the 20 s limit), then decide the lines in their order exactly
    // as one at a time: a later line for the same product and unit corrects the earlier one.
    const productIds = [...new Set(v.prices.map((p) => p.product_id))];
    const [products, existingRows] = await Promise.all([
      tx.stockProduct.findMany({ where: { id: { in: productIds } }, include: { packagings: true } }),
      tx.supplierPrice.findMany({ where: { supplierId, validFrom: v.valid_from, productId: { in: productIds } } }),
    ]);
    const productBy = new Map(products.map((p) => [p.id, p]));
    const uomCodes = new Set<string>();
    for (const p of v.prices) {
      const product = productBy.get(p.product_id);
      if (product && p.uom && p.uom !== product.unit) uomCodes.add(p.uom).add(product.unit);
    }
    const [units, usage] = await Promise.all([
      uomCodes.size ? tx.unitOfMeasure.findMany({ where: { code: { in: [...uomCodes] } } }) : [],
      existingRows.length ? tx.purchaseOrderLine.groupBy({ by: ["supplierPriceId"], where: { supplierPriceId: { in: existingRows.map((r) => r.id) } }, _count: { _all: true } }) : [],
    ]);
    const unitBy = new Map(units.map((u) => [u.code, u]));
    const used = new Set(usage.filter((u) => u._count._all > 0).map((u) => u.supplierPriceId));
    type Row = { id: string | null; productId: string; uomCode: string; unitPrice: Prisma.Decimal; validTo: string | null; leadTimeDays: number | null; notes: string | null; dirty: boolean };
    const rows = new Map<string, Row>(existingRows.map((r) => [`${r.productId}|${r.uomCode}`, { id: r.id, productId: r.productId, uomCode: r.uomCode, unitPrice: r.unitPrice, validTo: r.validTo, leadTimeDays: r.leadTimeDays, notes: r.notes, dirty: false }]));
    const audits: AuditInput[] = [];
    let created = 0;
    let replaced = 0;
    for (const p of v.prices) {
      const product = productBy.get(p.product_id);
      if (!product) throw new ApiError(404, "الصنف مش موجود");
      const uom = p.uom || product.unit;
      if (uom !== product.unit && !product.packagings.some((x) => x.uomCode === uom && x.active)) {
        const u = unitBy.get(uom);
        const base = unitBy.get(product.unit);
        if (!u || !base || u.category !== base.category || u.category === "package") throw new ApiError(400, `الوحدة ${uom} مش متعرّفة للصنف "${product.name}"`);
      }
      const key = `${product.id}|${uom}`;
      const existing = rows.get(key);
      const values = { unitPrice: p.unit_price, validTo: v.valid_to ?? null, leadTimeDays: p.lead_time_days ?? null, notes: p.notes ?? null };
      if (existing) {
        if (existing.unitPrice.equals(p.unit_price) && existing.validTo === (v.valid_to ?? null)) continue;
        if (existing.id && used.has(existing.id)) throw new ApiError(409, `سعر "${product.name}" من ${v.valid_from} اتعمل بيه أوامر شراء — سجّل السعر الجديد من تاريخ بعده`);
        audits.push(audit(actor, { action: "supplier_price_corrected", entityType: "supplier", entityId: supplierId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, oldValue: existing.unitPrice.toString(), newValue: p.unit_price.toString() }));
        rows.set(key, { ...existing, ...values, dirty: true });
        replaced++;
      } else {
        audits.push(audit(actor, { action: "supplier_price_set", entityType: "supplier", entityId: supplierId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, newValue: p.unit_price.toString() }));
        rows.set(key, { id: null, productId: product.id, uomCode: uom, ...values, dirty: true });
        created++;
      }
    }
    const fresh = [...rows.values()].filter((r) => r.dirty && !r.id);
    if (fresh.length) {
      await tx.supplierPrice.createMany({
        data: fresh.map((r) => ({ supplierId, productId: r.productId, uomCode: r.uomCode, unitPrice: r.unitPrice, currencyCode: s.currencyCode, validFrom: v.valid_from, validTo: r.validTo, leadTimeDays: r.leadTimeDays, notes: r.notes, createdById: actor.id, createdBy: actor.name })),
      });
    }
    const corrected = [...rows.values()].filter((r) => r.dirty && r.id);
    if (corrected.length) {
      const values = corrected.map((r) => Prisma.sql`(${r.id}::text, ${r.unitPrice.toString()}::numeric, ${r.validTo}::text, ${r.leadTimeDays}::int, ${r.notes}::text)`);
      await tx.$executeRaw`
        UPDATE "SupplierPrice" AS p SET "unitPrice" = v.unit_price, "validTo" = v.valid_to, "leadTimeDays" = v.lead_time_days, "notes" = v.notes,
          "createdById" = ${actor.id}::text, "createdBy" = ${actor.name}::text
        FROM (VALUES ${Prisma.join(values)}) AS v(id, unit_price, valid_to, lead_time_days, notes)
        WHERE p."id" = v.id`;
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

/**
 * effectiveSupplierPrice in each product's own unit, for many (product, date) pairs of one
 * supplier in one read (Nov 2026: a bill of 300 walk-in receipts read them one by one). The
 * same row: the latest valid on that date.
 */
export async function supplierPricesOn(db: Pick<Tx, "supplierPrice">, supplierId: string, wanted: { key: string; product: { id: string; unit: string }; date: string }[]) {
  const out = new Map<string, { row: SupplierPrice; unitPrice: Prisma.Decimal } | null>();
  if (!wanted.length) return out;
  const dates = wanted.map((w) => w.date).sort();
  const rows = await db.supplierPrice.findMany({
    where: {
      supplierId,
      productId: { in: [...new Set(wanted.map((w) => w.product.id))] },
      uomCode: { in: [...new Set(wanted.map((w) => w.product.unit))] },
      validFrom: { lte: dates[dates.length - 1] },
      OR: [{ validTo: null }, { validTo: { gte: dates[0] } }],
    },
    orderBy: { validFrom: "desc" },
  });
  for (const w of wanted) {
    const row = rows.find((r) => r.productId === w.product.id && r.uomCode === w.product.unit && r.validFrom <= w.date && (r.validTo === null || r.validTo >= w.date));
    out.set(w.key, row ? { row, unitPrice: row.unitPrice } : null);
  }
  return out;
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
