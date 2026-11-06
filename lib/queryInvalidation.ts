import type { QueryClient } from "@tanstack/react-query";

/**
 * Background reconciliation after a mutation.
 *
 * This deliberately does NOT await anything and is NOT how the screen updates. The
 * screen is already correct by the time this runs, because the mutation response was
 * written into the cache (see lib/orderCache.ts). This only marks the derived,
 * server-computed views — the picking sheet, the daily report, the audit timeline —
 * as stale so they refresh on their own.
 *
 * Awaiting a fan-out of invalidations was the single biggest source of the "every
 * click reloads the whole screen" feeling: it turned one round trip into four, with
 * the button disabled for all of them.
 */
export function invalidateDerivedOrderData(qc: QueryClient, orderId?: string) {
  // refetchType "active" so only queries currently mounted go to the network; the rest
  // are simply marked stale and will refetch if and when a screen needs them.
  // The production board totals the polled order list itself (lib/production.ts); the picking
  // sheet is the server-computed production view left.
  void qc.invalidateQueries({ queryKey: ["picking-sheet"], refetchType: "active" });
  void qc.invalidateQueries({ queryKey: ["report"], refetchType: "active" });
  if (orderId) void qc.invalidateQueries({ queryKey: ["audit", orderId], refetchType: "active" });
  void qc.invalidateQueries({ queryKey: ["audit", "all"], refetchType: "active" });
}

/**
 * Full refresh, for the cases where we genuinely do not know what changed — creating
 * or cloning an order (it belongs on boards we are not looking at) and supervisor
 * actions that can reshuffle several orders' priority at once.
 */
export function invalidateOrderData(qc: QueryClient, orderId?: string) {
  void qc.invalidateQueries({ queryKey: ["orders"], refetchType: "active" });
  if (orderId) void qc.invalidateQueries({ queryKey: ["order", orderId], refetchType: "active" });
  invalidateDerivedOrderData(qc, orderId);
}
