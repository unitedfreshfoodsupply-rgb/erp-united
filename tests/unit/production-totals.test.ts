/* Today's production totals (lib/production.ts): one aggregation shared by
   GET /api/production/daily and the production board (PC-5). A product ordered in two units is
   two rows, and each row's drill-down lists only its own lines (UXO-13). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateProduction, productionKey, productionLines } from "../../lib/production";

const tomato = { name: "Tomatoes", nameAr: "طماطم" };
const item = (productName: string, unit: string, requiredQuantity: number, preparedQuantity: number | null, linked = false) => ({
  productName,
  unit,
  requiredQuantity,
  preparedQuantity,
  stockProductId: linked ? "p1" : null,
  stockProduct: linked ? tomato : null,
});

const orders = [
  { id: "o1", items: [item("طماطم", "KG", 20, 12), item("طماطم", "CRATE", 3, null)] },
  { id: "o2", items: [item("طماطم", "KG", 5, null, true), item("خس", "PIECE", 40, 40)] },
  { id: "o3", items: [item("طماطم", "CRATE", 2, 2, true)] },
];

test("rows group by the name as ordered and the unit; kg and crates never add up", () => {
  const rows = aggregateProduction(orders);
  const by = new Map(rows.map((r) => [r.key, r]));
  assert.equal(rows.length, 3);
  assert.deepEqual(by.get("طماطم__KG"), { key: "طماطم__KG", productName: "طماطم", productNameEn: "Tomatoes", productNameAr: "طماطم", unit: "KG", required: 25, prepared: 12, orderCount: 2 });
  assert.deepEqual(by.get("طماطم__CRATE"), { key: "طماطم__CRATE", productName: "طماطم", productNameEn: "Tomatoes", productNameAr: "طماطم", unit: "CRATE", required: 5, prepared: 2, orderCount: 2 });
  assert.deepEqual(by.get("خس__PIECE"), { key: "خس__PIECE", productName: "خس", productNameEn: null, productNameAr: null, unit: "PIECE", required: 40, prepared: 40, orderCount: 1 });
});

test("largest requirement first, the order the API has always returned", () => {
  assert.deepEqual(aggregateProduction(orders).map((r) => r.key), ["خس__PIECE", "طماطم__KG", "طماطم__CRATE"]);
});

test("sums are free of float noise whatever order the lines come in", () => {
  const a = aggregateProduction([{ id: "a", items: [item("x", "KG", 0.1, 0.1), item("x", "KG", 0.2, 0.2)] }]);
  const b = aggregateProduction([{ id: "b", items: [item("x", "KG", 0.2, 0.2)] }, { id: "c", items: [item("x", "KG", 0.1, 0.1)] }]);
  assert.equal(a[0].required, 0.3);
  assert.equal(a[0].prepared, 0.3);
  assert.equal(b[0].required, a[0].required);
});

test("an order counts once per row however many lines it has", () => {
  const rows = aggregateProduction([{ id: "a", items: [item("x", "KG", 1, null), item("x", "KG", 2, null)] }]);
  assert.equal(rows[0].orderCount, 1);
  assert.equal(rows[0].required, 3);
});

test("the drill-down lists each order's own line for that product and unit", () => {
  const kg = productionLines(orders, productionKey({ productName: "طماطم", unit: "KG" }));
  assert.deepEqual(kg.map((l) => [l.order.id, l.item.unit, l.item.requiredQuantity]), [["o1", "KG", 20], ["o2", "KG", 5]]);
  const crates = productionLines(orders, "طماطم__CRATE");
  assert.deepEqual(crates.map((l) => [l.order.id, l.item.unit, l.item.requiredQuantity]), [["o1", "CRATE", 3], ["o3", "CRATE", 2]]);
});

test("no orders, no rows", () => {
  assert.deepEqual(aggregateProduction([]), []);
});
