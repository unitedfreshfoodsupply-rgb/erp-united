import { prisma } from "@/lib/prisma";
import type { Tx } from "@/lib/tx";
import { D, ZERO, type Dec } from "@/lib/inventory/decimal";
import { todayLocalISO } from "@/lib/localDate";

/**
 * Read side of the ledger. Nothing here stores a balance: on-hand is SUM(quantity)
 * over movements, reserved is SUM(quantity) over active reservations, and
 * available = on-hand - quarantined - reserved.
 */

type Db = Pick<Tx, "stockMovement" | "stockReservation" | "storageLocation" | "stockLot">;

export type Bucket = {
  productId: string;
  warehouseId: string;
  locationId: string;
  locationCode: string;
  locationType: string;
  lotId: string | null;
  lotNumber: string | null;
  receivedDate: string | null;
  expiryDate: string | null;
  quantity: Dec;
};

/** Every non-zero bucket of a product in a warehouse (optionally one location). */
export async function productBuckets(
  db: Db,
  productId: string,
  warehouseId: string,
  opts: { locationId?: string } = {}
): Promise<Bucket[]> {
  const sums = await db.stockMovement.groupBy({
    by: ["locationId", "lotId"],
    where: { productId, warehouseId, ...(opts.locationId ? { locationId: opts.locationId } : {}) },
    _sum: { quantity: true },
  });
  return toBuckets(db, sums.map((s) => ({ ...s, productId })), warehouseId);
}

/** productBuckets for many products at once (three queries whatever their number), by product. */
export async function productsBuckets(db: Db, productIds: string[], warehouseId: string): Promise<Map<string, Bucket[]>> {
  const out = new Map<string, Bucket[]>();
  if (!productIds.length) return out;
  const sums = await db.stockMovement.groupBy({ by: ["productId", "locationId", "lotId"], where: { productId: { in: [...new Set(productIds)] }, warehouseId }, _sum: { quantity: true } });
  for (const b of await toBuckets(db, sums, warehouseId)) {
    const list = out.get(b.productId);
    if (list) list.push(b);
    else out.set(b.productId, [b]);
  }
  return out;
}

/** Every non-zero bucket of one lot or one location, whatever the product (a lot's expiry or a
 * location's type corrected: what it holds becomes sellable, or stops being). */
export async function bucketsWhere(db: Db, where: { lotId: string } | { locationId: string }): Promise<Bucket[]> {
  const sums = await db.stockMovement.groupBy({ by: ["productId", "warehouseId", "locationId", "lotId"], where, _sum: { quantity: true } });
  return toBuckets(db, sums, null);
}

/** Grouped movement sums → buckets with their location and lot (zero buckets dropped). */
async function toBuckets(db: Db, sums: { productId: string; warehouseId?: string; locationId: string; lotId: string | null; _sum: { quantity: Dec | null } }[], warehouseId: string | null): Promise<Bucket[]> {
  const live = sums.filter((s) => !D(s._sum.quantity).isZero());
  if (live.length === 0) return [];
  const [locations, lots] = await Promise.all([
    db.storageLocation.findMany({ where: { id: { in: [...new Set(live.map((s) => s.locationId))] } } }),
    db.stockLot.findMany({ where: { id: { in: live.map((s) => s.lotId).filter((x): x is string => !!x) } } }),
  ]);
  const loc = new Map(locations.map((l) => [l.id, l]));
  const lot = new Map(lots.map((l) => [l.id, l]));
  return live.map((s) => ({
    productId: s.productId,
    warehouseId: s.warehouseId ?? warehouseId ?? "",
    locationId: s.locationId,
    locationCode: loc.get(s.locationId)?.code ?? "?",
    locationType: loc.get(s.locationId)?.type ?? "other",
    lotId: s.lotId,
    lotNumber: s.lotId ? lot.get(s.lotId)?.lotNumber ?? null : null,
    receivedDate: s.lotId ? lot.get(s.lotId)?.receivedDate ?? null : null,
    expiryDate: s.lotId ? lot.get(s.lotId)?.expiryDate ?? null : null,
    quantity: D(s._sum.quantity),
  }));
}

export async function reservedQty(db: Pick<Tx, "stockReservation">, productId: string, warehouseId: string): Promise<Dec> {
  const agg = await db.stockReservation.aggregate({
    where: { productId, warehouseId, status: "active" },
    _sum: { quantity: true },
  });
  return D(agg._sum.quantity);
}

/**
 * The one rule for "this stock can be sold": not in quarantine or waste, not the legacy second
 * grade kept on the first-grade product (loc_grade_b), not in an expired lot. Availability and
 * the awaiting-stock check (lib/inventory/availability-changes.ts) both read it.
 */
export function isSellableStock(b: { locationId: string; locationType: string | undefined; expiryDate: string | null | undefined }, asOf: string) {
  if (b.expiryDate && b.expiryDate < asOf) return false;
  return b.locationType !== "quarantine" && b.locationType !== "waste" && b.locationId !== "loc_grade_b";
}

export async function productAvailability(db: Db, productId: string, warehouseId: string, asOf = todayLocalISO()) {
  const [buckets, reserved] = await Promise.all([productBuckets(db, productId, warehouseId), reservedQty(db, productId, warehouseId)]);
  return summarize(buckets, reserved, asOf);
}

function summarize(buckets: Bucket[], reserved: Dec, asOf: string) {
  let onHand = ZERO;
  let quarantined = ZERO;
  let expired = ZERO;
  let sellableOnHand = ZERO;
  for (const b of buckets) {
    onHand = onHand.plus(b.quantity);
    if (b.locationType === "quarantine") quarantined = quarantined.plus(b.quantity);
    if (b.expiryDate && b.expiryDate < asOf) expired = expired.plus(b.quantity);
    if (isSellableStock(b, asOf)) sellableOnHand = sellableOnHand.plus(b.quantity);
  }
  const available = sellableOnHand.minus(reserved);
  return { onHand, quarantined, expired, sellableOnHand, reserved, available, buckets };
}

/**
 * productAvailability for many products at once, in four queries whatever their number (the
 * awaiting-stock check reads every product of every order waiting on a receipt). Same rule.
 */
export async function productsAvailability(db: Db, productIds: string[], warehouseId: string, asOf = todayLocalISO()) {
  const ids = [...new Set(productIds)];
  const out = new Map<string, ReturnType<typeof summarize>>();
  if (!ids.length) return out;
  const [buckets, reservations] = await Promise.all([
    productsBuckets(db, ids, warehouseId),
    db.stockReservation.groupBy({ by: ["productId"], where: { productId: { in: ids }, warehouseId, status: "active" }, _sum: { quantity: true } }),
  ]);
  const reserved = new Map(reservations.map((r) => [r.productId, D(r._sum.quantity)]));
  for (const id of ids) out.set(id, summarize(buckets.get(id) ?? [], reserved.get(id) ?? ZERO, asOf));
  return out;
}

/** On-hand / reserved / available for every stock-tracked product in a warehouse,
 * with reorder signals — one grouped query per measure, not one per product. */
export async function warehouseStock(warehouseId: string) {
  const [sums, reservations, products, value] = await Promise.all([
    prisma.stockMovement.groupBy({ by: ["productId", "locationId", "lotId"], where: { warehouseId }, _sum: { quantity: true } }),
    prisma.stockReservation.groupBy({ by: ["productId"], where: { warehouseId, status: "active" }, _sum: { quantity: true } }),
    prisma.stockProduct.findMany({ where: { stockTracked: true }, orderBy: { name: "asc" } }),
    prisma.stockValuationLayer.groupBy({ by: ["productId"], _sum: { quantity: true, value: true } }),
  ]);
  const by = <T extends { productId: string }>(rows: T[]) => new Map(rows.map((r) => [r.productId, r]));
  const rBy = by(reservations);
  const vBy = by(value);
  const liveSums = sums.filter((s) => !D(s._sum.quantity).isZero());
  const [locations, lots] = await Promise.all([
    prisma.storageLocation.findMany({ where: { id: { in: [...new Set(liveSums.map((s) => s.locationId))] } }, select: { id: true, type: true } }),
    prisma.stockLot.findMany({ where: { id: { in: liveSums.map((s) => s.lotId).filter((id): id is string => Boolean(id)) } }, select: { id: true, expiryDate: true } }),
  ]);
  const locationsById = new Map(locations.map((l) => [l.id, l]));
  const lotsById = new Map(lots.map((l) => [l.id, l]));
  const stockByProduct = new Map<string, { onHand: Dec; quarantined: Dec; expired: Dec; sellableOnHand: Dec }>();
  for (const row of liveSums) {
    const qty = D(row._sum.quantity);
    const totals = stockByProduct.get(row.productId) ?? { onHand: ZERO, quarantined: ZERO, expired: ZERO, sellableOnHand: ZERO };
    const location = locationsById.get(row.locationId);
    const expiry = row.lotId ? lotsById.get(row.lotId)?.expiryDate ?? null : null;
    totals.onHand = totals.onHand.plus(qty);
    if (location?.type === "quarantine") totals.quarantined = totals.quarantined.plus(qty);
    if (expiry && expiry < todayLocalISO()) totals.expired = totals.expired.plus(qty);
    if (isSellableStock({ locationId: row.locationId, locationType: location?.type, expiryDate: expiry }, todayLocalISO())) totals.sellableOnHand = totals.sellableOnHand.plus(qty);
    stockByProduct.set(row.productId, totals);
  }
  return products
    .map((p) => {
      const totals = stockByProduct.get(p.id) ?? { onHand: ZERO, quarantined: ZERO, expired: ZERO, sellableOnHand: ZERO };
      const { onHand, quarantined, expired, sellableOnHand } = totals;
      const reserved = D(rBy.get(p.id)?._sum.quantity);
      const available = sellableOnHand.minus(reserved);
      const v = vBy.get(p.id)?._sum;
      const totalQty = D(v?.quantity);
      const totalValue = D(v?.value);
      const avgCost = totalQty.gt(0) ? totalValue.dividedBy(totalQty) : null;
      const belowReorder = p.reorderPointQty != null && available.lessThan(D(p.reorderPointQty));
      const belowMin = p.minStockQty != null && onHand.lessThan(D(p.minStockQty));
      return {
        productId: p.id,
        productName: p.name,
        productNameAr: p.nameAr,
        unit: p.unit,
        active: p.active,
        onHand,
        quarantined,
        expired,
        sellableOnHand,
        reserved,
        available,
        averageCost: avgCost ? avgCost.toDecimalPlaces(4) : null,
        stockValue: totalValue.toDecimalPlaces(2),
        reorderPointQty: p.reorderPointQty,
        minStockQty: p.minStockQty,
        maxStockQty: p.maxStockQty,
        belowReorder,
        belowMin,
      };
    })
    .filter((r) => r.active || !r.onHand.isZero());
}
