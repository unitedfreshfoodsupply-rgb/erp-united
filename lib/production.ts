/**
 * Today's production per product line: what is required and what is prepared, summed over the
 * orders in productionScope (lib/orders-service.ts).
 *
 * One pure function for both readers (PC-5, Nov 2026): GET /api/production/daily runs it on
 * the orders it loads, and the production board runs it on the /api/orders?scope=production
 * list it already polls for the drill-down — so the board no longer fetches the same orders a
 * second time, and the totals and the order list under them cannot drift apart. No imports:
 * it runs in the browser as well as on the server.
 */

/** The fields of an order line the totals read (an OrderItemDTO, or the Prisma row). */
export type ProductionItemInput = {
  productName: string;
  unit: string;
  requiredQuantity: number;
  preparedQuantity: number | null;
  stockProductId?: string | null;
  /** The linked catalogue product's names (the line's stockProduct relation). */
  stockProduct?: { name: string; nameAr: string | null } | null;
};

export type ProductionOrderInput = { id: string; items: readonly ProductionItemInput[] };

export type ProductionRow = {
  /** The group: the name as ordered plus the unit. Also the board's React key and drill-down
   * key, so the same product ordered in kg and in crates stays two separate rows (UXO-13). */
  key: string;
  /** The name as ordered (the first line's text). */
  productName: string;
  /** The catalogue names, so the board shows the product in the UI language. */
  productNameEn: string | null;
  productNameAr: string | null;
  unit: string;
  required: number;
  prepared: number;
  orderCount: number;
};

/** The group a line belongs to. */
export function productionKey(item: { productName: string; unit: string }) {
  return `${item.productName}__${item.unit}`;
}

/** Quantities carry at most three decimals; rounding the sums keeps float noise
 * (0.1 + 0.2) out of the totals whatever order the lines were added in. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Per product line: required, prepared and the number of orders, largest requirement first. */
export function aggregateProduction(orders: readonly ProductionOrderInput[]): ProductionRow[] {
  const byKey = new Map<
    string,
    { productName: string; names: { name: string; nameAr: string | null } | null; linked: boolean; unit: string; required: number; prepared: number; orders: Set<string> }
  >();
  for (const order of orders) {
    for (const item of order.items) {
      const key = productionKey(item);
      let agg = byKey.get(key);
      if (!agg) {
        agg = { productName: item.productName, names: null, linked: false, unit: item.unit, required: 0, prepared: 0, orders: new Set() };
        byKey.set(key, agg);
      }
      // The first line linked to a catalogue product names the row.
      if (!agg.linked && item.stockProductId) {
        agg.linked = true;
        agg.names = item.stockProduct ?? null;
      }
      agg.required += item.requiredQuantity;
      agg.prepared += item.preparedQuantity ?? 0;
      agg.orders.add(order.id);
    }
  }
  return Array.from(byKey, ([key, v]) => ({
    key,
    productName: v.productName,
    productNameEn: v.names?.name || null,
    productNameAr: v.names?.nameAr || null,
    unit: v.unit,
    required: round3(v.required),
    prepared: round3(v.prepared),
    orderCount: v.orders.size,
  })).sort((a, b) => b.required - a.required);
}

/** The orders a row's drill-down lists, each with its own line for that product and unit. */
export function productionLines<O extends { items: readonly I[] }, I extends ProductionItemInput>(orders: readonly O[], key: string) {
  const out: { order: O; item: I }[] = [];
  for (const order of orders) {
    const item = order.items.find((i) => productionKey(i) === key);
    if (item) out.push({ order, item });
  }
  return out;
}
