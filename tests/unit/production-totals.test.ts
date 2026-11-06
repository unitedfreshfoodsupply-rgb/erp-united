/* Today's production totals (lib/production.ts): one aggregation shared by
   GET /api/production/daily and the production board (PC-5). Rows group like the picking sheet:
   the catalogue product when linked, else the name, plus the unit (FLOOR-5). A product ordered in two units is
   two rows, and each row's drill-down lists only its own lines (UXO-13). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateProduction, isRejectedPreparation, productionKey, productionLines } from "../../lib/production";

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

test("rows group by the catalogue product when linked, else by the name as ordered, and the unit; kg and crates never add up", () => {
  const rows = aggregateProduction(orders);
  const by = new Map(rows.map((r) => [r.key, r]));
  assert.equal(rows.length, 5);
  assert.deepEqual(by.get("n:طماطم__KG"), { key: "n:طماطم__KG", productName: "طماطم", productNameEn: null, productNameAr: null, unit: "KG", required: 20, prepared: 12, orderCount: 1 });
  assert.deepEqual(by.get("p:p1__KG"), { key: "p:p1__KG", productName: "طماطم", productNameEn: "Tomatoes", productNameAr: "طماطم", unit: "KG", required: 5, prepared: 0, orderCount: 1 });
  assert.deepEqual(by.get("n:طماطم__CRATE"), { key: "n:طماطم__CRATE", productName: "طماطم", productNameEn: null, productNameAr: null, unit: "CRATE", required: 3, prepared: 0, orderCount: 1 });
  assert.deepEqual(by.get("p:p1__CRATE"), { key: "p:p1__CRATE", productName: "طماطم", productNameEn: "Tomatoes", productNameAr: "طماطم", unit: "CRATE", required: 2, prepared: 2, orderCount: 1 });
  assert.deepEqual(by.get("n:خس__PIECE"), { key: "n:خس__PIECE", productName: "خس", productNameEn: null, productNameAr: null, unit: "PIECE", required: 40, prepared: 40, orderCount: 1 });
});

test("the key is the picking sheet's card key: lines linked to one product are one row whatever their text (FLOOR-5)", () => {
  const rows = aggregateProduction([
    { id: "a", items: [item("طماطم", "KG", 10, 4, true)] },
    { id: "b", items: [item("Tomatoes", "KG", 6, null, true)] },
    { id: "c", items: [item("صنف 2", "KG", 7, null)] },
  ]);
  const by = new Map(rows.map((r) => [r.key, r]));
  assert.equal(rows.length, 2);
  assert.deepEqual(by.get("p:p1__KG"), { key: "p:p1__KG", productName: "طماطم", productNameEn: "Tomatoes", productNameAr: "طماطم", unit: "KG", required: 16, prepared: 4, orderCount: 2 });
  // An unlinked line keeps its own row and is never named after a linked one.
  assert.deepEqual(by.get("n:صنف 2__KG"), { key: "n:صنف 2__KG", productName: "صنف 2", productNameEn: null, productNameAr: null, unit: "KG", required: 7, prepared: 0, orderCount: 1 });
  assert.equal(productionKey({ productName: "x", unit: "KG", stockProductId: "p1" }), "p:p1__KG");
  assert.equal(productionKey({ productName: "x", unit: "KG", stockProductId: null }), "n:x__KG");
});

test("largest requirement first, the order the API has always returned", () => {
  assert.deepEqual(aggregateProduction(orders).map((r) => r.key), ["n:خس__PIECE", "n:طماطم__KG", "p:p1__KG", "n:طماطم__CRATE", "p:p1__CRATE"]);
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
  assert.deepEqual(kg.map((l) => [l.order.id, l.item.unit, l.item.requiredQuantity]), [["o1", "KG", 20]]);
  const linkedKg = productionLines(orders, productionKey({ productName: "طماطم", unit: "KG", stockProductId: "p1" }));
  assert.deepEqual(linkedKg.map((l) => [l.order.id, l.item.unit, l.item.requiredQuantity]), [["o2", "KG", 5]]);
  const crates = productionLines(orders, "n:طماطم__CRATE");
  assert.deepEqual(crates.map((l) => [l.order.id, l.item.unit, l.item.requiredQuantity]), [["o1", "CRATE", 3]]);
});

test("the drill-down lists every line of the row, so it adds up to the row's total (FLOOR-5)", () => {
  const two = [{ id: "a", items: [item("x", "KG", 10, null), item("y", "KG", 1, null), item("x", "KG", 11, 5)] }, { id: "b", items: [item("x", "KG", 4, null)] }];
  const lines = productionLines(two, "n:x__KG");
  assert.deepEqual(lines.map((l) => [l.order.id, l.item.requiredQuantity]), [["a", 10], ["a", 11], ["b", 4]]);
  const row = aggregateProduction(two).find((r) => r.key === "n:x__KG");
  assert.equal(lines.reduce((s, l) => s + l.item.requiredQuantity, 0), row?.required);
  assert.equal(row?.orderCount, 2);
});

test("no orders, no rows", () => {
  assert.deepEqual(aggregateProduction([]), []);
});

test("a rejected preparation is not counted as prepared (the picking sheet's rule)", () => {
  const rejected = { ...item("x", "KG", 7, 7), preparationStatus: "pending", notes: "[رفض: وزن ناقص]" };
  const done = { ...item("x", "KG", 5, 5), preparationStatus: "done", notes: null };
  // Pending with a quantity but no rejection note (a partial pick) still counts.
  const partial = { ...item("x", "KG", 4, 2), preparationStatus: "pending", notes: "ملاحظة" };
  assert.equal(isRejectedPreparation(rejected), true);
  assert.equal(isRejectedPreparation(done), false);
  assert.equal(isRejectedPreparation(partial), false);
  assert.equal(isRejectedPreparation({ preparationStatus: "pending", preparedQuantity: null, notes: "[رفض: x]" }), false);
  const row = aggregateProduction([{ id: "a", items: [rejected, done, partial] }]).find((r) => r.key === "n:x__KG");
  assert.equal(row?.required, 16);
  assert.equal(row?.prepared, 7);
});
