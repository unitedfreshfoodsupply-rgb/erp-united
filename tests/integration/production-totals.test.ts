/* Today's production totals (PC-5, Nov 2026). The production board used to poll
   /api/production/daily and /api/orders?scope=production — the same orders twice every 5 s. It
   now computes the totals from the order list with the helper the daily route uses, so:
   - the route's totals equal the helper run on listOrders({ scope: "production" }) — the same
     numbers the board shows;
   - the route reads in a constant number of statements (no extra product-name query), whether
     the day has 5 lines or 50;
   - the same product ordered in kg and in crates stays two rows (UXO-13);
   - the picking sheet's summary gives totals per unit next to the old all-unit sums (UXO-10).
   Synthetic orders on the test database. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./_db";
import { dailyProduction, listOrders } from "@/lib/orders-service";
import { aggregateProduction } from "@/lib/production";
import { dailyConsolidatedSheet } from "@/lib/picking-sheet";

const TAG = `ZZPROD${Date.now()}`;
const orderIds: string[] = [];
let productId = "";
let seq = 0;

async function order(lines: { name: string; unit: string; qty: number; prepared?: number; linked?: boolean }[]) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${TAG}-${++seq}`,
      customerName: `${TAG} customer`,
      deliveryDate: "2099-01-01",
      status: "preparing",
      items: {
        create: lines.map((l) => ({
          productName: l.name,
          unit: l.unit,
          requiredQuantity: l.qty,
          preparedQuantity: l.prepared ?? null,
          stockProductId: l.linked ? productId : null,
        })),
      },
    },
  });
  orderIds.push(o.id);
  return o;
}

const byKey = (rows: { key: string }[]) => new Map(rows.map((r) => [r.key, r]));

before(async () => {
  productId = (await prisma.stockProduct.create({ data: { name: `${TAG} Tomatoes`, nameAr: `${TAG} طماطم`, unit: "KG" } })).id;
});
after(async () => {
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.stockProduct.delete({ where: { id: productId } });
  await prisma.$disconnect();
});

test("the daily totals are the helper's totals over the production order list", async () => {
  const name = `${TAG} طماطم`;
  await order([{ name, unit: "KG", qty: 20, prepared: 12 }, { name, unit: "CRATE", qty: 3 }]);
  await order([{ name, unit: "KG", qty: 5.5, linked: true }]);
  await order([{ name, unit: "CRATE", qty: 2, prepared: 2, linked: true }]);

  const daily = await dailyProduction();
  const board = aggregateProduction((await listOrders({ scope: "production" })).filter((o) => o.status !== "cancelled"));
  assert.deepEqual(byKey(daily), byKey(board));

  const rows = byKey(daily);
  assert.deepEqual(rows.get(`${name}__KG`), { key: `${name}__KG`, productName: name, productNameEn: `${TAG} Tomatoes`, productNameAr: `${TAG} طماطم`, unit: "KG", required: 25.5, prepared: 12, orderCount: 2 });
  assert.deepEqual(rows.get(`${name}__CRATE`), { key: `${name}__CRATE`, productName: name, productNameEn: `${TAG} Tomatoes`, productNameAr: `${TAG} طماطم`, unit: "CRATE", required: 5, prepared: 2, orderCount: 2 });
});

test("the daily totals read in a constant number of statements (5 lines or 50), with no name lookup", async () => {
  // Which tables each statement reads (the query events are on: ./_query-count is imported first).
  let tables: string[] = [];
  (prisma as unknown as { $on: (e: "query", cb: (ev: { query: string }) => void) => void }).$on("query", (ev) => {
    tables.push(/FROM "public"\."(\w+)"/.exec(ev.query)?.[1] ?? "?");
  });
  await order(Array.from({ length: 5 }, (_, i) => ({ name: `${TAG} small ${i}`, unit: "KG", qty: 1, linked: i % 2 === 0 })));
  tables = [];
  const small = await countQueries(() => dailyProduction());
  const smallTables = [...tables];
  for (let n = 0; n < 5; n++) await order(Array.from({ length: 10 }, (_, i) => ({ name: `${TAG} big ${n}-${i}`, unit: "KG", qty: 2, linked: true })));
  const large = await countQueries(() => dailyProduction());
  assert.equal(large.queries, small.queries, `5 lines: ${small.queries} statements, 55 lines: ${large.queries}`);
  // The product names come with the lines (one StockProduct read: the include), not from a
  // second lookup as before.
  assert.equal(smallTables.filter((t) => t === "StockProduct").length, 1, smallTables.join(", "));
  assert.equal(smallTables.length, small.queries, smallTables.join(", "));
});

test("the picking sheet totals per unit; the all-unit sums stay as they were", async () => {
  const name = `${TAG} خس`;
  await order([{ name, unit: "KG", qty: 300 }, { name, unit: "PIECE", qty: 200, prepared: 50 }]);
  const sheet = await dailyConsolidatedSheet("2099-01-01");
  const units = new Map(sheet.summary.byUnit.map((u) => [u.unit, u]));
  for (const unit of new Set(sheet.lines.map((l) => l.unit))) {
    const lines = sheet.lines.filter((l) => l.unit === unit);
    const sum = (k: "totalRequired" | "totalPrepared" | "totalLoaded" | "totalRemaining") => lines.reduce((s, l) => s + l[k], 0);
    assert.equal(units.get(unit)?.totalRequired, sum("totalRequired"), unit);
    assert.equal(units.get(unit)?.totalPrepared, sum("totalPrepared"), unit);
    assert.equal(units.get(unit)?.totalLoaded, sum("totalLoaded"), unit);
    assert.equal(units.get(unit)?.totalRemaining, sum("totalRemaining"), unit);
  }
  assert.ok(units.has("KG") && units.has("PIECE"), [...units.keys()].join(","));
  assert.equal(sheet.summary.byUnit.reduce((s, u) => s + u.totalRequired, 0), sheet.summary.totalRequired);
  assert.equal(sheet.summary.byUnit.reduce((s, u) => s + u.totalPrepared, 0), sheet.summary.totalPrepared);
});
