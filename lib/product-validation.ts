import { resolveProductNames } from "@/lib/product-master-service";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";

/**
 * Product Master resolution for incoming order lines.
 *
 * This is the plug point n8n / Hermes already call through. It now consults the
 * Product Master, but the contract is unchanged in the way that matters: an order is
 * NEVER rejected because its product is unrecognised. An unmapped line is recorded
 * faithfully — original text, original unit — with no canonical identity, and shows up
 * in the coverage view for a human to resolve.
 *
 * Refusing unknown products would mean a real delivery cannot be entered because the
 * master has not caught up with what a customer wrote. Identity is allowed to lag
 * reality; it is not allowed to block it, and it is never allowed to guess.
 */
export type RawIncomingItem = {
  /** Canonical ID from the product master, used by staff-entered orders. */
  stock_product_id?: string;
  /** External-system reference; this is not a canonical product ID. */
  product_id?: string;
  product_name?: string;
  quantity: number;
  unit?: string;
};

export type ValidatedItem = {
  /** Legacy free-text external id, untouched — this is NOT the canonical link. */
  productId: string | null;
  /** Canonical Product Master id, or null for UNMAPPED. */
  stockProductId: string | null;
  productName: string;
  quantity: number;
  /** The unit as supplied. Deliberately not replaced by the product's base unit:
   * an order recorded in crates was recorded in crates, and silently restating it in
   * kilos would rewrite what the customer actually asked for. */
  unit: string;
};

/**
 * Resolves a batch of order lines in one round trip.
 *
 * Only a single exact match sets the canonical link. An ambiguous name — which the
 * unique alias index should make impossible — is treated exactly like an unknown one:
 * left unmapped for a human, never resolved by picking a candidate.
 */
export async function validateProducts(items: RawIncomingItem[]): Promise<ValidatedItem[]> {
  const namesToResolve = items.filter((i) => !i.stock_product_id).map((i) => i.product_name ?? "");
  const resolutions = await resolveProductNames(namesToResolve);
  const matchedIds = items.flatMap((item) => {
    if (item.stock_product_id) return [item.stock_product_id];
    const resolution = resolutions.get(item.product_name ?? "");
    return resolution?.status === "matched" ? [resolution.product.id] : [];
  });
  const products = matchedIds.length
    ? await prisma.stockProduct.findMany({
        where: { id: { in: [...new Set(matchedIds)] }, active: true },
        select: { id: true, name: true, nameAr: true, unit: true, packagings: { where: { active: true }, select: { uomCode: true } } },
      })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  return items.map((item) => {
    const resolution = item.stock_product_id ? null : resolutions.get(item.product_name ?? "");
    const resolvedId = item.stock_product_id ?? (resolution?.status === "matched" ? resolution.product.id : undefined);
    const product = resolvedId ? byId.get(resolvedId) : undefined;
    if (item.stock_product_id && !product) throw new ApiError(400, "الصنف المختار مش موجود أو موقوف");
    if (resolvedId && !product) throw new ApiError(400, `الصنف "${item.product_name ?? ""}" موقوف في دليل الأصناف`);
    const unit = (item.unit ?? product?.unit ?? "KG").trim();
    if (product && unit !== product.unit && !product.packagings.some((p) => p.uomCode === unit)) {
      throw new ApiError(400, `الوحدة "${unit}" مش مضافة على كارت الصنف "${product.nameAr ?? product.name}"`);
    }
    const rawName = (item.product_name ?? "").trim();
    return {
      productId: item.product_id ?? null,
      stockProductId: product?.id ?? null,
      productName: product?.nameAr ?? product?.name ?? rawName.trim(),
      quantity: item.quantity,
      unit,
    };
  });
}

/** Single-item form, kept for callers that resolve one line at a time. */
export async function validateProduct(item: RawIncomingItem): Promise<ValidatedItem> {
  const [validated] = await validateProducts([item]);
  return validated;
}
