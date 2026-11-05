/* The stock controller's home page (/stock dashboard), Nov 2026.
   - UXO-10: receipts and the current balance are totalled per base unit — 300 kg and 200
     pieces are never one "500 kg" — while the all-unit figures stay exactly what the three
     separate aggregates used to return (now one grouped read for today, 7 days and the month).
   - ARC-5: each product's sellable figure follows the inventory module's one rule: waste
     awaiting write-off is on hand but not available.
   - The dashboard reads in a constant number of statements however many products hold stock.
   Synthetic receipts on the test database (today and the days before: a receipt cannot be
   dated in the future); the totals are compared with the old aggregates over the same windows. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { recordIntake, shiftDate, startOfMonth, stockDashboard } from "@/lib/stock-service";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZSDU${Date.now()}`;
const day = todayLocalISO();
const stock = { ...actor("حسام مخازن", ROLE_PERMISSIONS.STOCK_CONTROLLER as string[], null, "STOCK_CONTROLLER"), source: "user" as const };
let supplierId = "", kg = "", pieces = "";

async function product(label: string, unit: string) {
  return (await prisma.stockProduct.create({ data: { name: `${TAG} ${label}`, nameAr: `${TAG} ${label}`, unit } })).id;
}
const receive = (productId: string, received: number, extra: Record<string, unknown> = {}) =>
  recordIntake({ supplier_id: supplierId, product_id: productId, received_kg: received, unit_cost: "5", location_id: "loc_cold_1", received_date: day, ...extra } as never, stock as never);

async function aggregate(from: string, to: string) {
  const a = await prisma.stockIntake.aggregate({
    where: { status: "posted", receivedDate: { gte: from, lte: to } },
    _sum: { receivedQty: true, rejectedQty: true, goodQty: true, crateCount: true },
    _count: { _all: true },
  });
  return { receivedKg: Number(a._sum.receivedQty ?? 0), rejectedKg: Number(a._sum.rejectedQty ?? 0), goodKg: Number(a._sum.goodQty ?? 0), crates: a._sum.crateCount ?? 0, intakeCount: a._count._all };
}

before(async () => {
  stock.id = (await prisma.user.findFirst({ where: { username: "hossam" }, select: { id: true } }))?.id ?? null;
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "vegetable" } })).id;
  kg = await product("Tomatoes", "KG");
  pieces = await product("Lettuce", "PIECE");
});
after(async () => {
  await prisma.$disconnect();
});

test("receipts and the balance are totalled per unit; the all-unit figures are unchanged", async () => {
  await receive(kg, 300, { waste_qty: 20, crate_count: 12 });
  await receive(kg, 100, { rejected_kg: 10, rejection_reason: TAG });
  await receive(pieces, 200, { crate_count: 4 });
  await receive(kg, 50, { received_date: shiftDate(day, -3) });
  await receive(pieces, 7, { received_date: startOfMonth(day) });
  await receive(kg, 4, { received_date: shiftDate(day, -6) });

  const d = await stockDashboard(day);
  for (const [period, from] of [["today", day], ["week", shiftDate(day, -6)], ["month", startOfMonth(day)]] as const) {
    const old = await aggregate(from, day);
    const p = d[period];
    assert.deepEqual(
      { receivedKg: p.receivedKg, rejectedKg: p.rejectedKg, goodKg: p.goodKg, crates: p.crates, intakeCount: p.intakeCount },
      old,
      period
    );
    // Per unit, the parts add up to the old figures.
    assert.equal(p.byUnit.reduce((s, u) => s + u.received, 0), old.receivedKg, period);
    assert.equal(p.byUnit.reduce((s, u) => s + u.intakeCount, 0), old.intakeCount, period);
  }
  const today = new Map(d.today.byUnit.map((u) => [u.unit, u]));
  assert.equal(d.today.byUnit[0]?.unit, "KG", "kg first");
  assert.ok((today.get("KG")?.received ?? 0) >= 400 && (today.get("PIECE")?.received ?? 0) >= 200, JSON.stringify(d.today.byUnit));

  // The balance per unit: the parts of totalStockKg, kg apart from pieces.
  const units = new Map(d.stockTotalsByUnit.map((u) => [u.unit, u.balance]));
  for (const unit of new Set(d.currentStock.map((s) => s.unit))) {
    const sum = d.currentStock.filter((s) => s.unit === unit).reduce((s, p) => s + p.balanceKg, 0);
    assert.ok(Math.abs((units.get(unit) ?? 0) - sum) < 0.002, unit);
  }
  assert.ok(Math.abs(d.stockTotalsByUnit.reduce((s, u) => s + u.balance, 0) - d.totalStockKg) < 0.002);
});

test("waste awaiting write-off and quarantined stock are on hand but not available (the inventory module's rule)", async () => {
  const d = await stockDashboard(day);
  const row = d.currentStock.find((s) => s.productId === kg);
  const sell = d.sellable?.[kg];
  assert.ok(row && sell, "the product and its sellable figure are listed");
  // 300 with 20 waste: the waste sits in the waste location, and the 280 that survived sorting
  // wait in quarantine for the loss approval (CTL-01) — on hand, not for sale. 100 with 10
  // rejected (never in stock), 50 and 4 are in the cold room.
  assert.equal(row.balanceKg, 444);
  assert.deepEqual(sell, { available: 144, reserved: 0, unsellable: 300 });
  assert.deepEqual(d.sellable?.[pieces], { available: 207, reserved: 0, unsellable: 0 });
});

test("the dashboard reads in a constant number of statements (5 products in stock or 50)", async () => {
  for (let i = 0; i < 3; i++) await receive(await product(`small ${i}`, "KG"), 10);
  await stockDashboard(day); // warm the settings cache
  const small = await countQueries(() => stockDashboard(day));
  for (let i = 0; i < 45; i++) await receive(await product(`big ${i}`, i % 3 ? "KG" : "PIECE"), 10, { waste_qty: i % 2 });
  const large = await countQueries(() => stockDashboard(day));
  // Not one more statement for 45 more products (a relation Prisma finds empty is skipped, so the
  // count can only go down with the data, never up with the number of products).
  assert.ok(large.queries <= small.queries, `5 products: ${small.queries} statements, 50: ${large.queries}`);
});
