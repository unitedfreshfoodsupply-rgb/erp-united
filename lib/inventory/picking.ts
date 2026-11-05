import { ApiError } from "@/lib/rbac";
import { advisoryXactLock, advisoryXactLocks } from "@/lib/dbLock";
import type { Tx } from "@/lib/tx";
import { ZERO, type Dec } from "@/lib/inventory/decimal";
import { productBuckets, reservedQty, type Bucket } from "@/lib/inventory/balances";

/**
 * Which buckets a removal comes out of.
 *
 * FEFO (default for perishables): earliest expiry first; lots without an expiry after
 * those with one. FIFO: earliest received first. Either way, stock recorded before lots
 * existed (no lot) is the oldest stock in the building and goes first. Quarantined
 * locations are never picked from — held stock is not available stock.
 */

/** Serialises everything that compares stock against reservations for one product in
 * one warehouse: reserving, and removals that must leave reserved stock alone. Taken
 * BEFORE any valuation or bucket lock (global order: availability → valuation → bucket). */
export function lockAvailability(tx: Tx, productId: string, warehouseId: string) {
  return advisoryXactLock(tx, `stock-avail:${productId}:${warehouseId}`);
}

/** lockAvailability for several products in one statement, in the same sorted order. */
export function lockAvailabilities(tx: Tx, productIds: Iterable<string>, warehouseId: string) {
  return advisoryXactLocks(tx, [...productIds].map((id) => `stock-avail:${id}:${warehouseId}`));
}
/**
 * `expiredLastOn` (a business date): lots already past their expiry on that date go
 * after every sellable lot. Used for sales issues, so FEFO never hands a customer an
 * expired lot while a good one is on the books. (Scrap and supplier returns leave it
 * unset: there the expired lot is exactly what should go first.)
 */
export function orderBuckets(buckets: Bucket[], strategy: "fefo" | "fifo", opts: { expiredLastOn?: string } = {}): Bucket[] {
  const legacy = (b: Bucket) => (b.lotId ? 1 : 0);
  const on = opts.expiredLastOn;
  const expired = (b: Bucket) => (on && b.expiryDate && b.expiryDate < on ? 1 : 0);
  return [...buckets].sort((a, b) => {
    const x = expired(a) - expired(b);
    if (x !== 0) return x;
    const l = legacy(a) - legacy(b);
    if (l !== 0) return l;
    if (strategy === "fefo") {
      const ea = a.expiryDate ?? "9999-12-31";
      const eb = b.expiryDate ?? "9999-12-31";
      if (ea !== eb) return ea < eb ? -1 : 1;
    }
    const ra = a.receivedDate ?? "";
    const rb = b.receivedDate ?? "";
    if (ra !== rb) return ra < rb ? -1 : 1;
    // Lot numbers are allocated in sequence, so they break same-day ties in arrival
    // order; the location code makes the result fully deterministic.
    const la = a.lotNumber ?? "";
    const lb = b.lotNumber ?? "";
    if (la !== lb) return la < lb ? -1 : 1;
    return a.locationCode.localeCompare(b.locationCode);
  });
}

/**
 * What earlier lines of the SAME document have already taken, bucket by bucket.
 * A document plans all its picks before posting any of them, so the database
 * balances do not yet reflect line 1 when line 2 is allocated; without this, two
 * lines of one product would both be handed the same kilos. One instance per document.
 */
export class PickClaims {
  private taken = new Map<string, Dec>();
  private static key(productId: string, locationId: string, lotId: string | null) {
    return `${productId}|${locationId}|${lotId ?? ""}`;
  }
  get(productId: string, locationId: string, lotId: string | null): Dec {
    return this.taken.get(PickClaims.key(productId, locationId, lotId)) ?? ZERO;
  }
  add(productId: string, locationId: string, lotId: string | null, qty: Dec) {
    const k = PickClaims.key(productId, locationId, lotId);
    this.taken.set(k, (this.taken.get(k) ?? ZERO).plus(qty));
  }
}

export type Pick = { locationId: string; lotId: string | null; quantity: Dec; lotNumber: string | null; locationCode: string; expiryDate: string | null };

type AllocateInput = {
  productId: string;
  productName: string;
  warehouseId: string;
  quantity: Dec;
  strategy: "fefo" | "fifo";
  /** Restrict to one location (e.g. "scrap what is in COLD-2"). */
  locationId?: string;
  /** Leave this much untouched for active reservations (default: all of them). */
  protectReserved?: boolean;
  /** Picks already planned by earlier lines of the same document; updated here. */
  claims?: PickClaims;
  /** Display ordering only: lots expired on this date sort after sellable lots. */
  expiredLastOn?: string;
  /** Food-safety gate: expired lots are not eligible for customer deliveries. */
  excludeExpiredOn?: string;
};

export async function allocate(tx: Tx, input: AllocateInput): Promise<Pick[]> {
  if (input.protectReserved !== false) await lockAvailability(tx, input.productId, input.warehouseId);
  const ordered = pickableBuckets(await productBuckets(tx, input.productId, input.warehouseId, { locationId: input.locationId }), input);
  const reserved = protectsReservations(ordered, input) ? await reservedQty(tx, input.productId, input.warehouseId) : ZERO;
  return takePicks(ordered, reserved, input);
}

/**
 * allocate() from buckets and reservations the caller has already read (a document picking many
 * lines reads them once for all its products). `buckets` are the product's buckets in the
 * warehouse as productBuckets returns them; `reserved` is what is actively reserved of the product
 * there right now. The caller holds the availability lock. Same rule, same picks, same refusal.
 */
export function allocateFrom(buckets: Bucket[], reserved: Dec, input: Omit<AllocateInput, "protectReserved">): Pick[] {
  const ordered = pickableBuckets(input.locationId === undefined ? buckets : buckets.filter((b) => b.locationId === input.locationId), input);
  return takePicks(ordered, protectsReservations(ordered, input) ? reserved : ZERO, input);
}

/** The buckets a pick may come from, best first, net of what earlier lines already claimed. */
function pickableBuckets(buckets: Bucket[], input: AllocateInput): Bucket[] {
  const claims = input.claims;
  const eligible = buckets
    .map((b) => (claims ? { ...b, quantity: b.quantity.minus(claims.get(input.productId, b.locationId, b.lotId)) } : b))
    // Quarantine and waste never feed automatic picking. When the operator names a location
    // explicitly (scrap what came back, move inspected goods to a cold room, dispose waste),
    // that location is what they mean — quarantine and waste included.
    .filter((b) => b.quantity.gt(0)
      && (input.locationId !== undefined || (b.locationType !== "quarantine" && b.locationType !== "waste" && b.locationId !== "loc_grade_b"))
      && !(input.excludeExpiredOn && b.expiryDate && b.expiryDate < input.excludeExpiredOn));
  return orderBuckets(eligible, input.strategy, { expiredLastOn: input.expiredLastOn });
}

/** Reservations are held against available stock, which excludes quarantine, so goods
 * taken out of quarantine never eat into what is reserved for orders. */
function protectsReservations(ordered: Bucket[], input: AllocateInput) {
  const fromQuarantine = ordered.length > 0 && ordered.every((b) => b.locationType === "quarantine");
  return !(input.protectReserved === false || fromQuarantine);
}

function takePicks(ordered: Bucket[], reserved: Dec, input: AllocateInput): Pick[] {
  const pickable = ordered.reduce((s, b) => s.plus(b.quantity), ZERO);
  const free = pickable.minus(reserved);
  if (free.lessThan(input.quantity)) {
    throw new ApiError(
      400,
      `الكمية المتاحة من "${input.productName}" ${free.lt(0) ? "0" : free.toFixed()}${reserved.gt(0) ? ` (فيه ${reserved.toFixed()} محجوز)` : ""}، والمطلوب ${input.quantity.toFixed()}`
    );
  }
  const picks: Pick[] = [];
  let left = input.quantity;
  for (const b of ordered) {
    if (left.isZero()) break;
    const take = left.lessThan(b.quantity) ? left : b.quantity;
    picks.push({ locationId: b.locationId, lotId: b.lotId, quantity: take, lotNumber: b.lotNumber, locationCode: b.locationCode, expiryDate: b.expiryDate });
    input.claims?.add(input.productId, b.locationId, b.lotId, take);
    left = left.minus(take);
  }
  return picks;
}
