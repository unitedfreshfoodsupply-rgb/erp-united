/* The manual order form's list prices (Nov 2026): every line's (product, unit) in one call, in
   a fixed number of statements whatever the line count, with exactly the price the one-pair
   lookup gives — the customer's own list first, then the default; the price row valid on the
   date; a packaging unit priced from the base-unit price × its size; null when nothing prices it.
   Synthetic data on the test database (lists and prices removed afterwards). */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor } from "./_db";
import { createCustomer } from "@/lib/sales/customers";
import { effectivePrice, priceListsFor } from "@/lib/sales/pricing";
import { entryListPrices, entryPriceKey, type EntryPriceKey } from "@/lib/orderEntryPrices";

const TAG = `ZZOEP${Date.now()}`;
const day = "2099-06-15";
const sales = actor("مبيعات", ["sales.customers.manage", "sales.customers.view"]);
const products: { id: string; name: string; unit: string }[] = [];
let customerId = "";
const created: string[] = [];
let defaultListId = "";

before(async () => {
  for (let i = 0; i < 50; i++) products.push(await prisma.stockProduct.create({ data: { name: `${TAG} P${i}`, unit: "KG" }, select: { id: true, name: true, unit: true } }));
  // Every 5th product also sells by the crate of 18 kg; product 3's crate packaging is inactive.
  for (let i = 0; i < 50; i += 5) await prisma.productPackaging.create({ data: { productId: products[i].id, uomCode: "CRATE", qtyInBaseUnit: new Prisma.Decimal(18) } });
  await prisma.productPackaging.create({ data: { productId: products[3].id, uomCode: "CRATE", qtyInBaseUnit: new Prisma.Decimal(10), active: false } });

  const own = await prisma.priceList.create({ data: { code: `${TAG}-OWN`, name: `${TAG} own`, createdBy: "test" } });
  created.push(own.id);
  const existingDefault = await prisma.priceList.findFirst({ where: { isDefault: true, active: true } });
  if (existingDefault) defaultListId = existingDefault.id;
  else {
    const def = await prisma.priceList.create({ data: { code: `${TAG}-DEF`, name: `${TAG} default`, isDefault: true, createdBy: "test" } });
    created.push(def.id);
    defaultListId = def.id;
  }
  customerId = (await createCustomer({ name: `${TAG} Customer` }, sales)).id;
  await prisma.customer.update({ where: { id: customerId }, data: { priceListId: own.id } });

  const item = (priceListId: string, p: number, uomCode: string, unitPrice: string, validFrom = "2000-01-01", validTo: string | null = null) =>
    ({ priceListId, productId: products[p].id, uomCode, unitPrice: new Prisma.Decimal(unitPrice), validFrom, validTo, createdBy: "test" });
  await prisma.priceListItem.createMany({
    data: [
      // The customer's own list prices products 0–9 (and a crate price for product 5).
      ...Array.from({ length: 10 }, (_, i) => item(own.id, i, "KG", String(10 + i))),
      item(own.id, 5, "CRATE", "150"),
      // The default prices products 0–29; product 11 has a newer price from 2050, product 12's
      // only price expired in 2050, product 13's starts after the date.
      ...Array.from({ length: 30 }, (_, i) => i).filter((i) => i !== 12 && i !== 13).map((i) => item(defaultListId, i, "KG", String(100 + i))),
      item(defaultListId, 11, "KG", "222", "2050-01-01"),
      item(defaultListId, 12, "KG", "333", "2000-01-01", "2050-01-01"),
      item(defaultListId, 13, "KG", "444", "2100-01-01"),
    ],
  });
});

after(async () => {
  await prisma.customer.update({ where: { id: customerId }, data: { priceListId: null } });
  await prisma.priceListItem.deleteMany({ where: { productId: { in: products.map((p) => p.id) } } });
  await prisma.priceList.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

/** The one-pair lookup GET /api/orders/entry/price makes, for comparison. */
async function onePair(customer: string | null, k: EntryPriceKey) {
  const product = products.find((p) => p.id === k.productId)!;
  for (const list of await priceListsFor(prisma, customer)) {
    const found = await effectivePrice(prisma, { priceListId: list.id, product, lineUom: k.unit, date: day });
    if (found) return found.unitPrice.toFixed();
  }
  return null;
}
const keysFor = (n: number): EntryPriceKey[] => products.slice(0, n).flatMap((p, i) => (i % 5 === 0 || i === 3 ? [{ productId: p.id, unit: "KG" }, { productId: p.id, unit: "CRATE" }] : [{ productId: p.id, unit: i === 7 ? "PIECE" : "KG" }]));

test("every pair priced exactly as the one-pair lookup prices it", async () => {
  for (const customer of [customerId, null]) {
    const keys = keysFor(50);
    const batch = await entryListPrices(customer, day, keys);
    for (const k of keys) assert.equal(batch.get(entryPriceKey(k))?.unitPrice ?? null, await onePair(customer, k), `${customer ? "customer" : "no customer"} ${products.findIndex((p) => p.id === k.productId)} ${k.unit}`);
  }
  // A few spelled out: own list first, default for the rest, the date's price row, the crate.
  const b = await entryListPrices(customerId, day, keysFor(50));
  const at = (i: number, unit = "KG") => b.get(`${products[i].id}|${unit}`)?.unitPrice ?? null;
  assert.deepEqual([at(1), at(20), at(11), at(12), at(13), at(40)], ["11", "120", "222", null, null, null]);
  assert.deepEqual([at(5, "CRATE"), at(10, "CRATE"), at(3, "CRATE"), at(7, "PIECE")], ["150", "1980", null, null]);
  assert.equal(b.get(`${products[0].id}|KG`)?.priceList?.id, (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).priceListId);
});

test("a fixed number of statements: 5 lines and 50 lines cost the same", async () => {
  await entryListPrices(customerId, day, keysFor(5)); // warm per-process caches
  const five = await countQueries(() => entryListPrices(customerId, day, keysFor(5)));
  const fifty = await countQueries(() => entryListPrices(customerId, day, keysFor(50)));
  assert.equal(fifty.queries, five.queries, `5 lines: ${five.queries}, 50 lines: ${fifty.queries}`);
  assert.ok(fifty.queries <= 8, `${fifty.queries} statements`);
  // The one-pair lookup it replaces, for the record: statements grow with every line.
  const old = await countQueries(async () => { for (const k of keysFor(50)) await onePair(customerId, k); });
  assert.ok(old.queries > 10 * fifty.queries, `one pair at a time: ${old.queries} statements`);
});

test("an unknown product simply has no price; no pairs, no statements", async () => {
  const r = await entryListPrices(customerId, day, [{ productId: `${TAG}-missing`, unit: "KG" }]);
  assert.deepEqual(r.get(`${TAG}-missing|KG`), { unitPrice: null, priceList: null });
  const none = await countQueries(() => entryListPrices(customerId, day, []));
  assert.deepEqual([none.result.size, none.queries], [0, 0]);
});
