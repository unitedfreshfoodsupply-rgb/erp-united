/**
 * List prices for the manual order form (Nov 2026): every line's (product, unit) in one call.
 *
 * GET /api/orders/entry/price answers one (product, unit) with the customer's lists in order
 * (its own list, then the default) and effectivePrice on each. Done once per line, a 30-line
 * order cost hundreds of calls. This answers any number of pairs in a fixed number of
 * statements — the lists once, every candidate price row in one read, units and packagings in
 * one each — and runs effectivePrice itself over what was read, so the judgement is the same.
 */
import type { PriceListItem, ProductPackaging, UnitOfMeasure } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { effectivePrice, priceListsFor } from "@/lib/sales/pricing";

export type EntryPriceKey = { productId: string; unit: string };
export type EntryPrice = { unitPrice: string | null; priceList: { id: string; code: string } | null };

/** "productId|unit" — how the form and the response name a pair. */
export const entryPriceKey = (k: EntryPriceKey) => `${k.productId}|${k.unit}`;

export async function entryListPrices(customerId: string | null, date: string, keys: EntryPriceKey[]): Promise<Map<string, EntryPrice>> {
  const out = new Map<string, EntryPrice>();
  const productIds = [...new Set(keys.map((k) => k.productId))];
  if (!productIds.length) return out;
  const [products, lists] = await Promise.all([
    prisma.stockProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, unit: true } }),
    priceListsFor(prisma, customerId),
  ]);
  const productBy = new Map(products.map((p) => [p.id, p]));
  const codes = [...new Set([...keys.map((k) => k.unit), ...products.map((p) => p.unit)])];
  const [rows, uoms, packs] = await Promise.all([
    lists.length
      ? prisma.priceListItem.findMany({
          where: { priceListId: { in: lists.map((l) => l.id) }, productId: { in: productIds }, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] },
          orderBy: { validFrom: "desc" },
        })
      : Promise.resolve([] as PriceListItem[]),
    prisma.unitOfMeasure.findMany({ where: { code: { in: codes } } }),
    prisma.productPackaging.findMany({ where: { productId: { in: productIds } } }),
  ]);
  // The three lookups effectivePrice (and toBaseQuantity inside it) makes, answered from what
  // was just read: the date filter is already applied, the order is the query's own.
  const uomBy = new Map<string, UnitOfMeasure>(uoms.map((u) => [u.code, u]));
  const packBy = new Map<string, ProductPackaging>(packs.map((p) => [`${p.productId}|${p.uomCode}`, p]));
  const reads = {
    priceListItem: {
      findMany: async ({ where }: { where: { priceListId: string; productId: string; uomCode: { in: string[] } } }) =>
        rows.filter((r) => r.priceListId === where.priceListId && r.productId === where.productId && where.uomCode.in.includes(r.uomCode)),
    },
    unitOfMeasure: { findUnique: async ({ where }: { where: { code: string } }) => uomBy.get(where.code) ?? null },
    productPackaging: {
      findUnique: async ({ where }: { where: { productId_uomCode: { productId: string; uomCode: string } } }) =>
        packBy.get(`${where.productId_uomCode.productId}|${where.productId_uomCode.uomCode}`) ?? null,
    },
  } as unknown as Parameters<typeof effectivePrice>[0];

  for (const k of keys) {
    const key = entryPriceKey(k);
    if (out.has(key)) continue;
    const product = productBy.get(k.productId);
    let price: EntryPrice = { unitPrice: null, priceList: null };
    if (product) {
      for (const list of lists) {
        const found = await effectivePrice(reads, { priceListId: list.id, product, lineUom: k.unit, date });
        if (found) {
          price = { unitPrice: found.unitPrice.toFixed(), priceList: { id: list.id, code: list.code } };
          break;
        }
      }
    }
    out.set(key, price);
  }
  return out;
}
