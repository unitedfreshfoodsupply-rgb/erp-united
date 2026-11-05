import { ApiError } from "@/lib/rbac";
import type { ProductPackaging, UnitOfMeasure } from "@prisma/client";
import type { Tx } from "@/lib/tx";
import { convertQuantity, UomConversionError } from "@/lib/core/uom";
import { D, type Dec } from "@/lib/inventory/decimal";

type Db = Pick<Tx, "unitOfMeasure" | "productPackaging">;

/**
 * The only two lookups toBaseQuantity makes. A transaction satisfies it, and so does the
 * in-memory set preloadedUnits returns — typed, not cast, so a new lookup in toBaseQuantity
 * is a compile error there rather than a TypeError on the dispatch and return paths.
 */
export type UnitLookups = {
  unitOfMeasure: { findUnique(args: { where: { code: string } }): Promise<UnitOfMeasure | null> };
  productPackaging: { findUnique(args: { where: { productId_uomCode: { productId: string; uomCode: string } } }): Promise<ProductPackaging | null> };
};

/**
 * Converts a quantity someone counted (40 CRATE, 2 TON) into the product's base unit.
 * Same-category units convert through the global ratio; package units only through
 * THIS product's packaging. The result must be exact in the base unit's precision —
 * 2.5 crates of eggs is not a whole number of pieces, and is refused, not rounded.
 */
export async function toBaseQuantity(
  db: UnitLookups,
  product: { id: string; name: string; unit: string },
  qty: Dec,
  uomCode: string
): Promise<Dec> {
  if (uomCode === product.unit) return qty;
  const [from, base] = await Promise.all([
    db.unitOfMeasure.findUnique({ where: { code: uomCode } }),
    db.unitOfMeasure.findUnique({ where: { code: product.unit } }),
  ]);
  if (!from || !from.active) throw new ApiError(400, `الوحدة ${uomCode} مش معروفة`);
  const precision = base?.precision ?? 3;
  let out: Dec;
  if (base && from.category === base.category && from.category !== "package") {
    try {
      out = convertQuantity(qty, from, { ...base, precision: 9 });
    } catch (err) {
      if (err instanceof UomConversionError) throw new ApiError(400, err.message);
      throw err;
    }
  } else {
    const pack = await db.productPackaging.findUnique({ where: { productId_uomCode: { productId: product.id, uomCode } } });
    if (!pack || !pack.active) {
      throw new ApiError(400, `مفيش تعبئة ${uomCode} متعرّفة للصنف "${product.name}" — عرّفها من دليل الأصناف`);
    }
    out = qty.times(D(pack.qtyInBaseUnit));
  }
  const rounded = out.toDecimalPlaces(precision);
  if (!rounded.equals(out)) {
    throw new ApiError(400, `${qty.toFixed()} ${uomCode} = ${out.toFixed()} ${product.unit} — مش رقم صحيح بدقة الوحدة (${precision} خانات)`);
  }
  return rounded;
}

/**
 * The two lookups toBaseQuantity makes (units by code, a product's packaging by unit), read once
 * for many lines (PW-1, Nov 2026): pass the result to toBaseQuantity in place of the database and
 * every line converts — or is refused — exactly as it would reading them itself.
 */
export async function preloadedUnits(db: Db, lines: { productId: string; units: string[] }[]): Promise<UnitLookups> {
  const codes = [...new Set(lines.flatMap((l) => l.units))];
  const [uoms, packs] = await Promise.all([
    db.unitOfMeasure.findMany({ where: { code: { in: codes } } }),
    db.productPackaging.findMany({ where: { productId: { in: [...new Set(lines.map((l) => l.productId))] }, uomCode: { in: codes } } }),
  ]);
  const uomBy = new Map(uoms.map((u) => [u.code, u]));
  const packBy = new Map(packs.map((p) => [`${p.productId}|${p.uomCode}`, p]));
  return {
    unitOfMeasure: { findUnique: async ({ where }: { where: { code: string } }) => uomBy.get(where.code) ?? null },
    productPackaging: { findUnique: async ({ where }: { where: { productId_uomCode: { productId: string; uomCode: string } } }) => packBy.get(`${where.productId_uomCode.productId}|${where.productId_uomCode.uomCode}`) ?? null },
  };
}
