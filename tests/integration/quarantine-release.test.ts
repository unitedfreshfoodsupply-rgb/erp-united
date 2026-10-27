/* Quarantined stock: never picked automatically, never counted as available — but when an
   operator names the quarantine location explicitly it can be scrapped (bad produce), and
   stock found fine on inspection leaves through the release workflow (F-03), naming the
   bucket's lot, never by a plain transfer. The location this test
   creates is emptied and deactivated afterwards, so other suites never route returns to it. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { postOpeningStock, createScrap, createTransfer, releaseFromQuarantine } from "@/lib/inventory/documents";
import { productStockDetail } from "@/lib/inventory/products";

const TAG = `ZZQUAR${Date.now()}`;
const who = actor("أمين المخزن", ["stock.view", "stock.transfer", "stock.adjust", "accounting.manage"]);
let productId = "";
let quarId = "";

before(async () => {
  productId = (await prisma.stockProduct.create({ data: { name: `${TAG} Tomato` } })).id;
  quarId = (await prisma.storageLocation.create({ data: { warehouseId: "wh_main", code: TAG.slice(-12), name: "Quarantine (test)", type: "quarantine" } })).id;
  await postOpeningStock({ lines: [{ product_id: productId, quantity: 10, unit_cost: "6", location_id: "loc_cold_1" }] }, who);
});

after(async () => {
  await prisma.storageLocation.update({ where: { id: quarId }, data: { active: false } });
  await prisma.$disconnect();
});

const detail = () => productStockDetail(productId, undefined, { withValue: false });

test("stock moved into quarantine stays on hand but is not available", async () => {
  await createTransfer({ reason: "فحص", lines: [{ product_id: productId, quantity: 4, location_id: "loc_cold_1", to_location_id: quarId }] }, who);
  const d = await detail();
  assert.equal(d.onHand.toString(), "10");
  assert.equal(d.available.toString(), "6");
});

test("automatic picking never takes quarantined stock", async () => {
  // Scrap without naming a location: only the 6 available kg can be picked.
  await assert.rejects(createScrap({ reason: "x", lines: [{ product_id: productId, quantity: 7 }] }, who), (e: any) => e.status === 400);
});

test("a plain transfer out of quarantine is refused: release is the only way out", async () => {
  await assert.rejects(createTransfer({ reason: "x", lines: [{ product_id: productId, quantity: 3, location_id: quarId, to_location_id: "loc_cold_2" }] }, who), (e: any) => e.status === 400);
});

test("naming the quarantine location: scrap 1 kg (no lot needed), release 3 kg to a cold room", async () => {
  await createScrap({ reason: "تالف بعد الفحص", lines: [{ product_id: productId, quantity: 1, location_id: quarId }] }, who);
  const held = (await detail()).buckets.find((b: any) => b.locationId === quarId && Number(b.quantity) > 0);
  assert.ok(held, "the quarantine bucket holds the remaining 3 kg");
  await releaseFromQuarantine({ product_id: productId, location_id: quarId, lot_id: held.lotId ?? undefined, destination_id: "loc_cold_2", quantity: 3, reason: "سليم بعد الفحص" }, who);
  const d = await detail();
  assert.equal(d.onHand.toString(), "9");
  assert.equal(d.available.toString(), "9");
  assert.equal(d.buckets.filter((b: any) => b.locationId === quarId && Number(b.quantity) > 0).length, 0);
});
