/* createOrder on a single pooled connection (PM-3 / PW-6 / LOG-1, Nov 2026). The create
   transaction reads settings several times (price exceptions, the default warehouse, the
   awaiting-stock suggestions). It used to run on a bare prisma.$transaction, so a settings cache
   that expired part-way through sent the read to the global client, which waited for a second
   connection until the pool timed out (P2024): the order was lost, intermittently, depending
   on the cache's age. Here the cache is dropped inside the transaction, on one connection. */
import "./_single-connection";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { invalidateSettingsCache } from "@/lib/core/settings-service";
import { createCustomer } from "@/lib/sales/customers";
import { recordIntake } from "@/lib/stock-service";
import { createOrder } from "@/lib/orders-service";

const TAG = `ZZOSC${Date.now()}`;
const day = `2097-04-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, [...ROLE_PERMISSIONS[role]], ids[username], role), source: "manual" as const });
let customerId = "";
let productId = "";
let sales: ReturnType<typeof as>;

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  const supplierId = (await prisma.supplier.create({ data: { code: `SUP-6${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "vegetable" } })).id;
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
  productId = (await prisma.stockProduct.create({ data: { name: `${TAG} طماطم`, nameAr: `${TAG} طماطم`, unit: "KG" } })).id;
  await recordIntake({ supplier_id: supplierId, product_id: productId, received_kg: 10, unit_cost: "5", location_id: "loc_cold_1" } as never, as("hossam", "STOCK_CONTROLLER", "حسام مخازن") as never);
});
after(async () => {
  await prisma.$disconnect();
});

const create = (quantity: number, extra: Record<string, unknown> = {}) =>
  createOrder(
    { customer_account_id: customerId, customer_name: "", delivery_date: day, items: [{ stock_product_id: productId, product_name: "", quantity, unit: "KG" }], ...extra } as never,
    sales as never,
    // The settings cache expires inside the transaction (here: dropped right after the order row).
    { afterCreate: async () => invalidateSettingsCache() }
  );

test("a settings cache that expires mid-transaction does not wait on a second connection: the order is saved", async () => {
  const o = await create(2);
  assert.equal(o.stockStatus, "ok");
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: o.id, status: "active" } }), 1);
});

test("same on the awaiting-stock path (its suggestions read the default warehouse again)", async () => {
  const o = await create(50, { allow_shortage: true });
  assert.equal(o.stockStatus, "awaiting_stock");
  assert.equal(await prisma.purchaseRequest.count({ where: { orderId: o.id, orderItemId: { not: null } } }), 1);
});

test("a cache that is stale at every read, pricing included (typed price, price exceptions, credit): the order is saved", async (t) => {
  // The clock moves past the cache's lifetime at every reading, so each settings read inside the
  // transaction misses: the price-exception check's own (approval on, the discount limit), the
  // default warehouse, the credit mode — all read through the transaction on its one connection.
  const real = Date.now.bind(Date);
  let skew = 0;
  t.mock.method(Date, "now", () => real() + (skew += 11_000));
  try {
    const o = await createOrder(
      { customer_account_id: customerId, customer_name: "", delivery_date: day, items: [{ stock_product_id: productId, product_name: "", quantity: 1, unit: "KG", unit_price: "9", price_reason: `${TAG} متفق عليه` }] } as never,
      sales as never
    );
    assert.equal(o.stockStatus, "ok");
    assert.equal((await prisma.orderItemPrice.findUniqueOrThrow({ where: { orderItemId: o.items[0].id } })).unitPrice.toFixed(), "9");
    assert.ok(skew >= 5 * 11_000, `the cache was consulted ${skew / 11_000} times`);
  } finally {
    t.mock.restoreAll();
  }
});
