/* Re-pricing many orders at once (Nov 2026): mapping a customer name or a product name re-priced
   every open order carrying it, one order at a time (applyListPrices, ~9 statements per order and
   1–2 per line), and a backlog of ~20 orders ran past the 20 s limit — the mapping failed. The
   batched applyListPricesToOrders must leave exactly the prices and audit rows the one-order loop
   leaves: manual and quotation prices untouched, unchanged list prices not rewritten, a customer's
   own list before the default, a packaging or a convertible unit priced from the base-unit price,
   a price that no longer applies removed on refresh, cancelled orders left alone. Every scenario
   is built and rolled back inside one transaction. */
import { countQueries } from "./_query-count";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { applyListPrices } from "@/lib/sales/pricing";
import { applyListPricesToOrders } from "@/lib/sales/reprice-orders";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const TAG = `ZZRPO${Date.now()}`;
const today = todayLocalISO();
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const sales = actor("مبيعات", ["sales.customers.manage"], null, "SALES");
after(async () => { await prisma.$disconnect(); });

class Rollback extends Error {}
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  await assert.rejects(inTx(async (tx) => { await fn(tx); throw new Rollback(); }), (e) => { if (e instanceof Rollback) return true; throw e; });
}

let serial = 0;
const next = () => `${Date.now() % 100000}${serial++}`;

/** Price lists and products shared by both copies of the orders. */
async function catalogue(tx: Tx) {
  // Whatever default list the database has is set aside for the scenario (rolled back).
  await tx.priceList.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  const list = (code: string, extra: Partial<Prisma.PriceListUncheckedCreateInput> = {}) => tx.priceList.create({ data: { code: `${TAG}-${code}-${next()}`, name: code, createdBy: "test", ...extra } });
  const def = await list("DEF", { isDefault: true });
  const own = await list("OWN");
  const off = await list("OFF", { active: false });
  const product = (n: string, tax = "EXEMPT") => tx.stockProduct.create({ data: { name: `${TAG} ${n} ${next()}`, unit: "KG", salesTaxCode: tax } });
  const [kg, crate, none, ended, grams] = [await product("kg", "VAT14"), await product("crate"), await product("none"), await product("ended"), await product("grams")];
  await tx.productPackaging.create({ data: { productId: crate.id, uomCode: "CRATE", qtyInBaseUnit: D(18) } });
  const price = (l: { id: string }, p: { id: string }, uomCode: string, unitPrice: string, validFrom: string, validTo: string | null = null) =>
    tx.priceListItem.create({ data: { priceListId: l.id, productId: p.id, uomCode, unitPrice: D(unitPrice), validFrom, validTo, createdBy: "test" } });
  await price(def, kg, "KG", "20", shift(today, -30));
  await price(def, kg, "KG", "22", shift(today, -2));
  await price(own, kg, "KG", "18.5", shift(today, -30));
  await price(off, kg, "KG", "1", shift(today, -30));
  await price(def, crate, "KG", "3.3333", shift(today, -30));
  await price(own, crate, "CRATE", "55", shift(today, -30));
  await price(def, ended, "KG", "9", shift(today, -30), shift(today, -5));
  await price(def, grams, "KG", "40", shift(today, -30));
  return { def, own, off, kg, crate, none, ended, grams };
}
type Cat = Awaited<ReturnType<typeof catalogue>>;

/** One copy of the orders: a customer with its own list, one whose list is inactive, none, a cancelled order. */
async function orders(tx: Tx, c: Cat, label: string) {
  const customer = (n: string, priceListId: string | null) => tx.customer.create({ data: { code: `CUS-9${next()}`, name: `${TAG} ${label} ${n}`, priceListId, createdBy: "test" } });
  const [withOwn, withOff] = [await customer("own", c.own.id), await customer("off", c.off.id)];
  const out: string[] = [];
  const order = async (customerAccountId: string | null, deliveryDate: string, status = "new") => {
    const o = await tx.order.create({ data: { orderNumber: `${TAG}-${label}-${next()}`, customerName: `${TAG} ${label}`, customerAccountId, deliveryDate, status } });
    out.push(o.id);
    return o.id;
  };
  const item = async (orderId: string, p: { id: string; name: string } | null, unit: string, price?: Partial<Prisma.OrderItemPriceUncheckedCreateInput>) => {
    const i = await tx.orderItem.create({ data: { orderId, productName: p?.name ?? `${TAG} حر`, unit, requiredQuantity: 3, stockProductId: p?.id ?? null } });
    if (price) await tx.orderItemPrice.create({ data: { orderItemId: i.id, unitPrice: D(1), taxCode: "EXEMPT", taxRate: D(0), source: "list", setBy: "earlier", ...price } as Prisma.OrderItemPriceUncheckedCreateInput });
  };
  for (const [cust, date] of [[withOwn.id, today], [withOff.id, today], [null, shift(today, -4)], [withOwn.id, shift(today, -10)]] as const) {
    const o = await order(cust, date);
    await item(o, c.kg, "KG");
    await item(o, c.crate, "CRATE");
    await item(o, c.grams, "G");
    await item(o, c.ended, "KG", { priceListItemId: (await tx.priceListItem.findFirstOrThrow({ where: { productId: c.ended.id } })).id, unitPrice: D(9) });
    await item(o, c.none, "KG", { priceListItemId: (await tx.priceListItem.findFirstOrThrow({ where: { productId: c.kg.id } })).id });
    await item(o, c.kg, "BOX");
    await item(o, null, "KG");
    await item(o, c.kg, "KG", { source: "manual", reason: "اتفاق خاص", unitPrice: D(17) });
    await item(o, c.crate, "KG", { source: "quotation", unitPrice: D(3) });
  }
  // A list price that is still right is not rewritten; a cancelled order is not touched.
  const kept = await order(withOwn.id, today);
  const ownKg = await tx.priceListItem.findFirstOrThrow({ where: { priceListId: c.own.id, productId: c.kg.id } });
  await item(kept, c.kg, "KG", { unitPrice: D("18.5"), priceListItemId: ownKg.id, priceListId: c.own.id, taxCode: "VAT14", taxRate: D(14) });
  const cancelled = await order(withOwn.id, today, "cancelled");
  await item(cancelled, c.kg, "KG");
  return out;
}

async function state(tx: Tx, orderIds: string[]) {
  const items = await tx.orderItem.findMany({ where: { orderId: { in: orderIds } }, include: { price: true }, orderBy: { id: "asc" } });
  const index = new Map(orderIds.map((id, i) => [id, i]));
  const audits = await tx.auditLog.findMany({ where: { action: "order_priced", entityId: { in: orderIds } } });
  return {
    prices: items.map((i) => JSON.stringify([index.get(i.orderId), i.unit, i.price && { ...i.price, orderItemId: undefined, updatedAt: undefined, unitPrice: i.price.unitPrice.toString(), discountPct: i.price.discountPct.toString(), taxRate: i.price.taxRate.toString() }])),
    audits: audits.map((a) => JSON.stringify([index.get(a.entityId), a.fieldChanged, a.newValue, a.userName])).sort(),
  };
}

for (const refresh of [true, false]) {
  test(`one pass prices the orders exactly as one order at a time (refresh: ${refresh})`, async () => {
    await rolledBack(async (tx) => {
      const c = await catalogue(tx);
      const a = await orders(tx, c, "A"), b = await orders(tx, c, "B");
      const old: number[] = [];
      for (const id of a) old.push((await applyListPrices(tx, id, sales as never, { refresh })).priced);
      const now = await applyListPricesToOrders(tx, b, sales, { refresh });
      assert.deepEqual(b.map((id) => now.get(id)!.priced), old);
      const [sa, sb] = [await state(tx, a), await state(tx, b)];
      assert.ok(old.reduce((s, x) => s + x, 0) >= 12, `the scenario prices lines: ${old}`);
      assert.deepEqual(sb, sa);
    });
  });
}

test("statements are constant in the number of orders: 4 vs 20", async () => {
  async function measure(copies: number) {
    let queries = 0;
    await rolledBack(async (tx) => {
      const c = await catalogue(tx);
      const ids: string[] = [];
      for (let i = 0; i < copies; i++) ids.push(...(await orders(tx, c, `N${copies}-${i}`)));
      queries = (await countQueries(() => applyListPricesToOrders(tx, ids, sales, { refresh: true }))).queries;
    });
    return queries;
  }
  const small = await measure(1), large = await measure(4);
  assert.equal(large, small, `6 orders ${small}, 24 orders ${large}`);
  assert.ok(large <= 16, String(large));
});

test("more lines than one statement can carry are re-priced in chunks (PostgreSQL takes at most 32,767 bind parameters)", async () => {
  await rolledBack(async (tx) => {
    const c = await catalogue(tx);
    const o = await tx.order.create({ data: { orderNumber: `${TAG}-BIG-${next()}`, customerName: `${TAG} big`, customerAccountId: null, deliveryDate: today, status: "new" } });
    const n = 4800; // 7 parameters per line: one statement for all of them would need 33,600
    await tx.orderItem.createMany({ data: Array.from({ length: n }, (_, k) => ({ orderId: o.id, productName: `${TAG} ${k}`, unit: "KG", requiredQuantity: 1, stockProductId: c.kg.id })) });
    const items = await tx.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } });
    const stale = await tx.priceListItem.findFirstOrThrow({ where: { priceListId: c.def.id, productId: c.kg.id, unitPrice: D(20) } });
    await tx.orderItemPrice.createMany({ data: items.map((i) => ({ orderItemId: i.id, unitPrice: D(20), taxCode: "VAT14", taxRate: D(14), source: "list", priceListId: c.def.id, priceListItemId: stale.id, setBy: "earlier" })) });
    const out = await applyListPricesToOrders(tx, [o.id], sales, { refresh: true });
    assert.equal(out.get(o.id)?.priced, n);
    const prices = await tx.orderItemPrice.groupBy({ by: ["unitPrice", "version"], where: { orderItemId: { in: items.map((i) => i.id) } }, _count: { _all: true } });
    assert.deepEqual(prices.map((p) => [p.unitPrice.toFixed(), p.version, p._count._all]), [["22", 2, n]], "every line now at today's default price, one version up");
  });
});
