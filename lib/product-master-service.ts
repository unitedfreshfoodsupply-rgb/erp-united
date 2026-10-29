import { Prisma } from "@prisma/client";
import { asText } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany } from "@/lib/audit";
import { advisoryXactLock } from "@/lib/dbLock";
import {
  normalizeProductName,
  type ProductResolution,
  type ResolvedProduct,
} from "@/lib/productIdentity";
import type { StockActor } from "@/lib/stock-auth";
import { applyListPrices } from "@/lib/sales/pricing";
import { assertPermission } from "@/lib/authz-core";

/**
 * The Product Master.
 *
 * Responsibilities, in order of importance:
 *  1. Resolve a piece of text to exactly one canonical product, or refuse.
 *  2. Keep the alias namespace unambiguous, so (1) can never have to choose.
 *  3. Record who decided what, since every mapping is a business decision that will
 *     later move stock.
 *
 * What it deliberately does NOT do: touch quantities, ledger rows, order status, or
 * anything about stock levels. This layer establishes identity only.
 */

const PRODUCT_SELECT = {
  id: true,
  name: true,
  nameAr: true,
  sku: true,
  unit: true,
  active: true,
  stockTracked: true,
} as const;

/** One lock for the whole alias namespace: its invariant is global uniqueness, so
 * concurrent writers must be serialised against each other, not per product. */
const ALIAS_LOCK = "product-master:alias-namespace";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Text in, identity out. The only lookup path in the system.
 *
 * Note it queries for ALL matches rather than `findUnique`, even though a unique index
 * makes more than one impossible. If that constraint were ever bypassed — a manual
 * SQL fix, a future migration — the resolver refuses rather than silently picking the
 * first row. Failing closed on identity is cheap; posting stock against the wrong
 * product is not.
 */
export async function resolveProductName(raw: string): Promise<ProductResolution> {
  const normalized = normalizeProductName(raw ?? "");
  if (!normalized) return { status: "unmapped", normalized: "", reason: "blank" };

  const matches = await prisma.productAlias.findMany({
    where: { normalized },
    select: { kind: true, product: { select: PRODUCT_SELECT } },
  });

  if (matches.length === 0) return { status: "unmapped", normalized, reason: "no_match" };
  if (matches.length > 1) {
    return { status: "ambiguous", normalized, candidates: matches.map((m) => m.product) };
  }
  return {
    status: "matched",
    normalized,
    product: matches[0].product,
    matchedOn: matches[0].kind as "canonical" | "canonical_ar" | "manual",
  };
}

/** Batch form for order creation, which resolves every line of an order at once. */
export async function resolveProductNames(names: string[]): Promise<Map<string, ProductResolution>> {
  const out = new Map<string, ProductResolution>();
  const normalizedByRaw = new Map<string, string>();
  for (const raw of names) normalizedByRaw.set(raw, normalizeProductName(raw ?? ""));

  const lookups = [...new Set([...normalizedByRaw.values()].filter(Boolean))];
  const rows = lookups.length
    ? await prisma.productAlias.findMany({
        where: { normalized: { in: lookups } },
        select: { normalized: true, kind: true, product: { select: PRODUCT_SELECT } },
      })
    : [];

  const byNormalized = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byNormalized.has(r.normalized)) byNormalized.set(r.normalized, []);
    byNormalized.get(r.normalized)!.push(r);
  }

  for (const [raw, normalized] of normalizedByRaw) {
    if (!normalized) {
      out.set(raw, { status: "unmapped", normalized: "", reason: "blank" });
      continue;
    }
    const hits = byNormalized.get(normalized) ?? [];
    if (hits.length === 0) out.set(raw, { status: "unmapped", normalized, reason: "no_match" });
    else if (hits.length > 1)
      out.set(raw, { status: "ambiguous", normalized, candidates: hits.map((h) => h.product) });
    else
      out.set(raw, {
        status: "matched",
        normalized,
        product: hits[0].product,
        matchedOn: hits[0].kind as "canonical" | "canonical_ar" | "manual",
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type ProductInput = {
  name: string;
  name_ar?: string | null;
  sku?: string | null;
  category?: string | null;
  unit?: string;
  stock_tracked?: boolean;
  sales_tax_code?: string;
};

function cleanOptional(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Canonical names are themselves aliases.
 *
 * Keeping the English and Arabic names inside the same alias namespace is what makes
 * resolution a single exact lookup, and what makes it impossible for a new product to
 * be created with a name another product already answers to — the unique index catches
 * it at insert time rather than a validation rule having to remember to check.
 */
async function syncCanonicalAliases(
  tx: Prisma.TransactionClient,
  product: { id: string; name: string; nameAr: string | null },
  actor: StockActor
) {
  const wanted: { kind: "canonical" | "canonical_ar"; alias: string }[] = [
    { kind: "canonical", alias: product.name },
  ];
  if (product.nameAr) wanted.push({ kind: "canonical_ar", alias: product.nameAr });

  const existing = await tx.productAlias.findMany({
    where: { productId: product.id, kind: { in: ["canonical", "canonical_ar"] } },
  });

  for (const want of wanted) {
    const normalized = normalizeProductName(want.alias);
    if (!normalized) throw new ApiError(400, `"${want.alias}" مش اسم صالح`);
    const current = existing.find((e) => e.kind === want.kind);
    if (current && current.normalized === normalized) continue;
    if (current) await tx.productAlias.delete({ where: { id: current.id } });
    await tx.productAlias.create({
      data: {
        productId: product.id,
        alias: want.alias,
        normalized,
        kind: want.kind,
        createdById: actor.id,
        createdBy: actor.name,
      },
    });
  }

  // An Arabic name that was removed must stop resolving.
  const orphan = existing.find((e) => e.kind === "canonical_ar" && !product.nameAr);
  if (orphan) await tx.productAlias.delete({ where: { id: orphan.id } });
}

function aliasConflictError(err: unknown, label: string): never {
  if ((err as { code?: string })?.code === "P2002") {
    const target = (err as { meta?: { target?: string[] } })?.meta?.target ?? [];
    if (target.includes("normalized")) {
      throw new ApiError(409, `"${label}" مستخدم بالفعل لصنف تاني — الاسم لازم يكون مميز`);
    }
    throw new ApiError(409, `"${label}" موجود بالفعل`);
  }
  throw err as Error;
}

/** A stock-tracked product's base unit must be a real, active unit that converts —
 * not a package (a crate's weight depends on the product; it is packaging, not a base). */
async function assertBaseUnit(code: string) {
  const uom = await prisma.unitOfMeasure.findUnique({ where: { code } });
  if (!uom || !uom.active) throw new ApiError(400, `الوحدة "${code}" مش معروفة — اختار من وحدات القياس`);
  if (uom.category === "package") {
    throw new ApiError(400, `"${code}" وحدة تعبئة — الوحدة الأساسية لازم تكون وزن أو عدد أو حجم، والتعبئة تتعرّف من صفحة الصنف`);
  }
}

export async function createProduct(input: ProductInput, actor: StockActor) {
  const name = asText(input.name, "name")?.trim();
  if (!name) throw new ApiError(400, "الاسم الإنجليزي للصنف مطلوب");
  const nameAr = cleanOptional(input.name_ar);
  const sku = cleanOptional(input.sku);
  const category = cleanOptional(input.category);
  const stockTracked = input.stock_tracked ?? true;
  const unit = asText(input.unit, "unit")?.trim() ?? "";
  const salesTaxCode = cleanOptional(input.sales_tax_code);
  if (salesTaxCode) assertPermission(actor, "sales.tax.manage");

  // No default unit for anything that will hold stock: an assumed KG is a silent
  // business decision that only shows up as a wrong balance months later.
  if (stockTracked && !unit) {
    throw new ApiError(400, "الصنف اللي بيتتبع مخزونه لازم يكون له وحدة أساسية");
  }
  if (stockTracked) await assertBaseUnit(unit);

  const product = await prisma.$transaction(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);
    if (salesTaxCode) {
      const tax = await tx.taxRate.findUnique({ where: { code: salesTaxCode } });
      if (!tax || !tax.active) throw new ApiError(400, `تصنيف الضريبة ${salesTaxCode} غير معروف أو موقوف`);
    }
    let created;
    try {
      created = await tx.stockProduct.create({
        data: { name, nameAr, sku, category, unit: unit || "KG", stockTracked, ...(salesTaxCode ? { salesTaxCode } : {}) },
      });
    } catch (err) {
      aliasConflictError(err, name);
    }
    await syncCanonicalAliases(tx, created, actor);
    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "product_created",
        entityType: "stock_product",
        entityId: created.id,
        newValue: `${created.name}${created.nameAr ? ` / ${created.nameAr}` : ""} · ${created.unit}${created.stockTracked ? "" : " · غير متتبع"}${salesTaxCode ? ` · ${salesTaxCode}` : ""}`,
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    return created;
  }, { maxWait: 15_000, timeout: 20_000 }).catch((err) => aliasConflictError(err, name));

  return product;
}

export async function updateProduct(
  id: string,
  fields: Partial<ProductInput> & { active?: boolean },
  actor: StockActor,
  expectedVersion?: number
) {
  const existing = await prisma.stockProduct.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "الصنف مش موجود");
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new ApiError(409, `الصنف اتغيّر من واحد تاني (النسخة الحالية: ${existing.version})`);
  }

  const data: Prisma.StockProductUpdateInput = {};
  const changes: [string, string | null, string | null][] = [];

  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (!name) throw new ApiError(400, "الاسم الإنجليزي للصنف مطلوب");
    if (name !== existing.name) { data.name = name; changes.push(["name", existing.name, name]); }
  }
  for (const [key, col] of [["name_ar", "nameAr"], ["sku", "sku"], ["category", "category"]] as const) {
    if (fields[key] !== undefined) {
      const next = cleanOptional(fields[key] as string | null);
      if (next !== (existing as never as Record<string, string | null>)[col]) {
        (data as Record<string, unknown>)[col] = next;
        changes.push([col, (existing as never as Record<string, string | null>)[col], next]);
      }
    }
  }
  if (fields.unit !== undefined) {
    const unit = fields.unit.trim();
    if (!unit) throw new ApiError(400, "الوحدة الأساسية مطلوبة");
    if (unit !== existing.unit) { data.unit = unit; changes.push(["unit", existing.unit, unit]); }
  }
  if (fields.stock_tracked !== undefined && fields.stock_tracked !== existing.stockTracked) {
    data.stockTracked = fields.stock_tracked;
    changes.push(["stockTracked", String(existing.stockTracked), String(fields.stock_tracked)]);
  }
  if (fields.active !== undefined && fields.active !== existing.active) {
    data.active = fields.active;
    changes.push(["active", String(existing.active), String(fields.active)]);
  }
  if (changes.length === 0) return existing;

  const willTrack = fields.stock_tracked ?? existing.stockTracked;
  const willUnit = (fields.unit ?? existing.unit).trim();
  if (willTrack && !willUnit) throw new ApiError(400, "الصنف اللي بيتتبع مخزونه لازم يكون له وحدة أساسية");
  if (willTrack && (data.unit !== undefined || data.stockTracked !== undefined)) await assertBaseUnit(willUnit);
  // Every quantity already in the ledger is in the current unit. Changing it would
  // silently reinterpret all of them (yesterday's 100 KG becoming 100 PIECE).
  if (data.unit !== undefined && (await prisma.stockMovement.count({ where: { productId: id } })) > 0) {
    throw new ApiError(409, "الصنف عليه حركات مخزون — مينفعش تغيّر وحدته الأساسية (اعمل صنف جديد)");
  }

  const updated = await prisma.$transaction(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);
    let result;
    try {
      result = await tx.stockProduct.update({
        where: { id, version: existing.version },
        data: { ...data, version: { increment: 1 } },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2025") {
        throw new ApiError(409, "الصنف اتغيّر من واحد تاني، حدّث الشاشة");
      }
      aliasConflictError(err, fields.name ?? existing.name);
    }
    // A rename must move the canonical alias with it, or the old spelling keeps
    // resolving and the new one does not.
    await syncCanonicalAliases(tx, result, actor);
    await writeAuditMany(
      changes.map(([field, oldValue, newValue]) => ({
        userId: actor.id, userName: actor.name, role: actor.role,
        action: field === "active" ? (newValue === "true" ? "product_activated" : "product_deactivated") : "product_updated",
        entityType: "stock_product" as const, entityId: id,
        fieldChanged: field, oldValue, newValue,
        source: "user" as const, deviceId: actor.deviceId,
      })),
      tx
    );
    return result;
  }, { maxWait: 15_000, timeout: 20_000 });

  return updated;
}

export async function listProducts(opts: { includeInactive?: boolean } = {}) {
  const products = await prisma.stockProduct.findMany({
    where: opts.includeInactive ? undefined : { active: true },
    orderBy: { name: "asc" },
    include: {
      aliases: { orderBy: [{ kind: "asc" }, { alias: "asc" }] },
      _count: { select: { orderItems: true, intakes: true } },
    },
  });
  return products;
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

export async function addAlias(productId: string, rawAlias: string, actor: StockActor) {
  const alias = asText(rawAlias, "alias")?.trim();
  if (!alias) throw new ApiError(400, "الاسم البديل مطلوب");
  const normalized = normalizeProductName(alias);
  if (!normalized) throw new ApiError(400, "الاسم البديل ده مش صالح");

  const product = await prisma.stockProduct.findUnique({ where: { id: productId } });
  if (!product) throw new ApiError(404, "الصنف مش موجود");

  const created = await prisma.$transaction(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);
    const clash = await tx.productAlias.findUnique({
      where: { normalized },
      select: { product: { select: { id: true, name: true, nameAr: true } } },
    });
    if (clash) {
      if (clash.product.id === productId) throw new ApiError(409, `"${alias}" مضاف بالفعل للصنف ده`);
      // Naming the owner matters: "already used" without saying by what leaves the
      // operator guessing which product to go and look at.
      throw new ApiError(409, `"${alias}" مستخدم بالفعل للصنف "${clash.product.name}"`);
    }
    const row = await tx.productAlias.create({
      data: { productId, alias, normalized, kind: "manual", createdById: actor.id, createdBy: actor.name },
    });
    await writeAudit({
      userId: actor.id, userName: actor.name, role: actor.role,
      action: "product_alias_added",
      entityType: "product_alias", entityId: row.id,
      fieldChanged: product.name, newValue: alias,
      source: "user", deviceId: actor.deviceId,
    }, tx);
    return row;
  }, { maxWait: 15_000, timeout: 20_000 });

  return created;
}

export async function removeAlias(aliasId: string, actor: StockActor) {
  const alias = await prisma.productAlias.findUnique({
    where: { id: aliasId },
    include: { product: { select: { id: true, name: true, nameAr: true } } },
  });
  if (!alias) throw new ApiError(404, "الاسم البديل مش موجود");
  // Canonical aliases are derived from the product's own names; removing one directly
  // would leave the product unresolvable by its own name.
  if (alias.kind !== "manual") {
    throw new ApiError(400, "ده الاسم الأساسي للصنف — غيّره من بيانات الصنف نفسه");
  }

  await prisma.$transaction(async (tx) => {
    await tx.productAlias.delete({ where: { id: aliasId } });
    await writeAudit({
      userId: actor.id, userName: actor.name, role: actor.role,
      action: "product_alias_removed",
      entityType: "product_alias", entityId: aliasId,
      fieldChanged: alias.product.name, oldValue: alias.alias,
      source: "user", deviceId: actor.deviceId,
    }, tx);
  });
  return { removed: true };
}

// ---------------------------------------------------------------------------
// Order-item mapping and coverage
// ---------------------------------------------------------------------------

export type OrderProductRow = {
  /** The raw text as it appears on order lines. */
  productName: string;
  /** Unit as the order carried it - shown as-is, never overwritten by the master. */
  unit: string;
  normalized: string;
  lineCount: number;
  orderCount: number;
  status: "mapped" | "unmapped" | "ambiguous";
  product: ResolvedProduct | null;
  /** True when mapped to a product that is no longer active. */
  inactiveMapping: boolean;
  /** True when the order line's unit differs from the product's base unit. Surfaced,
   * never auto-corrected: reinterpreting a recorded quantity is a business decision. */
  unitMismatch: boolean;
  candidates: ResolvedProduct[];
};

/** Grouping key for (name, unit). JSON so no separator can collide with a real name. */
const groupKey = (name: string, unit: string) => JSON.stringify([name, unit]);

/**
 * Every distinct product name that appears on an order line, with what the master
 * currently makes of it.
 *
 * Grouped by (name, unit) rather than name alone: the same word recorded in two
 * different units is two different operational facts, and collapsing them would hide
 * exactly the case that most needs a human to look at it.
 */
export async function orderProductCoverage(): Promise<{
  rows: OrderProductRow[];
  summary: {
    distinctNames: number;
    mapped: number;
    unmapped: number;
    ambiguous: number;
    inactiveMappings: number;
    unitMismatches: number;
    totalLines: number;
    mappedLines: number;
  };
}> {
  const grouped = await prisma.orderItem.groupBy({
    by: ["productName", "unit", "stockProductId"],
    _count: { _all: true },
  });

  // Distinct order count per (name, unit) needs the order ids, which groupBy cannot
  // give directly - one extra query rather than one per row.
  const lines = await prisma.orderItem.findMany({
    select: { productName: true, unit: true, orderId: true },
  });
  const ordersByKey = new Map<string, Set<string>>();
  for (const l of lines) {
    const key = groupKey(l.productName, l.unit);
    if (!ordersByKey.has(key)) ordersByKey.set(key, new Set());
    ordersByKey.get(key)!.add(l.orderId);
  }

  const resolutions = await resolveProductNames([...new Set(grouped.map((g) => g.productName))]);

  const mappedProductIds = [...new Set(grouped.map((g) => g.stockProductId).filter(Boolean))] as string[];
  const mappedProducts = mappedProductIds.length
    ? await prisma.stockProduct.findMany({ where: { id: { in: mappedProductIds } }, select: PRODUCT_SELECT })
    : [];
  const productById = new Map(mappedProducts.map((p) => [p.id, p]));

  const byKey = new Map<string, OrderProductRow>();
  for (const g of grouped) {
    const key = groupKey(g.productName, g.unit);
    const resolution = resolutions.get(g.productName)!;
    const linked = g.stockProductId ? productById.get(g.stockProductId) ?? null : null;

    const existing = byKey.get(key);
    const row: OrderProductRow = existing ?? {
      productName: g.productName,
      unit: g.unit,
      normalized: resolution.normalized,
      lineCount: 0,
      orderCount: ordersByKey.get(key)?.size ?? 0,
      // A row is mapped when the ORDER LINE carries a link, not merely when the name
      // could resolve. A resolvable-but-unlinked name is still unmapped work.
      status: resolution.status === "ambiguous" ? "ambiguous" : "unmapped",
      product: null,
      inactiveMapping: false,
      unitMismatch: false,
      candidates: resolution.status === "ambiguous" ? resolution.candidates : [],
    };
    row.lineCount += g._count._all;
    if (linked) {
      row.product = linked;
      row.status = "mapped";
      row.inactiveMapping = !linked.active;
      row.unitMismatch = linked.unit.trim().toLowerCase() !== g.unit.trim().toLowerCase();
    }
    byKey.set(key, row);
  }

  const rows = [...byKey.values()].sort((a, b) => {
    const rank = { unmapped: 0, ambiguous: 1, mapped: 2 } as const;
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return b.lineCount - a.lineCount || a.productName.localeCompare(b.productName);
  });

  const totalLines = rows.reduce((s, r) => s + r.lineCount, 0);
  return {
    rows,
    summary: {
      distinctNames: rows.length,
      mapped: rows.filter((r) => r.status === "mapped").length,
      unmapped: rows.filter((r) => r.status === "unmapped").length,
      ambiguous: rows.filter((r) => r.status === "ambiguous").length,
      inactiveMappings: rows.filter((r) => r.inactiveMapping).length,
      unitMismatches: rows.filter((r) => r.unitMismatch).length,
      totalLines,
      mappedLines: rows.filter((r) => r.status === "mapped").reduce((s, r) => s + r.lineCount, 0),
    },
  };
}

/**
 * Link every order line carrying a given product name to a canonical product.
 *
 * This is the explicit human decision the whole module exists to capture, so it does
 * two things at once and records both: it teaches the master that this text means this
 * product (an alias), and it applies that to the lines already recorded.
 *
 * `create_alias: false` maps the existing lines WITHOUT teaching the master - for a
 * one-off mis-spelling that should not start resolving future orders.
 *
 * Quantities, units, statuses and ledger rows are untouched. Only identity is set.
 */
export async function mapOrderProductName(
  input: { product_name: string; unit?: string; product_id: string; create_alias?: boolean; reason?: string },
  actor: StockActor
) {
  const productName = asText(input.product_name, "product_name")?.trim();
  if (!productName) throw new ApiError(400, "اسم المنتج في الأوردر مطلوب");
  const normalized = normalizeProductName(productName);
  if (!normalized) throw new ApiError(400, "الاسم ده مش صالح للربط");

  const product = await prisma.stockProduct.findUnique({ where: { id: input.product_id } });
  if (!product) throw new ApiError(404, "الصنف مش موجود");
  if (!product.active) throw new ApiError(400, `"${product.name}" موقوف - فعّله الأول قبل ما تربط عليه`);

  const createAlias = input.create_alias ?? true;

  const result = await prisma.$transaction(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);

    let aliasId: string | null = null;
    if (createAlias) {
      const clash = await tx.productAlias.findUnique({
        where: { normalized },
        select: { id: true, productId: true, product: { select: { name: true, nameAr: true } } },
      });
      if (clash && clash.productId !== product.id) {
        throw new ApiError(409, `"${productName}" مربوط بالفعل بالصنف "${clash.product.name}"`);
      }
      if (!clash) {
        const alias = await tx.productAlias.create({
          data: {
            productId: product.id, alias: productName, normalized, kind: "manual",
            createdById: actor.id, createdBy: actor.name,
          },
        });
        aliasId = alias.id;
      } else {
        aliasId = clash.id;
      }
    }

    // Only lines whose name normalizes to the same thing - an exact match on the
    // normalized form, never a LIKE or a similarity test.
    const candidates = await tx.orderItem.findMany({
      where: input.unit ? { unit: input.unit } : undefined,
      select: { id: true, orderId: true, productName: true, stockProductId: true },
    });
    const targets = candidates.filter((c) => normalizeProductName(c.productName) === normalized && c.stockProductId !== product.id);
    const targetIds = targets.map((c) => c.id);

    const updated = targetIds.length
      ? await tx.orderItem.updateMany({ where: { id: { in: targetIds } }, data: { stockProductId: product.id } })
      : { count: 0 };
    // The lines now name a product with a price and a tax class: price them.
    for (const orderId of new Set(targets.map((t) => t.orderId))) await applyListPrices(tx, orderId, actor, { refresh: true });

    await writeAudit({
      userId: actor.id, userName: actor.name, role: actor.role,
      action: "order_product_mapped",
      entityType: "product_mapping", entityId: product.id,
      fieldChanged: productName,
      oldValue: "غير مربوط",
      newValue: `${product.name} · ${updated.count} سطر`,
      reason: input.reason,
      source: "user", deviceId: actor.deviceId,
    }, tx);
    return { aliasId, linkedLines: updated.count };
  }, { maxWait: 15_000, timeout: 20_000 });

  return { product, ...result };
}

/** Detach a name from its canonical product, returning its order lines to UNMAPPED. */
export async function unmapOrderProductName(
  input: { product_name: string; remove_alias?: boolean; reason?: string },
  actor: StockActor
) {
  const productName = asText(input.product_name, "product_name")?.trim();
  if (!productName) throw new ApiError(400, "اسم المنتج مطلوب");
  const normalized = normalizeProductName(productName);
  if (!normalized) throw new ApiError(400, "الاسم ده مش صالح");

  const result = await prisma.$transaction(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);
    const candidates = await tx.orderItem.findMany({
      select: { id: true, productName: true, stockProductId: true },
    });
    const targetIds = candidates
      .filter((c) => normalizeProductName(c.productName) === normalized && c.stockProductId !== null)
      .map((c) => c.id);
    const cleared = targetIds.length
      ? await tx.orderItem.updateMany({ where: { id: { in: targetIds } }, data: { stockProductId: null } })
      : { count: 0 };
    // A list price belonged to the product the line no longer names. (A manual price
    // was a person's decision and stays.)
    if (targetIds.length) await tx.orderItemPrice.deleteMany({ where: { orderItemId: { in: targetIds }, source: "list" } });

    let removedAlias = false;
    if (input.remove_alias) {
      const alias = await tx.productAlias.findUnique({ where: { normalized } });
      // Never delete a canonical alias this way - that would make a product
      // unresolvable by its own name as a side effect of unmapping an order line.
      if (alias && alias.kind === "manual") {
        await tx.productAlias.delete({ where: { id: alias.id } });
        removedAlias = true;
      }
    }
    await writeAudit({
      userId: actor.id, userName: actor.name, role: actor.role,
      action: "order_product_unmapped",
      entityType: "product_mapping", entityId: normalized,
      fieldChanged: productName,
      oldValue: `${cleared.count} سطر مربوط`,
      newValue: "غير مربوط",
      reason: input.reason,
      source: "user", deviceId: actor.deviceId,
    }, tx);
    return { clearedLines: cleared.count, removedAlias };
  }, { maxWait: 15_000, timeout: 20_000 });

  return result;
}
