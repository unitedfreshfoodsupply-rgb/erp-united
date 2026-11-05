import { afterCommit, beforeCommit, inTx, type Tx } from "@/lib/tx";
import { ZERO, type Dec } from "@/lib/inventory/decimal";
import { bucketsWhere, isSellableStock, type Bucket } from "@/lib/inventory/balances";
import { todayLocalISO } from "@/lib/localDate";

/**
 * What a transaction did to sellable availability, per product (release gate, Nov 2026).
 *
 * Sellable availability is sellable on-hand minus active reservations (productAvailability).
 * It changes in exactly two places, and both report here: postMovements (every stock
 * movement, counted only where isSellableStock says the stock can be sold) and the
 * reservation functions (reserve −, release or consume +). At the end of the transaction the
 * products whose availability went UP, net, are handed once to the awaiting-stock check
 * (noteStockArrival), inside the same transaction: its notices commit or roll back with the
 * stock change.
 *
 * So every path that makes stock sellable tells the orders waiting for it the same way: a
 * receipt, an upward correction, grading after receipt (the Grade B SKU), opening stock, a
 * quarantine or hold release, a return, a reversal, a released reservation. A path that only
 * moves stock around (a transfer between shelves, a re-reservation, an issue against its own
 * reservation, a standard-cost re-layering) nets to zero and tells nobody. Stock going to waste,
 * quarantine, the legacy Grade B location or an expired lot is not sellable and never counts.
 *
 * Two transactions raising the same order's availability at once (a cancelled order beside a
 * receipt) each see only their own half before commit. So when the check found orders waiting,
 * it runs again once the transaction has committed: the last of them to commit then sees both.
 *
 * Stock leaving quarantine, net, from a lot a purchase order delivered also changes what that PO
 * still "brings" to the order lines it serves (stillOnOrder counts its held part): those orders'
 * suggestions are re-sized after commit, outside the stock transaction and its locks (release
 * gate D-1).
 */

type Actor = { id: string | null; name: string; role?: string };
type Pending = { deltas: Map<string, Dec>; quarantine: Map<string, Dec>; actor: Actor };

const pending = new WeakMap<object, Pending>();

/** `quarantine`: the quantity each lot gained (+) or lost (−) in quarantine locations. */
export async function availabilityChanged(tx: Tx, changes: { productId: string; delta: Dec }[], actor: Actor, quarantine: { lotId: string; delta: Dec }[] = []) {
  const live = changes.filter((c) => !c.delta.isZero());
  if (!live.length && !quarantine.length) return;
  let p = pending.get(tx);
  if (!p) {
    p = { deltas: new Map(), quarantine: new Map(), actor };
    pending.set(tx, p);
  }
  for (const c of live) p.deltas.set(c.productId, (p.deltas.get(c.productId) ?? ZERO).plus(c.delta));
  for (const q of quarantine) p.quarantine.set(q.lotId, (p.quarantine.get(q.lotId) ?? ZERO).plus(q.delta));
  // Outside inTx there is no end-of-transaction step: check now, for what this call changed.
  if (!beforeCommit(tx, "stock-arrival", () => flush(tx))) await flush(tx);
}

/**
 * Stock that did not move but changed whether it can be sold: a lot's expiry corrected, a
 * location's type changed. `before` and `after` restate each bucket of that lot or location as it
 * was and as it now is; the difference is reported like any movement.
 */
export async function sellabilityChanged(tx: Tx, where: { lotId: string } | { locationId: string }, before: (b: Bucket) => Bucket, after: (b: Bucket) => Bucket, actor: Actor) {
  const today = todayLocalISO();
  const sellable = (b: Bucket) => (isSellableStock(b, today) ? b.quantity : ZERO);
  const buckets = await bucketsWhere(tx, where);
  await availabilityChanged(tx, buckets.map((b) => ({ productId: b.productId, delta: sellable(after(b)).minus(sellable(before(b))) })), actor);
}

async function flush(tx: Tx) {
  const p = pending.get(tx);
  if (!p) return;
  pending.delete(tx);
  const risen = [...p.deltas].filter(([, d]) => d.gt(0)).map(([id]) => id).sort();
  const leftQuarantine = [...p.quarantine].filter(([, d]) => d.lt(0)).map(([lot]) => lot).sort();
  const actor = { id: p.actor.id, name: p.actor.name, role: p.actor.role ?? "SYSTEM" };
  // Imported when needed: both reach back into the ledger through the reservation code.
  if (risen.length) {
    const { noteStockArrival } = await import("@/lib/sales/stock-hold");
    const { held } = await noteStockArrival(tx, risen, actor);
    if (held) afterCommit(tx, "stock-arrival-recheck", () => inTx((t) => noteStockArrival(t, risen, actor)).then(() => undefined));
  }
  if (leftQuarantine.length) {
    const { syncSuggestionsForLots } = await import("@/lib/purchasing/requests");
    // Outside inTx (no after-commit step) it runs now, in the caller's transaction.
    if (!afterCommit(tx, "po-lots-resync", () => inTx((t) => syncSuggestionsForLots(t, leftQuarantine, actor)))) await syncSuggestionsForLots(tx, leftQuarantine, actor);
  }
}
