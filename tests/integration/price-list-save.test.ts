/* Saving a price list in a fixed number of statements (PW-4, Nov 2026). setPrices handled one
   price at a time (~4 round trips each): the daily update of ~130+ prices ran past the 20 s
   transaction limit and saved nothing. The batched save must leave exactly what pricing the same
   prices one by one leaves — rows, counts, audit rows, refusals — and cost the same for 10 or 200
   prices. Synthetic data on the test database. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createPriceList, setPrices } from "@/lib/sales/pricing";
import { ApiError } from "@/lib/rbac";

const TAG = `ZZPLS${Date.now()}`;
const admin = () => ({ ...actor("أدمن الأسعار", [...ROLE_PERMISSIONS.SUPER_ADMIN], null, "SUPER_ADMIN"), source: "manual" as const });
const products: string[] = [];
let list = 0;
const newList = async () => (await createPriceList({ code: `${TAG}${++list}`.toUpperCase(), name: `${TAG} ${list}` }, admin() as never)).id;

before(async () => {
  for (let i = 0; i < 205; i++) products.push((await prisma.stockProduct.create({ data: { name: `${TAG} صنف ${String(i).padStart(3, "0")}`, unit: "KG" } })).id);
  await prisma.productPackaging.create({ data: { productId: products[0], uomCode: "CRATE", qtyInBaseUnit: 10 } });
});
after(async () => {
  await prisma.$disconnect();
});

const snapshot = async (listId: string) => ({
  rows: (await prisma.priceListItem.findMany({ where: { priceListId: listId }, orderBy: [{ productId: "asc" }, { uomCode: "asc" }, { validFrom: "asc" }] })).map((r) => [r.productId, r.uomCode, r.unitPrice.toFixed(), r.validFrom, r.validTo, r.createdBy]),
  audits: (await prisma.auditLog.findMany({ where: { entityType: "price_list", entityId: listId, action: { in: ["price_set", "price_corrected"] } } })).map((a) => [a.action, a.fieldChanged, a.oldValue, a.newValue, a.reason]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
});
/** The same prices, one call per price: what the line-by-line loop did. */
async function oneByOne(listId: string, input: { valid_from: string; valid_to?: string | null; reason?: string; prices: { product_id: string; uom?: string; unit_price: string }[] }) {
  let created = 0, replaced = 0;
  for (const p of input.prices) {
    const r = await setPrices(listId, { ...input, prices: [p] }, admin() as never);
    created += r.created;
    replaced += r.replaced;
  }
  return { created, replaced };
}

test("the batched save leaves what pricing one by one leaves: rows, counts, audit rows — duplicates, corrections, units", async () => {
  const [a, b] = [await newList(), await newList()];
  const first = { valid_from: "2096-01-10", reason: TAG, prices: [{ product_id: products[1], unit_price: "10" }, { product_id: products[2], unit_price: "20" }] };
  await setPrices(a, first, admin() as never);
  await setPrices(b, first, admin() as never);
  const input = {
    valid_from: "2096-01-10",
    valid_to: "2096-02-01",
    reason: TAG,
    prices: [
      { product_id: products[0], uom: "CRATE", unit_price: "95.5" }, // a packaging unit
      { product_id: products[0], uom: "G", unit_price: "0.01" }, // a unit of the same category
      { product_id: products[1], unit_price: "11" }, // correcting an unused row
      { product_id: products[2], unit_price: "20" }, // the same price, new end date: corrected
      { product_id: products[3], unit_price: "5" },
      { product_id: products[3], unit_price: "6" }, // sent twice: created, then corrected
      { product_id: products[3], unit_price: "6" }, // and a third time unchanged
      { product_id: products[4], uom: "KG", unit_price: "7.1234" },
    ],
  };
  const batched = await setPrices(a, input, admin() as never);
  const single = await oneByOne(b, input);
  assert.deepEqual(batched, single);
  assert.deepEqual(batched, { created: 4, replaced: 3 });
  const [sa, sb] = [await snapshot(a), await snapshot(b)];
  assert.deepEqual(sa.rows, sb.rows);
  assert.deepEqual(sa.audits, sb.audits);
});

test("the same refusals: an unknown unit, an unknown product, a price already used by an order", async () => {
  const a = await newList();
  const refusal = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ApiError ? `${e.status} ${e.message}` : String(e)));
  const badUnit = { valid_from: "2096-03-01", prices: [{ product_id: products[5], unit_price: "1" }, { product_id: products[6], uom: "CRATE", unit_price: "2" }] };
  assert.match(await refusal(setPrices(a, badUnit, admin() as never)), /^400 الوحدة CRATE مش متعرّفة للصنف/);
  assert.equal(await prisma.priceListItem.count({ where: { priceListId: a } }), 0, "nothing saved");
  assert.equal(await refusal(setPrices(a, { valid_from: "2096-03-01", prices: [{ product_id: "no-such-product", unit_price: "1" }] }, admin() as never)), "404 الصنف مش موجود");
  // A price an order line was priced from is history: correcting it the same day is refused.
  await setPrices(a, { valid_from: "2096-03-01", prices: [{ product_id: products[7], unit_price: "9" }] }, admin() as never);
  const row = await prisma.priceListItem.findFirstOrThrow({ where: { priceListId: a, productId: products[7] } });
  const o = await prisma.order.create({ data: { orderNumber: `${TAG}-1`, customerName: TAG, deliveryDate: "2096-03-02", source: "manual", items: { create: [{ productName: TAG, requiredQuantity: 1, stockProductId: products[7] }] } }, include: { items: true } });
  await prisma.orderItemPrice.create({ data: { orderItemId: o.items[0].id, unitPrice: 9, taxCode: (await prisma.stockProduct.findUniqueOrThrow({ where: { id: products[7] } })).salesTaxCode, taxRate: 0, source: "list", priceListId: a, priceListItemId: row.id, setBy: TAG } });
  assert.match(await refusal(setPrices(a, { valid_from: "2096-03-01", prices: [{ product_id: products[8], unit_price: "3" }, { product_id: products[7], unit_price: "10" }] }, admin() as never)), /^409 سعر ".*" من 2096-03-01 اتسعّر بيه أوردرات بالفعل/);
  assert.equal(await prisma.priceListItem.count({ where: { priceListId: a } }), 1, "nothing saved");
});

test("statements do not grow with the number of prices (10 vs 200)", async () => {
  const a = await newList();
  const prices = (n: number, price: string) => products.slice(0, n).map((id, i) => ({ product_id: id, ...(i === 0 ? { uom: "CRATE" } : {}), unit_price: price }));
  const small = await countQueries(() => setPrices(a, { valid_from: "2096-04-01", prices: prices(10, "4") }, admin() as never));
  const large = await countQueries(() => setPrices(a, { valid_from: "2096-04-02", prices: prices(200, "4") }, admin() as never));
  assert.deepEqual(large.result, { created: 200, replaced: 0 });
  // A same-day correction of all of them.
  const fix = await countQueries(() => setPrices(a, { valid_from: "2096-04-02", prices: prices(200, "4.5") }, admin() as never));
  assert.deepEqual(fix.result, { created: 0, replaced: 200 });
  console.log(`[statements] ${JSON.stringify({ save10: small.queries, save200: large.queries, correct200: fix.queries })}`);
  assert.ok(large.queries - small.queries <= 1, `200 prices: ${large.queries} statements, 10: ${small.queries}`);
  assert.ok(fix.queries <= small.queries + 3, `correcting 200 prices: ${fix.queries} statements`);
});
