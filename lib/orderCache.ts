import type { QueryClient } from "@tanstack/react-query";
import type { OrderDTO, OrderItemDTO } from "@/lib/client-types";

/**
 * Writing mutation results straight into the cache.
 *
 * Every order mutation already returns the updated order (or item) — the server has
 * done the work and told us the answer. The app used to throw that response away and
 * then invalidate five query keys, so a single tap cost: one request to mutate, then
 * two-to-five more to re-read what we had just been told, with the button disabled and
 * the screen showing a spinner for the whole round trip.
 *
 * These helpers apply the response to every cached list and detail instead. The screen
 * updates from data the server actually returned — so it is correct, not optimistic —
 * and it costs zero additional requests. Background polling still runs and will
 * reconcile anything another device changed.
 */

type OrderListShape = { orders: OrderDTO[] };
type IntelShape = { orders: OrderDTO[]; intelligence?: unknown };

/** Boards that hold an order list. All are keyed ["orders", <board>]. */
const ORDERS_PREFIX = ["orders"] as const;

/**
 * Replace one order everywhere it is cached.
 *
 * A list only keeps the order if it still belongs there — a board showing
 * "new,preparing" must drop an order that just moved to ready_for_loading, otherwise
 * it lingers as a card that does nothing until the next poll. `belongsInList` is given
 * the list it is already in so it can decide from the statuses actually present,
 * without this module needing to know each board's filter.
 */
export function applyOrderToCache(qc: QueryClient, order: OrderDTO) {
  qc.setQueryData(["order", order.id], (prev: { order: OrderDTO } | undefined) =>
    prev ? { ...prev, order } : { order }
  );

  qc.setQueriesData({ queryKey: ORDERS_PREFIX }, (prev: unknown) => {
    if (!prev || typeof prev !== "object" || !("orders" in prev)) return prev;
    const listed = (prev as OrderListShape).orders;
    if (!Array.isArray(listed)) return prev;

    const index = listed.findIndex((o) => o.id === order.id);
    if (index === -1) return prev; // not this board's business

    // Which statuses this particular board shows, inferred from what it is holding.
    // If the order's new status isn't one of them, it has left this board.
    const shown = new Set(listed.map((o) => o.status));
    const stillBelongs = shown.has(order.status) || listed[index].status === order.status;

    const next = stillBelongs
      ? listed.map((o) => (o.id === order.id ? order : o))
      : listed.filter((o) => o.id !== order.id);

    return { ...(prev as IntelShape), orders: next };
  });
}

/** Replace one item inside its order, everywhere that order is cached. */
export function applyOrderItemToCache(qc: QueryClient, orderId: string, item: OrderItemDTO) {
  const patch = (order: OrderDTO): OrderDTO => ({
    ...order,
    items: order.items.map((i) => (i.id === item.id ? { ...i, ...item } : i)),
  });

  qc.setQueryData(["order", orderId], (prev: { order: OrderDTO } | undefined) =>
    prev ? { ...prev, order: patch(prev.order) } : prev
  );

  qc.setQueriesData({ queryKey: ORDERS_PREFIX }, (prev: unknown) => {
    if (!prev || typeof prev !== "object" || !("orders" in prev)) return prev;
    const listed = (prev as OrderListShape).orders;
    if (!Array.isArray(listed)) return prev;
    if (!listed.some((o) => o.id === orderId)) return prev;
    return {
      ...(prev as IntelShape),
      orders: listed.map((o) => (o.id === orderId ? patch(o) : o)),
    };
  });
}

/**
 * The order as the boards last saw it, used to render the detail page instantly on
 * navigation instead of showing a spinner for data we are already holding. The list
 * rows carry the order and its lines but not each line's catalogue product (the boards
 * never show it), so until the detail query's background refetch replaces this, a line
 * shows its as-ordered product name instead of the catalogue name.
 */
export function cachedOrderFromLists(qc: QueryClient, orderId: string): OrderDTO | undefined {
  const lists = qc.getQueriesData({ queryKey: ORDERS_PREFIX });
  for (const [, value] of lists) {
    if (!value || typeof value !== "object" || !("orders" in value)) continue;
    const listed = (value as OrderListShape).orders;
    if (!Array.isArray(listed)) continue;
    const found = listed.find((o) => o.id === orderId);
    if (found) return found;
  }
  return undefined;
}
