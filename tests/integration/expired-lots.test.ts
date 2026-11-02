/* Expired produce remains on hand for traceability but is never available to sales or dispatch.
   Scrap still takes expired lots first. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor, inTx, withSetting } from "./_db";
import { postOpeningStock, createScrap } from "@/lib/inventory/documents";
import { issueStock } from "@/lib/inventory/reservations";
import { productStockDetail } from "@/lib/inventory/products";
import { D } from "@/lib/inventory/decimal";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZEXP${Date.now()}`;
const who = actor("أمين المخزن", ["stock.view", "stock.adjust", "accounting.manage"]);
const shift = (days: number) => {
  const d = new Date(`${todayLocalISO()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
let sold = "";
let scrapped = "";

/** Two lots: one received 10 days ago that expired 3 days ago, one fresh. */
async function twoLots(name: string) {
  const id = (await prisma.stockProduct.create({ data: { name: `${TAG} ${name}` } })).id;
  await postOpeningStock({ business_date: shift(-10), lines: [{ product_id: id, quantity: 5, unit_cost: "4", expiry_date: shift(-3), location_id: "loc_cold_1" }] }, who);
  await postOpeningStock({ business_date: todayLocalISO(), lines: [{ product_id: id, quantity: 5, unit_cost: "6", expiry_date: shift(5), location_id: "loc_cold_1" }] }, who);
  return id;
}
const lots = async (productId: string) =>
  (await prisma.stockMovement.groupBy({ by: ["lotId"], where: { productId }, _sum: { quantity: true } })).map((r) => r);
const expiryOf = async (lotId: string | null) => (lotId ? (await prisma.stockLot.findUnique({ where: { id: lotId } }))!.expiryDate : null);
const sell = async (productId: string, qty: number, ref: string) => {
  const order = await prisma.order.create({ data: { orderNumber: `${TAG}-${ref}`, customerName: `${TAG} Hotel`, deliveryDate: todayLocalISO() } });
  return inTx((tx) => issueStock(tx, { warehouseId: "wh_main", sourceType: "order", sourceId: order.id, reference: `${TAG} ${ref}`, lines: [{ productId, quantity: D(qty), sourceLineId: `${TAG}-${ref}-1` }] }, who as any));
};

// These scenarios exercise the direct opening-stock form, closed by default since
// November 2026 (accounting.direct_opening_entries): switched on for the file only.
let restoreDirectOpening: () => Promise<void> = async () => {};
before(async () => {
  restoreDirectOpening = await withSetting("accounting.direct_opening_entries", true);
  sold = await twoLots("Lettuce");
  scrapped = await twoLots("Herbs");
});
after(async () => {
  await restoreDirectOpening();
  await prisma.$disconnect();
});

test("an expired lot can't be opening stock (it is waste, not stock) → 400", async () => {
  const id = (await prisma.stockProduct.create({ data: { name: `${TAG} Rocket` } })).id;
  await assert.rejects(postOpeningStock({ business_date: todayLocalISO(), lines: [{ product_id: id, quantity: 1, unit_cost: "1", expiry_date: shift(-1) }] }, who), (e: any) => e.status === 400 && /منتهية/.test(e.message));
});

test("a sale takes the fresh lot, not the expired one FEFO would put first", async () => {
  const r = await sell(sold, 3, "a");
  assert.deepEqual(r.expiredPicks, []);
  const out = await prisma.stockMovement.findMany({ where: { documentId: r.document.id } });
  assert.equal(out.length, 1);
  assert.equal(await expiryOf(out[0].lotId), shift(5));
  const left = Object.fromEntries(await Promise.all((await lots(sold)).map(async (l) => [await expiryOf(l.lotId), Number(l._sum.quantity)])));
  assert.deepEqual(left, { [shift(-3)]: 5, [shift(5)]: 2 });
});

test("the product screen lists the expired lot last (the order a sale takes them)", async () => {
  const d = await productStockDetail(sold, undefined, { withValue: false });
  const live = d.buckets.filter((b: any) => Number(b.quantity) > 0);
  assert.equal(live[live.length - 1].expiryDate, shift(-3));
});

test("when only expired stock remains, sales issue fails without moving the expired lot", async () => {
  await sell(sold, 2, "b"); // consume the two fresh kilos left by the earlier scenario
  await assert.rejects(sell(sold, 1, "c"), (e: any) => e.status === 400 && /الكمية المتاحة/.test(e.message));
  const left = Object.fromEntries(await Promise.all((await lots(sold)).map(async (l) => [await expiryOf(l.lotId), Number(l._sum.quantity)])));
  assert.deepEqual(left, { [shift(-3)]: 5, [shift(5)]: 0 });
});

test("scrap without naming a lot still takes the expired lot first (that is what is thrown away)", async () => {
  const doc = await createScrap({ reason: "منتهي", lines: [{ product_id: scrapped, quantity: 5 }] }, who);
  const out = await prisma.stockMovement.findMany({ where: { documentId: doc.document!.id } });
  assert.deepEqual(await Promise.all(out.map((m) => expiryOf(m.lotId))), [shift(-3)]);
});
