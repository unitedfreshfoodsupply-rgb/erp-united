import { evaluateOrderPricing } from "@/lib/sales/price-exceptions";
import { Prisma, type PriceList } from "@prisma/client";
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
import type { ServiceActor } from "@/lib/core/actor";
import { amountsJSON, lineAmounts, sumAmounts } from "@/lib/sales/money";
import { unitLookups } from "@/lib/sales/stock-commitment";

/**
 * Pricing.
 *
 * Price lists hold DATED prices: a new price is a new row from its date, never an
 * edit, so "what did mango cost this hotel on the 3rd" always has an answer — fresh
 * produce prices move daily. A same-day correction may replace a row only while no
 * order line has been priced from it.
 *
 * An order line is priced from the customer's list (or the default list) for the
 * delivery date, converted to the line's unit through the product's packaging, and
 * taxed by the product's tax class. A person with sales.price_override may set a
 * line's price by hand, with a reason; repricing never touches a manual price.
 *
 * Prices live in OrderItemPrice, outside the order line itself, so the floor
 * endpoints (which return lines as they are) never carry them.
 */

type Actorish = { id: string | null; name: string; role: string; deviceId?: string; permissions: readonly string[] };

const audit = (actor: Actorish, a: Omit<AuditInput, "userId" | "userName" | "role" | "source" | "deviceId">): AuditInput => ({
  userId: actor.id,
  userName: actor.name,
  role: actor.role,
  source: "user",
  deviceId: actor.deviceId,
  ...a,
});

const money4 = (label: string) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d+(\.\d{1,4})?$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون رقم موجب بحد أقصى 4 خانات عشرية` });
      return z.NEVER;
    }
    return new Prisma.Decimal(s);
  });
const pct = (label: string) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون بين 0 و 100` });
      return z.NEVER;
    }
    return new Prisma.Decimal(s);
  });
const isoDate = (label: string) => z.string().refine(isValidISODate, `${label} لازم يكون تاريخ YYYY-MM-DD`);

// ---------------------------------------------------------------------------
// Price lists
// ---------------------------------------------------------------------------

const listCreate = z.object({
  code: z.string().trim().transform((v) => v.toUpperCase()).refine((v) => /^[A-Z0-9][A-Z0-9_-]*$/.test(v), "الكود حروف إنجليزي كبيرة وأرقام و - أو _"),
  name: text("اسم القائمة"),
  currency_code: egpCurrencyCode.optional(),
  is_default: z.boolean().optional(),
});
const listUpdate = z.object({ name: text("اسم القائمة").optional(), is_default: z.boolean().optional(), active: active().optional(), expected_version: version });

export async function listPriceLists() {
  return prisma.priceList.findMany({ orderBy: [{ isDefault: "desc" }, { code: "asc" }], include: { _count: { select: { customers: true, items: true } } } });
}

export async function createPriceList(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.pricing.manage");
  const v = parse(listCreate, input);
  try {
    return await inTx(async (tx) => {
      await advisoryXactLock(tx, "sales:price-list-default");
      if (v.is_default) await tx.priceList.updateMany({ where: { isDefault: true }, data: { isDefault: false, version: { increment: 1 } } });
      const pl = await tx.priceList.create({
        data: { code: v.code, name: v.name, currencyCode: v.currency_code ?? "EGP", isDefault: v.is_default ?? false, createdById: actor.id, createdBy: actor.name },
      });
      await writeAudit(audit(actor, { action: "price_list_created", entityType: "price_list", entityId: pl.id, newValue: `${pl.code} · ${pl.name}${pl.isDefault ? " (افتراضية)" : ""}` }), tx);
      return pl;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") throw new ApiError(409, "كود القائمة مستخدم");
    if ((err as { code?: string })?.code === "P2003") throw new ApiError(400, "العملة مش معروفة");
    throw err;
  }
}

export async function updatePriceList(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.pricing.manage");
  const v = parse(listUpdate, input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "sales:price-list-default");
    const cur = await tx.priceList.findUnique({ where: { id } });
    if (!cur) throw new ApiError(404, "قائمة الأسعار مش موجودة");
    if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "القائمة اتغيرت، حدّث الشاشة");
    const nextActive = v.active ?? cur.active;
    const nextDefault = v.is_default ?? cur.isDefault;
    if (nextDefault && !nextActive) throw new ApiError(400, "القائمة الافتراضية لازم تكون شغالة");
    if (v.active === false && cur.isDefault && v.is_default !== false) throw new ApiError(400, "اختار قائمة افتراضية تانية الأول");
    if (nextDefault && !cur.isDefault) await tx.priceList.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false, version: { increment: 1 } } });
    const changes: AuditInput[] = [];
    if (v.name !== undefined && v.name !== cur.name) changes.push(audit(actor, { action: "price_list_edited", entityType: "price_list", entityId: id, fieldChanged: "name", oldValue: cur.name, newValue: v.name }));
    if (nextDefault !== cur.isDefault) changes.push(audit(actor, { action: "price_list_edited", entityType: "price_list", entityId: id, fieldChanged: "isDefault", oldValue: String(cur.isDefault), newValue: String(nextDefault) }));
    if (nextActive !== cur.active) changes.push(audit(actor, { action: "price_list_edited", entityType: "price_list", entityId: id, fieldChanged: "active", oldValue: String(cur.active), newValue: String(nextActive) }));
    if (!changes.length) return cur;
    let pl: PriceList;
    try {
      pl = await tx.priceList.update({ where: { id, version: cur.version }, data: { name: v.name ?? cur.name, isDefault: nextDefault, active: nextActive, version: { increment: 1 } } });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "القائمة اتغيرت، حدّث الشاشة");
      throw err;
    }
    await writeAuditMany(changes, tx);
    return pl;
  });
}

/** Each product's effective price(s) in a list on a date, plus the price history. */
export async function priceListDetail(id: string, date = todayLocalISO()) {
  const pl = await prisma.priceList.findUnique({ where: { id } });
  if (!pl) throw new ApiError(404, "قائمة الأسعار مش موجودة");
  const items = await prisma.priceListItem.findMany({
    where: { priceListId: id },
    orderBy: [{ productId: "asc" }, { uomCode: "asc" }, { validFrom: "desc" }],
    include: { product: { select: { id: true, name: true, nameAr: true, unit: true } } },
  });
  const current = new Map<string, (typeof items)[number]>();
  for (const it of items) {
    const key = `${it.productId}|${it.uomCode}`;
    if (current.has(key)) continue;
    if (it.validFrom <= date && (!it.validTo || it.validTo >= date)) current.set(key, it);
  }
  // The catalogue the list prices: names, units, tax class and packagings only — no
  // stock figures (sales pricing does not grant a view of the warehouse).
  const products = await prisma.stockProduct.findMany({
    where: { active: true, stockTracked: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, nameAr: true, unit: true, salesTaxCode: true, packagings: { where: { active: true }, select: { uomCode: true, qtyInBaseUnit: true } } },
  });
  return { priceList: pl, date, current: [...current.values()], history: items.slice(0, 500), products };
}

const pricesInput = z.object({
  valid_from: isoDate("تاريخ بداية السعر"),
  valid_to: isoDate("تاريخ نهاية السعر").nullable().optional(),
  prices: z
    .array(z.object({ product_id: text("الصنف"), uom: z.string().trim().optional(), unit_price: money4("السعر") }))
    .min(1, "مفيش أسعار")
    .max(1000, "أسعار كتير في مرة واحدة"),
  reason: optText("ملاحظة", 500).optional(),
});

/**
 * The daily price update: one row per product (and unit) from a date. Re-sending the
 * same (product, unit, date) replaces that row only if no order line has been priced
 * from it yet — once a price has been used, it is history.
 */
export async function setPrices(priceListId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.pricing.manage");
  const v = parse(pricesInput, input);
  if (v.valid_to && v.valid_to < v.valid_from) throw new ApiError(400, "تاريخ النهاية قبل البداية");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `sales:price-list:${priceListId}`);
    const pl = await tx.priceList.findUnique({ where: { id: priceListId } });
    if (!pl) throw new ApiError(404, "قائمة الأسعار مش موجودة");
    if (!pl.active) throw new ApiError(400, "القائمة موقوفة");
    // Every product, unit and existing row the prices touch, read at once (PW-4, Nov 2026: ~4
    // round trips per price — a daily update of ~130+ prices ran past 20 s and saved nothing).
    // The prices are then applied in order exactly as one by one: a (product, unit) sent twice is
    // created by its first occurrence and corrected by the next, the same counts and audit rows,
    // the same first refusal; the rows are written at the end in two statements.
    const productIds = [...new Set(v.prices.map((p) => p.product_id))];
    const products = new Map((await tx.stockProduct.findMany({ where: { id: { in: productIds } }, include: { packagings: true } })).map((x) => [x.id, x]));
    const undeclared = v.prices.flatMap((p) => {
      const product = products.get(p.product_id);
      const uom = p.uom || product?.unit;
      return product && uom && uom !== product.unit && !product.packagings.some((x) => x.uomCode === uom && x.active) ? [uom, product.unit] : [];
    });
    const units = new Map((undeclared.length ? await tx.unitOfMeasure.findMany({ where: { code: { in: [...new Set(undeclared)] } } }) : []).map((u) => [u.code, u]));
    const rows = await tx.priceListItem.findMany({ where: { priceListId, validFrom: v.valid_from, productId: { in: productIds } } });
    const usedBy = new Map((rows.length ? await tx.orderItemPrice.groupBy({ by: ["priceListItemId"], where: { priceListItemId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }) : []).map((g) => [g.priceListItemId!, g._count._all]));
    // The (product, unit) rows of that date as the loop sees them: stored, or created by an earlier price of this request.
    const current = new Map<string, { id: string | null; productId: string; uom: string; unitPrice: Prisma.Decimal; validTo: string | null; changed: boolean }>(
      rows.map((r) => [`${r.productId}|${r.uomCode}`, { id: r.id, productId: r.productId, uom: r.uomCode, unitPrice: r.unitPrice, validTo: r.validTo, changed: false }])
    );
    const validTo = v.valid_to ?? null;
    const audits: AuditInput[] = [];
    let created = 0;
    let replaced = 0;
    for (const p of v.prices) {
      const product = products.get(p.product_id);
      if (!product) throw new ApiError(404, "الصنف مش موجود");
      const uom = p.uom || product.unit;
      if (uom !== product.unit && !product.packagings.some((x) => x.uomCode === uom && x.active)) {
        const u = units.get(uom);
        const base = units.get(product.unit);
        if (!u || !base || u.category !== base.category || u.category === "package") throw new ApiError(400, `الوحدة ${uom} مش متعرّفة للصنف "${product.name}"`);
      }
      const existing = current.get(`${product.id}|${uom}`);
      if (existing) {
        if (existing.unitPrice.equals(p.unit_price) && existing.validTo === validTo) continue;
        const used = existing.id ? usedBy.get(existing.id) ?? 0 : 0;
        if (used) throw new ApiError(409, `سعر "${product.name}" من ${v.valid_from} اتسعّر بيه أوردرات بالفعل — حط السعر الجديد من تاريخ بعده`);
        audits.push(audit(actor, { action: "price_corrected", entityType: "price_list", entityId: priceListId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, oldValue: existing.unitPrice.toString(), newValue: p.unit_price.toString(), reason: v.reason ?? undefined }));
        Object.assign(existing, { unitPrice: p.unit_price, validTo, changed: true });
        replaced++;
      } else {
        current.set(`${product.id}|${uom}`, { id: null, productId: product.id, uom, unitPrice: p.unit_price, validTo, changed: true });
        audits.push(audit(actor, { action: "price_set", entityType: "price_list", entityId: priceListId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, newValue: p.unit_price.toString(), reason: v.reason ?? undefined }));
        created++;
      }
    }
    const fresh = [...current.values()].filter((r) => !r.id);
    if (fresh.length) {
      await tx.priceListItem.createMany({
        data: fresh.map((r) => ({ priceListId, productId: r.productId, uomCode: r.uom, unitPrice: r.unitPrice, validFrom: v.valid_from, validTo: r.validTo, createdById: actor.id, createdBy: actor.name })),
      });
    }
    const corrected = [...current.values()].filter((r) => r.id && r.changed);
    if (corrected.length) {
      // What tx.priceListItem.update wrote for each corrected row, all rows in one statement.
      const values = Prisma.join(corrected.map((r) => Prisma.sql`(${r.id}, ${r.unitPrice.toString()}::numeric)`));
      await tx.$executeRaw`
        UPDATE "PriceListItem" AS p SET "unitPrice" = v.unit_price, "validTo" = ${validTo}, "createdById" = ${actor.id}, "createdBy" = ${actor.name}
        FROM (VALUES ${values}) AS v(id, unit_price) WHERE p."id" = v.id`;
    }
    await writeAuditMany(audits, tx);
    return { created, replaced };
  });
}

// ---------------------------------------------------------------------------
// Price resolution
// ---------------------------------------------------------------------------

type PriceDb = Pick<Tx, "priceList" | "priceListItem" | "unitOfMeasure" | "productPackaging" | "customer">;

export async function priceListFor(db: PriceDb, customerId: string | null): Promise<PriceList | null> {
  return (await priceListsFor(db, customerId))[0] ?? null;
}

/** The lists a customer is priced from, in order: its own list (special prices),
 * then the default list for anything its own list does not price. */
export async function priceListsFor(db: PriceDb, customerId: string | null): Promise<PriceList[]> {
  const out: PriceList[] = [];
  if (customerId) {
    const c = await db.customer.findUnique({ where: { id: customerId }, include: { priceList: true } });
    if (c?.priceList?.active) out.push(c.priceList);
  }
  const def = await db.priceList.findFirst({ where: { isDefault: true, active: true } });
  if (def && !out.some((l) => l.id === def.id)) out.push(def);
  return out;
}

/**
 * The price of one unit of `lineUom` of a product on a date, from a list: a price
 * set for that unit itself, else the base-unit price × the unit's size (a crate of
 * 18 kg at 20/kg is 360). Null when the list has no price for the product that day.
 */
export async function effectivePrice(
  db: PriceDb,
  input: { priceListId: string; product: { id: string; name: string; unit: string }; lineUom: string; date: string }
) {
  const rows = await db.priceListItem.findMany({
    where: {
      priceListId: input.priceListId,
      productId: input.product.id,
      uomCode: { in: [...new Set([input.lineUom, input.product.unit])] },
      validFrom: { lte: input.date },
      OR: [{ validTo: null }, { validTo: { gte: input.date } }],
    },
    orderBy: { validFrom: "desc" },
  });
  const exact = rows.find((r) => r.uomCode === input.lineUom);
  if (exact) return { item: exact, unitPrice: exact.unitPrice };
  const base = rows.find((r) => r.uomCode === input.product.unit);
  if (!base) return null;
  let factor: Prisma.Decimal;
  try {
    factor = await toBaseQuantity(db, input.product, new Prisma.Decimal(1), input.lineUom);
  } catch {
    return null; // the line's unit does not convert: it stays unpriced for a person
  }
  return { item: base, unitPrice: base.unitPrice.times(factor).toDecimalPlaces(4) };
}

/**
 * effectivePrice for many lines at once (PW-2, Nov 2026: an order priced one line at a time cost
 * a query or more per line, inside its creating transaction). One read of every candidate price
 * row; the same rule per (list, line): the price set for the line's unit, else the base-unit price
 * × the unit's size, else null. Result `[i][j]` is line i in list j.
 */
export async function effectivePrices(
  db: PriceDb,
  lists: { id: string }[],
  lines: { product: { id: string; name: string; unit: string }; lineUom: string }[],
  date: string
): Promise<(Awaited<ReturnType<typeof effectivePrice>>)[][]> {
  if (!lines.length || !lists.length) return lines.map(() => lists.map(() => null));
  const rows = await db.priceListItem.findMany({
    where: {
      priceListId: { in: lists.map((l) => l.id) },
      productId: { in: [...new Set(lines.map((l) => l.product.id))] },
      uomCode: { in: [...new Set(lines.flatMap((l) => [l.lineUom, l.product.unit]))] },
      validFrom: { lte: date },
      OR: [{ validTo: null }, { validTo: { gte: date } }],
    },
    orderBy: { validFrom: "desc" },
  });
  // Newest first, as effectivePrice reads them.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.priceListId}|${r.productId}|${r.uomCode}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  // A base-unit price converted to the line's unit needs the units (only then are they read).
  const converting = lines.filter((l) => l.lineUom !== l.product.unit && lists.some((list) => !latest.has(`${list.id}|${l.product.id}|${l.lineUom}`) && latest.has(`${list.id}|${l.product.id}|${l.product.unit}`)));
  const units = converting.length ? await unitLookups(db, converting.flatMap((l) => [l.lineUom, l.product.unit]), converting.map((l) => l.product.id)) : null;
  const out: (Awaited<ReturnType<typeof effectivePrice>>)[][] = [];
  for (const l of lines) {
    const perList: (Awaited<ReturnType<typeof effectivePrice>>)[] = [];
    for (const list of lists) {
      const exact = latest.get(`${list.id}|${l.product.id}|${l.lineUom}`);
      if (exact) {
        perList.push({ item: exact, unitPrice: exact.unitPrice });
        continue;
      }
      const base = latest.get(`${list.id}|${l.product.id}|${l.product.unit}`);
      if (!base) {
        perList.push(null);
        continue;
      }
      let factor: Prisma.Decimal;
      try {
        factor = await toBaseQuantity(units ?? db, l.product, new Prisma.Decimal(1), l.lineUom);
      } catch {
        perList.push(null); // the line's unit does not convert: it stays unpriced for a person
        continue;
      }
      perList.push({ item: base, unitPrice: base.unitPrice.times(factor).toDecimalPlaces(4) });
    }
    out.push(perList);
  }
  return out;
}

/** Prices for grade A and grade B products at a given date, from the active default
 * price list. Returns null for unpriced products (caller handles via fallback). */
export async function gradingPrices(
  db: Tx,
  products: { id: string; unit: string; name: string }[],
  date: string
): Promise<(Prisma.Decimal | null)[]> {
  const def = await db.priceList.findFirst({ where: { isDefault: true, active: true }, select: { id: true } });
  const results: (Prisma.Decimal | null)[] = [];
  for (const p of products) {
    if (!def) { results.push(null); continue; }
    const ep = await effectivePrice(db, { priceListId: def.id, product: p, lineUom: p.unit, date });
    results.push(ep ? ep.unitPrice : null);
  }
  return results;
}

/**
 * Prices an order's lines from its customer's list (or the default) for the delivery
 * date, in the caller's transaction. Manual and quotation prices are never touched;
 * existing list prices are refreshed only when `refresh` is set (the customer or the
 * product mapping changed). Lines without a known product, or without a price that
 * day, stay unpriced — visible as such, never guessed.
 */
export async function applyListPrices(tx: Tx, orderId: string, actor: Actorish, opts: { refresh?: boolean } = {}) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { price: true, stockProduct: { include: { salesTax: true } } } } },
  });
  if (!order || order.status === "cancelled") return { priced: 0 };
  // Background re-pricing (customer or mapping changed) never rewrites an invoiced order.
  if (await tx.salesInvoice.count({ where: { orderId, status: { in: ["draft", "issued"] } } })) return { priced: 0 };
  const lists = await priceListsFor(tx, order.customerAccountId);
  if (!lists.length) return { priced: 0 };
  // The lines to (re)price, and every price they could take, read at once (PW-2, Nov 2026).
  const candidates = order.items.filter((item) => {
    const current = item.price;
    if (current && current.source !== "list") return false;
    if (current && !opts.refresh) return false;
    return !!item.stockProduct;
  });
  const prices = await effectivePrices(tx, lists, candidates.map((item) => ({ product: item.stockProduct!, lineUom: item.unit })), order.deliveryDate);
  const creates: Prisma.OrderItemPriceCreateManyInput[] = [];
  let priced = 0;
  for (const [idx, item] of candidates.entries()) {
    const current = item.price;
    const product = item.stockProduct!;
    // The customer's own list first, then the default list (priceListsFor's order).
    const at = prices[idx].findIndex((p) => p !== null);
    const found = at >= 0 ? prices[idx][at] : null;
    const list = at >= 0 ? lists[at] : lists[0];
    if (!found) {
      // No price any more (e.g. the customer moved to a list without it): a stale
      // list price must not linger as if it applied.
      if (current && opts.refresh) await tx.orderItemPrice.delete({ where: { orderItemId: item.id } });
      continue;
    }
    const data = {
      unitPrice: found.unitPrice,
      discountPct: new Prisma.Decimal(0),
      taxCode: product.salesTaxCode,
      taxRate: product.salesTax.rate,
      currencyCode: list.currencyCode,
      source: "list",
      priceListId: list.id,
      priceListItemId: found.item.id,
      reason: null,
      setById: actor.id,
      setBy: actor.name,
    };
    if (current) {
      if (current.unitPrice.equals(found.unitPrice) && current.priceListItemId === found.item.id && current.taxCode === product.salesTaxCode) continue;
      await tx.orderItemPrice.update({ where: { orderItemId: item.id }, data: { ...data, version: { increment: 1 } } });
    } else {
      creates.push({ orderItemId: item.id, ...data });
    }
    priced++;
  }
  // A new order's lines are priced in one insert.
  if (creates.length) await tx.orderItemPrice.createMany({ data: creates });
  if (priced) {
    await writeAudit(audit(actor, { action: "order_priced", entityType: "order", entityId: orderId, orderId, fieldChanged: lists.map((l) => l.code).join(" → "), newValue: `${priced} سطر` }), tx);
  }
  return { priced };
}

/**
 * Once an order has an invoice, its prices belong to the invoice. A draft holds the
 * prices it was drafted with (issuing does not re-read the order), and an issued invoice
 * is the legal document — so a price changed on the order afterwards would silently
 * disagree with what the customer is billed. Void the draft and redraft; after issue,
 * the correction is a credit note.
 */
async function assertNotInvoiced(tx: Tx, orderId: string) {
  const inv = await tx.salesInvoice.findFirst({ where: { orderId, status: { in: ["draft", "issued"] } }, select: { number: true, status: true } });
  if (!inv) return;
  throw new ApiError(
    409,
    inv.status === "draft"
      ? `الأوردر عليه مسودة فاتورة ${inv.number} — الغي المسودة الأول وبعدين عدّل السعر`
      : `الأوردر عليه فاتورة صادرة ${inv.number} — تصحيح السعر بإشعار دائن، مش بتعديل الأوردر`
  );
}

const overrideInput = z.object({
  unit_price: money4("السعر"),
  discount_pct: pct("الخصم").optional(),
  reason: text("سبب تغيير السعر", 500),
  expected_version: version,
});

export async function overrideLinePrice(orderId: string, itemId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.price_override");
  const v = parse(overrideInput, input);
  return inTx(async (tx) => {
    const item = await tx.orderItem.findUnique({ where: { id: itemId }, include: { order: true, price: true, stockProduct: { include: { salesTax: true } } } });
    if (!item || item.orderId !== orderId) throw new ApiError(404, "السطر مش موجود في الأوردر");
    if (item.order.status === "cancelled") throw new ApiError(409, "الأوردر ملغي");
    await assertNotInvoiced(tx, orderId);
    if (!item.stockProduct) throw new ApiError(400, "اربط السطر بصنف من دليل الأصناف الأول — الضريبة بتتحدد من الصنف");
    const cur = item.price;
    if (v.expected_version !== undefined && cur && v.expected_version !== cur.version) throw new ApiError(409, "السعر اتغير من واحد تاني، حدّث الشاشة");
    const discount = v.discount_pct ?? new Prisma.Decimal(0);
    const data = {
      unitPrice: v.unit_price,
      discountPct: discount,
      taxCode: item.stockProduct.salesTaxCode,
      taxRate: item.stockProduct.salesTax.rate,
      source: "manual",
      priceListItemId: null,
      reason: v.reason,
      setById: actor.id,
      setBy: actor.name,
    };
    const row = cur
      ? await tx.orderItemPrice.update({ where: { orderItemId: itemId, version: cur.version }, data: { ...data, version: { increment: 1 } } }).catch((err) => {
          if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "السعر اتغير من واحد تاني، حدّث الشاشة");
          throw err;
        })
      : await tx.orderItemPrice.create({ data: { orderItemId: itemId, currencyCode: "EGP", ...data } });
    await writeAudit(
      audit(actor, {
        action: "order_line_price_overridden",
        entityType: "order_item",
        entityId: itemId,
        orderId,
        fieldChanged: "price",
        oldValue: cur ? `${cur.unitPrice.toString()} (خصم ${cur.discountPct.toString()}%) · ${cur.source}` : null,
        newValue: `${v.unit_price.toString()} (خصم ${discount.toString()}%)`,
        reason: v.reason,
      }),
      tx
    );
    await evaluateOrderPricing(tx, orderId, actor);
    return row;
  });
}

/**
 * The agreed price typed on a new order line (remediation 2026-11). Stored as a manual
 * snapshot — never touched by list refreshes — and audited. When a list price exists
 * and differs, a reason is required; with no list price, the typed price is the price.
 */
export async function setAgreedLinePriceInTx(
  tx: Tx,
  itemId: string,
  input: { unitPrice: Prisma.Decimal; discountPct: Prisma.Decimal; reason?: string | null },
  actor: Actorish
) {
  const item = await tx.orderItem.findUniqueOrThrow({ where: { id: itemId }, include: { price: true, stockProduct: { include: { salesTax: true } } } });
  if (!item.stockProduct) throw new ApiError(400, "اربط السطر بصنف من دليل الأصناف الأول — الضريبة بتتحدد من الصنف");
  if (input.unitPrice.lt(0)) throw new ApiError(400, `سعر "${item.productName}" مينفعش يكون سالب`);
  if (input.discountPct.lt(0) || input.discountPct.gt(100)) throw new ApiError(400, `خصم "${item.productName}" لازم يكون بين 0 و 100`);
  const cur = item.price;
  const differs = !!cur && (!cur.unitPrice.equals(input.unitPrice) || !cur.discountPct.equals(input.discountPct));
  if (cur && !differs) return cur; // the list price was typed as-is
  const reason = input.reason?.trim() || (cur ? "" : "سعر متفق عليه مع العميل عند تسجيل الأوردر");
  if (!reason) throw new ApiError(400, `سعر "${item.productName}" مختلف عن سعر القائمة (${cur!.unitPrice.toString()}) — اكتب السبب`);
  const data = {
    unitPrice: input.unitPrice,
    discountPct: input.discountPct,
    taxCode: item.stockProduct.salesTaxCode,
    taxRate: item.stockProduct.salesTax.rate,
    source: "manual",
    priceListItemId: null,
    reason,
    setById: actor.id,
    setBy: actor.name,
  };
  const row = cur
    ? await tx.orderItemPrice.update({ where: { orderItemId: itemId }, data: { ...data, version: { increment: 1 } } })
    : await tx.orderItemPrice.create({ data: { orderItemId: itemId, currencyCode: "EGP", ...data } });
  await writeAudit(
    audit(actor, {
      action: "order_line_price_overridden",
      entityType: "order_item",
      entityId: itemId,
      orderId: item.orderId,
      fieldChanged: "price",
      oldValue: cur ? `${cur.unitPrice.toString()} (خصم ${cur.discountPct.toString()}%) · ${cur.source}` : null,
      newValue: `${input.unitPrice.toString()} (خصم ${input.discountPct.toString()}%) · عند تسجيل الأوردر`,
      reason,
    }),
    tx
  );
  return row;
}

/**
 * setAgreedLinePriceInTx for many lines of one order (the prices typed when it is created): the
 * same checks in the same order (the first failing line is refused with the same message), the
 * same rows and audit rows, in a fixed number of statements (PW-2, Nov 2026: ~6 round trips per
 * typed line before). A line that already has a (list) price is updated in place — every changed
 * row in one statement — and one without is created.
 */
export async function setAgreedLinePricesInTx(
  tx: Tx,
  entries: { itemId: string; input: { unitPrice: Prisma.Decimal; discountPct: Prisma.Decimal; reason?: string | null } }[],
  actor: Actorish
) {
  if (!entries.length) return;
  const items = await tx.orderItem.findMany({ where: { id: { in: entries.map((e) => e.itemId) } }, include: { price: true, stockProduct: { include: { salesTax: true } } } });
  const byId = new Map(items.map((i) => [i.id, i]));
  const creates: Prisma.OrderItemPriceCreateManyInput[] = [];
  const updates: { orderItemId: string; unitPrice: Prisma.Decimal; discountPct: Prisma.Decimal; taxCode: string; taxRate: Prisma.Decimal; reason: string }[] = [];
  const audits: AuditInput[] = [];
  for (const { itemId, input } of entries) {
    const item = byId.get(itemId);
    if (!item) throw new Prisma.PrismaClientKnownRequestError("No OrderItem found", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
    if (!item.stockProduct) throw new ApiError(400, "اربط السطر بصنف من دليل الأصناف الأول — الضريبة بتتحدد من الصنف");
    if (input.unitPrice.lt(0)) throw new ApiError(400, `سعر "${item.productName}" مينفعش يكون سالب`);
    if (input.discountPct.lt(0) || input.discountPct.gt(100)) throw new ApiError(400, `خصم "${item.productName}" لازم يكون بين 0 و 100`);
    const cur = item.price;
    const differs = !!cur && (!cur.unitPrice.equals(input.unitPrice) || !cur.discountPct.equals(input.discountPct));
    if (cur && !differs) continue; // the list price was typed as-is
    const reason = input.reason?.trim() || (cur ? "" : "سعر متفق عليه مع العميل عند تسجيل الأوردر");
    if (!reason) throw new ApiError(400, `سعر "${item.productName}" مختلف عن سعر القائمة (${cur!.unitPrice.toString()}) — اكتب السبب`);
    const data = {
      unitPrice: input.unitPrice,
      discountPct: input.discountPct,
      taxCode: item.stockProduct.salesTaxCode,
      taxRate: item.stockProduct.salesTax.rate,
      reason,
    };
    if (cur) updates.push({ orderItemId: itemId, ...data });
    else creates.push({ orderItemId: itemId, currencyCode: "EGP", ...data, source: "manual", priceListItemId: null, setById: actor.id, setBy: actor.name });
    audits.push(
      audit(actor, {
        action: "order_line_price_overridden",
        entityType: "order_item",
        entityId: itemId,
        orderId: item.orderId,
        fieldChanged: "price",
        oldValue: cur ? `${cur.unitPrice.toString()} (خصم ${cur.discountPct.toString()}%) · ${cur.source}` : null,
        newValue: `${input.unitPrice.toString()} (خصم ${input.discountPct.toString()}%) · عند تسجيل الأوردر`,
        reason,
      })
    );
  }
  if (creates.length) await tx.orderItemPrice.createMany({ data: creates });
  if (updates.length) {
    // What tx.orderItemPrice.update wrote for each row (source manual, list link cleared, version
    // + 1, updatedAt now as Prisma stores it: UTC wall time), all rows in one statement.
    const at = new Date().toISOString().replace("T", " ").replace("Z", "");
    const values = Prisma.join(updates.map((u) => Prisma.sql`(${u.orderItemId}, ${u.unitPrice.toString()}::numeric, ${u.discountPct.toString()}::numeric, ${u.taxCode}, ${u.taxRate.toString()}::numeric, ${u.reason})`));
    const n = await tx.$executeRaw`
      UPDATE "OrderItemPrice" AS p
      SET "unitPrice" = v.unit_price, "discountPct" = v.discount_pct, "taxCode" = v.tax_code, "taxRate" = v.tax_rate,
          "source" = 'manual', "priceListItemId" = NULL, "reason" = v.reason, "setById" = ${actor.id}, "setBy" = ${actor.name},
          "version" = p."version" + 1, "updatedAt" = ${at}::timestamp(3)
      FROM (VALUES ${values}) AS v(id, unit_price, discount_pct, tax_code, tax_rate, reason)
      WHERE p."orderItemId" = v.id`;
    if (n !== updates.length) throw new Prisma.PrismaClientKnownRequestError("An order line price changed while it was being set", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
  }
  await writeAuditMany(audits, tx);
}

/** Reprices an order's list-priced lines (e.g. after a price correction). */
export async function repriceOrder(orderId: string, actor: ServiceActor) {
  assertPermission(actor, "sales.price_override");
  return inTx(async (tx) => {
    const o = await tx.order.findUnique({ where: { id: orderId } });
    if (!o) throw new ApiError(404, "الأوردر مش موجود");
    if (o.status === "cancelled") throw new ApiError(409, "الأوردر ملغي");
    await assertNotInvoiced(tx, orderId);
    const res = await applyListPrices(tx, orderId, actor, { refresh: true });
    await evaluateOrderPricing(tx, orderId, actor);
    return res;
  });
}

/** The quantity a line is valued at as things stand: loaded, else prepared, else required. */
export function valuedQuantity(i: { loadedQuantity: number | null; preparedQuantity: number | null; requiredQuantity: number }) {
  return new Prisma.Decimal(i.loadedQuantity ?? i.preparedQuantity ?? i.requiredQuantity).toDecimalPlaces(3);
}

type ValuedItem = Parameters<typeof valuedQuantity>[0] & { price: { unitPrice: Prisma.Decimal; discountPct: Prisma.Decimal; taxRate: Prisma.Decimal } | null };

/** orderValue's arithmetic on one order's lines already read (PS-3, Nov 2026: the credit
 * exposure reads the lines of every open order at once). */
export function valueOfItems(items: ValuedItem[]) {
  const priced = items.filter((i) => i.price);
  const totals = sumAmounts(priced.map((i) => lineAmounts({ quantity: valuedQuantity(i), unitPrice: i.price!.unitPrice, discountPct: i.price!.discountPct, taxRate: i.price!.taxRate })));
  return { total: totals.total, unpriced: items.length - priced.length };
}

/** An order's priced value (lines without a price count as nothing — callers that
 * care check `unpriced`). */
export async function orderValue(db: Pick<Tx, "orderItem">, orderId: string) {
  const items = await db.orderItem.findMany({ where: { orderId }, include: { price: true } });
  return valueOfItems(items);
}

/**
 * The commercial view of an order: each line priced on the quantity that will be
 * invoiced as things stand (loaded, else prepared, else required), and the totals.
 */
export async function orderPricing(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customerAccount: { select: { id: true, code: true, name: true, nameAr: true, priceListId: true } }, items: { include: { price: true, stockProduct: { select: { name: true, nameAr: true } } }, orderBy: { id: "asc" } } },
  });
  if (!order) throw new ApiError(404, "الأوردر مش موجود");
  const list = await priceListFor(prisma, order.customerAccountId);
  const lines = order.items.map((i) => {
    const qty = valuedQuantity(i);
    const p = i.price;
    const amounts = p ? lineAmounts({ quantity: qty, unitPrice: p.unitPrice, discountPct: p.discountPct, taxRate: p.taxRate }) : null;
    return {
      itemId: i.id,
      productName: i.productName,
      // I18N-04: the product card's names, so the screen can show the reader's language.
      productNameEn: i.stockProduct?.name ?? null,
      productNameAr: i.stockProduct?.nameAr ?? null,
      unit: i.unit,
      mapped: !!i.stockProductId,
      quantity: qty.toString(),
      quantityBasis: i.loadedQuantity != null ? "loaded" : i.preparedQuantity != null ? "prepared" : "required",
      price: p ? { unitPrice: p.unitPrice.toString(), discountPct: p.discountPct.toString(), taxCode: p.taxCode, taxRate: p.taxRate.toString(), source: p.source, reason: p.reason, setBy: p.setBy, version: p.version } : null,
      amounts: amounts ? amountsJSON(amounts) : null,
    };
  });
  const priced = lines.filter((l) => l.amounts);
  // Where the money stands: delivery result → invoice → paid / open.
  const [stop, invoice] = await Promise.all([
    prisma.tripStop.findFirst({ where: { orderId, active: true }, select: { status: true, deliveredAt: true, trip: { select: { number: true } } } }),
    prisma.salesInvoice.findFirst({ where: { orderId, status: { not: "void" } }, select: { id: true, number: true, status: true, total: true, creditNotes: { select: { total: true } }, receiptAllocations: { where: { receipt: { reversal: { is: null } } }, select: { amount: true } } } }),
  ]);
  const settled = invoice ? invoice.creditNotes.reduce((s, c) => s.plus(c.total), new Prisma.Decimal(0)).plus(invoice.receiptAllocations.reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0))) : null;
  const commercial = {
    delivery: stop ? { trip: stop.trip.number, status: stop.status, deliveredAt: stop.deliveredAt } : null,
    invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, total: invoice.total.toFixed(2), open: invoice.status === "issued" ? invoice.total.minus(settled!).toFixed(2) : null } : null,
  };
  const totals = sumAmounts(
    order.items.filter((i) => i.price).map((i) => lineAmounts({ quantity: valuedQuantity(i), unitPrice: i.price!.unitPrice, discountPct: i.price!.discountPct, taxRate: i.price!.taxRate }))
  );
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    creditStatus: order.creditStatus,
    creditNote: order.creditNote,
    customer: order.customerAccount,
    priceList: list ? { id: list.id, code: list.code, name: list.name } : null,
    currency: list?.currencyCode ?? "EGP",
    lines,
    totals: amountsJSON(totals),
    unpricedLines: lines.length - priced.length,
    commercial,
  };
}

/** The product's sales tax class — a tax decision, so finance's (sales.tax.manage),
 * not whoever sets prices. */
export async function setProductTax(productId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.tax.manage");
  const v = parse(z.object({ tax_code: text("الضريبة"), reason: text("السبب", 500) }), input);
  return inTx(async (tx) => {
    const p = await tx.stockProduct.findUnique({ where: { id: productId } });
    if (!p) throw new ApiError(404, "الصنف مش موجود");
    const t = await tx.taxRate.findUnique({ where: { code: v.tax_code } });
    if (!t || !t.active) throw new ApiError(400, "الضريبة مش معروفة");
    if (p.salesTaxCode === t.code) return p;
    const updated = await tx.stockProduct.update({ where: { id: productId }, data: { salesTaxCode: t.code, version: { increment: 1 } } });
    await writeAudit(audit(actor, { action: "product_tax_changed", entityType: "stock_product", entityId: productId, fieldChanged: "salesTaxCode", oldValue: p.salesTaxCode, newValue: t.code, reason: v.reason }), tx);
    return updated;
  });
}

export async function listTaxRates() {
  return prisma.taxRate.findMany({ where: { active: true }, orderBy: { code: "asc" } });
}

/** Assigns a customer's price list (null = the default list). Sales owns pricing. */
export async function setCustomerPriceList(customerId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.pricing.manage");
  const v = parse(z.object({ price_list_id: z.string().nullable(), reason: text("السبب", 500) }), input);
  return inTx(async (tx) => {
    const c = await tx.customer.findUnique({ where: { id: customerId } });
    if (!c) throw new ApiError(404, "العميل مش موجود");
    if (v.price_list_id) {
      const pl = await tx.priceList.findUnique({ where: { id: v.price_list_id } });
      if (!pl || !pl.active) throw new ApiError(400, "قائمة الأسعار مش موجودة أو موقوفة");
    }
    if (c.priceListId === v.price_list_id) return c;
    const updated = await tx.customer.update({ where: { id: customerId }, data: { priceListId: v.price_list_id, version: { increment: 1 } } });
    await writeAudit(audit(actor, { action: "customer_price_list_changed", entityType: "customer", entityId: customerId, fieldChanged: "priceListId", oldValue: c.priceListId, newValue: v.price_list_id, reason: v.reason }), tx);
    return updated;
  });
}
