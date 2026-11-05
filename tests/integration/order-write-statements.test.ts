/* Order writes in a fixed number of statements (Nov 2026). Production runs ~37 ms per round
   trip on one pooled connection, and creating, re-committing or holding an order used to cost
   ~20 statements per line inside one 20 s transaction: a 25-line order could not be saved, a
   quantity correction on a 55-line order failed, a reopened 30-line order timed out. These
   guard the batched paths: the count for 50 lines is the count for 5 lines plus a small
   constant, and the rows written are the ones the line-by-line paths wrote. Synthetic data on
   the test database. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { createPriceList, effectivePrice, effectivePrices, orderValue, setAgreedLinePriceInTx, setAgreedLinePricesInTx, setCustomerPriceList, setPrices } from "@/lib/sales/pricing";
import { Prisma } from "@prisma/client";
import { customerExposure } from "@/lib/sales/credit";
import { recordIntake } from "@/lib/stock-service";
import { commitOrderStock } from "@/lib/sales/stock-commitment";
import { inTx } from "@/lib/tx";
import { cancelOrder, createOrder, editOrder, editRequiredQuantity, moveOrderStatus, reopenOrder, setLoadedQuantity, setPreparedQuantity } from "@/lib/orders-service";
import { syncOrderSuggestions } from "@/lib/purchasing/requests";

const TAG = `ZZOWS${Date.now()}`;
const day = `2097-03-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string, extra: string[] = []) => ({ ...actor(name, [...ROLE_PERMISSIONS[role], ...extra], ids[username], role), source: "manual" as const });
let sales: ReturnType<typeof as>, sup: ReturnType<typeof as>, stock: ReturnType<typeof as>, admin: ReturnType<typeof as>;
let customerId = "";
let listId = "";
const products: string[] = [];
const N_SMALL = 5;
const N_LARGE = 50;

const line = (productId: string, quantity: number, price?: string) => ({ stock_product_id: productId, product_name: "", quantity, unit: "KG", ...(price ? { unit_price: price, price_reason: `${TAG} متفق عليه` } : {}) });
/** n lines on distinct products; every other line carries a typed price that differs from the list. */
const lines = (n: number, quantity = 1, offset = 0) => products.slice(offset, offset + n).map((p, i) => line(p, quantity, i % 2 ? "12.5" : undefined));
const order = (items: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) =>
  createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items, ...extra } as never, sales as never);

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  stock = as("hossam", "STOCK_CONTROLLER", "حسام مخازن");
  admin = as("admin", "SUPER_ADMIN", "أدمن");
  const supplierId = (await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "vegetable" } })).id;
  const c = await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق`, payment_terms_days: 30, credit_limit: "100000000", credit_reason: TAG }, admin as never);
  customerId = c.id;
  const pl = await createPriceList({ code: `${TAG}`.toUpperCase(), name: `${TAG} list` }, admin as never);
  await setCustomerPriceList(customerId, { price_list_id: pl.id, reason: TAG }, admin as never);
  listId = pl.id;
  for (let i = 0; i < N_LARGE + 5; i++) {
    const p = await prisma.stockProduct.create({ data: { name: `${TAG} صنف ${String(i).padStart(2, "0")}`, nameAr: `${TAG} صنف ${String(i).padStart(2, "0")}`, unit: "KG" } });
    products.push(p.id);
    await recordIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 100, unit_cost: "5", location_id: "loc_cold_1" } as never, stock as never);
  }
  await setPrices(pl.id, { valid_from: "2000-01-01", prices: products.map((id) => ({ product_id: id, unit_price: "10" })) }, admin as never);
  // A few open orders already on the customer's account: the credit check values them.
  for (let i = 0; i < 3; i++) await order(lines(2, 1, N_LARGE));
});
after(async () => {
  await prisma.$disconnect();
});

const report: Record<string, number> = {};
after(() => console.log(`[statements] ${JSON.stringify(report)}`));

test("createOrder: statements do not grow with the number of lines", async () => {
  await order(lines(1)); // warm the settings cache and the per-process paths
  const small = await countQueries(() => order(lines(N_SMALL)));
  const large = await countQueries(() => order(lines(N_LARGE)));
  report.create5 = small.queries;
  report.create50 = large.queries;
  assert.equal(large.result.items.length, N_LARGE);
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: large.result.id, status: "active" } }), N_LARGE);
  assert.ok(large.queries - small.queries <= 4, `50 lines: ${large.queries} statements, 5 lines: ${small.queries}`);
  assert.ok(large.queries <= 80, `create of 50 lines took ${large.queries} statements`);
});

test("editRequiredQuantity: re-commits the edited line only — constant in the number of lines", async () => {
  const o5 = await order(lines(N_SMALL));
  const o50 = await order(lines(N_LARGE));
  const first = (o: Awaited<ReturnType<typeof order>>) => [...o.items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
  const small = await countQueries(() => editRequiredQuantity(o5.id, first(o5).id, 2, sup as never, TAG));
  const large = await countQueries(() => editRequiredQuantity(o50.id, first(o50).id, 2, sup as never, TAG));
  report.edit5 = small.queries;
  report.edit50 = large.queries;
  assert.ok(large.queries - small.queries <= 2, `50 lines: ${large.queries} statements, 5 lines: ${small.queries}`);
});

test("reopenOrder of a cancelled order: the re-commit is constant in the number of lines", async () => {
  const o5 = await order(lines(N_SMALL));
  const o50 = await order(lines(N_LARGE));
  await cancelOrder(o5.id, sup as never, TAG);
  await cancelOrder(o50.id, sup as never, TAG);
  const small = await countQueries(() => reopenOrder(o5.id, "preparing", sup as never, TAG));
  const large = await countQueries(() => reopenOrder(o50.id, "preparing", sup as never, TAG));
  report.reopen5 = small.queries;
  report.reopen50 = large.queries;
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: o50.id, status: "active" } }), N_LARGE);
  assert.ok(large.queries - small.queries <= 4, `50 lines: ${large.queries} statements, 5 lines: ${small.queries}`);
});

test("an order saved awaiting stock: one suggestion per short line, statements constant in the number of lines", async () => {
  const small = await countQueries(() => order(lines(N_SMALL, 500), { allow_shortage: true }));
  const large = await countQueries(() => order(lines(N_LARGE, 500), { allow_shortage: true }));
  report.hold5 = small.queries;
  report.hold50 = large.queries;
  assert.equal(large.result.stockStatus, "awaiting_stock");
  assert.equal(await prisma.purchaseRequest.count({ where: { orderId: large.result.id, orderItemId: { not: null }, status: "pending_approval" } }), N_LARGE);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", status: "pending", entityId: { in: (await prisma.purchaseRequest.findMany({ where: { orderId: large.result.id }, select: { id: true } })).map((r) => r.id) } } }), N_LARGE);
  assert.ok(large.queries - small.queries <= 6, `50 lines: ${large.queries} statements, 5 lines: ${small.queries}`);
});

test("a held order's suggestions resized and closed together: statements constant in the number of lines", async () => {
  const o5 = await order(lines(N_SMALL, 500), { allow_shortage: true });
  const o50 = await order(lines(N_LARGE, 500), { allow_shortage: true });
  const later = `2098-${day.slice(5)}`;
  const before50 = new Map((await prisma.purchaseRequest.findMany({ where: { orderId: o50.id, orderItemId: { not: null } } })).map((r) => [r.id, r]));
  // A new delivery day resizes every line's suggestion (its needed-by day follows the order).
  const small = await countQueries(() => editOrder(o5.id, { deliveryDate: later }, sup as never, TAG));
  const large = await countQueries(() => editOrder(o50.id, { deliveryDate: later }, sup as never, TAG));
  report.resize5 = small.queries;
  report.resize50 = large.queries;
  const rows = await prisma.purchaseRequest.findMany({ where: { orderId: o50.id, orderItemId: { not: null } } });
  assert.equal(rows.length, N_LARGE);
  for (const r of rows) {
    const was = before50.get(r.id)!;
    assert.deepEqual(
      [r.neededBy, r.version, r.status, r.quantity.toFixed(), r.requiredQty?.toFixed(), r.availableQty?.toFixed(), r.customerReference, r.number, r.decidedAt],
      [later, 2, "pending_approval", was.quantity.toFixed(), was.requiredQty?.toFixed(), was.availableQty?.toFixed(), was.customerReference, was.number, null]
    );
  }
  assert.ok(rows.every((r) => Math.abs(r.updatedAt.getTime() - Date.now()) < 60_000), "updatedAt stored as Prisma stores it");
  assert.equal(await prisma.auditLog.count({ where: { entityId: { in: rows.map((r) => r.id) }, action: "purchase_request_quantity_changed" } }), 0, "same quantity: no quantity audit");
  assert.ok(large.queries - small.queries <= 2, `50 lines: ${large.queries} statements, 5 lines: ${small.queries}`);

  // No longer waiting for stock: every open suggestion is closed, its approval withdrawn.
  const close = async (orderId: string) => {
    await prisma.order.update({ where: { id: orderId }, data: { stockStatus: "ok" } });
    return countQueries(() => inTx((tx) => syncOrderSuggestions(tx, orderId, sup as never)));
  };
  const c5 = await close(o5.id);
  const c50 = await close(o50.id);
  report.close5 = c5.queries;
  report.close50 = c50.queries;
  assert.equal(c50.result.closed, N_LARGE);
  const closed = await prisma.purchaseRequest.findMany({ where: { orderId: o50.id, orderItemId: { not: null } } });
  assert.ok(closed.every((r) => r.status === "cancelled" && r.cancelReason === "الأوردر مبقاش مستني بضاعة" && r.version === 3));
  const ids50 = closed.map((r) => r.id);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: { in: ids50 }, status: "pending" } }), 0);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: { in: ids50 }, status: "cancelled", closedReason: "الأوردر مبقاش مستني بضاعة" } }), N_LARGE);
  const cancelledAudits = await prisma.auditLog.findMany({ where: { entityId: { in: ids50 }, action: "purchase_request_cancelled" } });
  assert.equal(cancelledAudits.length, N_LARGE);
  assert.ok(cancelledAudits.every((a) => a.orderId === o50.id && a.reason === "الأوردر مبقاش مستني بضاعة" && a.newValue?.endsWith(" · إلغاء تلقائي")));
  assert.ok(c50.queries - c5.queries <= 2, `50 lines: ${c50.queries} statements, 5 lines: ${c5.queries}`);
});

test("customerExposure: the open orders' value read at once equals orderValue order by order, in fixed statements", async () => {
  const open = await prisma.order.findMany({ where: { customerAccountId: customerId, status: { not: "cancelled" } }, select: { id: true } });
  assert.ok(open.length >= 8);
  let total = 0n;
  let unpriced = 0;
  for (const o of open) {
    const v = await orderValue(prisma, o.id);
    total += BigInt(v.total.times(100).toFixed(0));
    unpriced += v.unpriced;
  }
  const { result, queries } = await countQueries(() => customerExposure(prisma, customerId));
  report.exposure = queries;
  assert.equal(result.openOrders.times(100).toFixed(0), total.toString());
  assert.equal(result.unpricedLines, unpriced);
  assert.ok(queries <= 10, `${queries} statements for ${open.length} open orders`);
});

test("quantities with up to three decimals as typed are accepted everywhere (LOG-2: 16.1, 32.2, 2.01, 1.001)", async () => {
  const o = await order([line(products[0], 16.1), line(products[1], 2.01)]);
  const [a, b] = [...o.items].sort((x, y) => x.requiredQuantity - y.requiredQuantity).reverse();
  assert.equal(a.requiredQuantity, 16.1);
  await editRequiredQuantity(o.id, a.id, 32.2, sup as never, TAG);
  assert.equal(await prisma.stockReservation.findFirstOrThrow({ where: { sourceType: "order", sourceId: o.id, sourceLineId: a.id, status: "active" } }).then((r) => r.quantity.toFixed()), "32.2");
  await moveOrderStatus(o.id, "preparing", sup as never);
  await setPreparedQuantity(o.id, a.id, 8.03, sup as never);
  await setPreparedQuantity(o.id, b.id, 1.001, sup as never);
  assert.equal((await prisma.orderItem.findUniqueOrThrow({ where: { id: b.id } })).preparedQuantity, 1.001);
  // Float drift and a fourth decimal are still refused.
  await assert.rejects(setPreparedQuantity(o.id, b.id, 1.2999999999999998, sup as never), /3 خانات عشرية/);
  await assert.rejects(setLoadedQuantity(o.id, b.id, 2.0001, sup as never), /3 خانات عشرية|مينفعش/);
});

test("the batched commit writes what reserveInTx wrote: one reservation and one audit row per line, a changed line released and re-taken, nothing on a re-run", async () => {
  const o = await order([line(products[2], 3), line(products[3], 4), line(products[2], 1.5)]);
  const items = await prisma.orderItem.findMany({ where: { orderId: o.id } });
  const res = await prisma.stockReservation.findMany({ where: { sourceType: "order", sourceId: o.id, status: "active" } });
  assert.equal(res.length, 3);
  for (const i of items) {
    const r = res.find((x) => x.sourceLineId === i.id)!;
    assert.equal(r.productId, i.stockProductId);
    assert.equal(r.quantity.toFixed(), String(i.requiredQuantity));
    assert.equal(r.createdBy, sales.name);
    assert.equal(r.createdById, sales.id);
    assert.equal(r.version, 1);
  }
  const product = await prisma.stockProduct.findUniqueOrThrow({ where: { id: products[2] } });
  const reserved = await prisma.auditLog.findMany({ where: { orderId: o.id, action: "stock_reserved" } });
  assert.equal(reserved.length, 3);
  const mine = reserved.find((a) => a.entityId === res.find((r) => r.quantity.toFixed() === "1.5")!.id)!;
  assert.equal(mine.entityType, "stock_reservation");
  assert.equal(mine.fieldChanged, products[2]);
  assert.equal(mine.newValue, `${product.name} · 1.5 ${product.unit}`);
  assert.equal(mine.userName, sales.name);
  assert.equal(mine.source, "user");

  // A re-run changes nothing (idempotent per line).
  const again = await inTx((tx) => commitOrderStock(tx, o.id, sales as never));
  assert.equal(again.reserved, 0);
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: o.id } }), 3);

  // A changed line: its reservation released (audited with the reason) and taken again at the new quantity.
  const changed = items.find((i) => i.requiredQuantity === 4)!;
  await editRequiredQuantity(o.id, changed.id, 6, sup as never, TAG);
  const old = await prisma.stockReservation.findFirstOrThrow({ where: { sourceLineId: changed.id, status: "released" } });
  assert.equal(old.closedReason, "تعديل كمية السطر");
  assert.equal(old.version, 2);
  assert.equal((await prisma.stockReservation.findFirstOrThrow({ where: { sourceLineId: changed.id, status: "active" } })).quantity.toFixed(), "6");
  const released = await prisma.auditLog.findFirstOrThrow({ where: { entityId: old.id, action: "stock_reservation_released" } });
  assert.equal(released.newValue, "4");
  assert.equal(released.reason, "تعديل كمية السطر");
  assert.equal(released.orderId, o.id);
  // Over what is free: refused, nothing written.
  await assert.rejects(editRequiredQuantity(o.id, changed.id, 10_000, sup as never, TAG), (e: unknown) => (e as { code?: string }).code === "stock_unavailable");
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: o.id, status: "active" } }), 3);
  // Set to 0: the line asks for nothing any more, so its hold is released (reason as before: "السطر اتشال").
  await editRequiredQuantity(o.id, changed.id, 0, sup as never, TAG);
  assert.equal(await prisma.stockReservation.count({ where: { sourceLineId: changed.id, status: "active" } }), 0);
  assert.equal((await prisma.stockReservation.findFirstOrThrow({ where: { sourceLineId: changed.id, status: "released", quantity: 6 } })).closedReason, "السطر اتشال");
});

test("effectivePrices gives, list by list and line by line, what effectivePrice gives", async () => {
  const [p1, p2, p3] = products.slice(N_LARGE + 2, N_LARGE + 5);
  const bare = (await prisma.stockProduct.create({ data: { name: `${TAG} بدون سعر`, unit: "KG" } })).id;
  await prisma.productPackaging.createMany({ data: [{ productId: p1, uomCode: "CRATE", qtyInBaseUnit: 10 }, { productId: p2, uomCode: "CRATE", qtyInBaseUnit: 12.5 }] });
  // p2: its own CRATE price and a newer KG price; p3: a KG price that ended before the day.
  await setPrices(listId, { valid_from: "2000-01-01", prices: [{ product_id: p2, uom: "CRATE", unit_price: "95" }] }, admin as never);
  await setPrices(listId, { valid_from: "2050-01-01", prices: [{ product_id: p2, unit_price: "11" }] }, admin as never);
  const other = await createPriceList({ code: `${TAG}B`.toUpperCase(), name: `${TAG} list B` }, admin as never);
  await setPrices(other.id, { valid_from: "2000-01-01", valid_to: "2001-01-01", prices: [{ product_id: p3, unit_price: "7" }] }, admin as never);
  await setPrices(other.id, { valid_from: "2000-01-01", prices: [{ product_id: bare, unit_price: "3" }, { product_id: p1, uom: "CRATE", unit_price: "80" }] }, admin as never);
  const lists = await prisma.priceList.findMany({ where: { id: { in: [listId, other.id] } } });
  const cards = await prisma.stockProduct.findMany({ where: { id: { in: [p1, p2, p3, bare] } } });
  const card = (id: string) => cards.find((c) => c.id === id)!;
  const lines = [
    { product: card(p1), lineUom: "KG" }, { product: card(p1), lineUom: "CRATE" }, { product: card(p1), lineUom: "G" }, { product: card(p1), lineUom: "BOX" },
    { product: card(p2), lineUom: "KG" }, { product: card(p2), lineUom: "CRATE" }, { product: card(p3), lineUom: "KG" }, { product: card(bare), lineUom: "KG" },
  ];
  const many = await effectivePrices(prisma, lists, lines, day);
  for (const [i, l] of lines.entries()) {
    for (const [j, list] of lists.entries()) {
      const one = await effectivePrice(prisma, { priceListId: list.id, product: l.product, lineUom: l.lineUom, date: day });
      const label = `${l.product.name} ${l.lineUom} in ${list.code}`;
      assert.equal(many[i][j]?.item.id ?? null, one?.item.id ?? null, label);
      assert.equal(many[i][j]?.unitPrice.toFixed() ?? null, one?.unitPrice.toFixed() ?? null, label);
    }
  }
  assert.equal(many[1][0]!.unitPrice.toFixed(), "100", "a crate priced from the base unit");
  assert.equal(many[5][0]!.unitPrice.toFixed(), "95", "a unit's own price wins");
  assert.equal(many[4][0]!.unitPrice.toFixed(), "11", "the newest price on the day");
});

test("setAgreedLinePricesInTx writes what setAgreedLinePriceInTx writes, and refuses what it refuses", async () => {
  const items = [line(products[10], 2), line(products[11], 2), line(products[12], 2), line(products[N_LARGE + 4], 1)];
  const a = await order(items);
  const b = await order(items);
  const typed = [
    { unitPrice: new Prisma.Decimal("12.25"), discountPct: new Prisma.Decimal("0"), reason: "اتفاق" },
    { unitPrice: new Prisma.Decimal("10"), discountPct: new Prisma.Decimal("0"), reason: null }, // the list price as is
    { unitPrice: new Prisma.Decimal("9.5"), discountPct: new Prisma.Decimal("5.5"), reason: "عرض" },
    { unitPrice: new Prisma.Decimal("4"), discountPct: new Prisma.Decimal("0"), reason: null }, // a line without a price row (removed below): created
  ];
  const linesOf = async (orderId: string) => {
    const rows = await prisma.orderItem.findMany({ where: { orderId }, include: { price: true } });
    return items.map((it) => rows.find((r) => r.stockProductId === it.stock_product_id)!);
  };
  const la = await linesOf(a.id);
  const lb = await linesOf(b.id);
  await prisma.orderItemPrice.delete({ where: { orderItemId: la[3].id } }).catch(() => undefined);
  await prisma.orderItemPrice.delete({ where: { orderItemId: lb[3].id } }).catch(() => undefined);
  await inTx(async (tx) => { for (const [i, t] of typed.entries()) await setAgreedLinePriceInTx(tx, la[i].id, t, sales as never); });
  await inTx((tx) => setAgreedLinePricesInTx(tx, typed.map((t, i) => ({ itemId: lb[i].id, input: t })), sales as never));
  const pa = await linesOf(a.id);
  const pb = await linesOf(b.id);
  const shape = (p: NonNullable<(typeof pa)[number]["price"]>) => ({ ...p, orderItemId: undefined, updatedAt: undefined, unitPrice: p.unitPrice.toFixed(), discountPct: p.discountPct.toFixed(), taxRate: p.taxRate.toFixed() });
  for (let i = 0; i < typed.length; i++) {
    assert.deepEqual(shape(pb[i].price!), shape(pa[i].price!), `line ${i + 1}`);
    assert.ok(Math.abs(pb[i].price!.updatedAt.getTime() - Date.now()) < 60_000, "updatedAt stored as Prisma stores it");
  }
  assert.equal(pb[0].price!.version, 2);
  assert.equal(pb[1].price!.source, "list");
  const auditsOf = (rows: typeof pa) => prisma.auditLog.findMany({ where: { action: "order_line_price_overridden", entityId: { in: rows.map((r) => r.id) } } }).then((xs) => rows.map((r) => xs.filter((x) => x.entityId === r.id).map((x) => [x.oldValue, x.newValue, x.reason, x.fieldChanged, x.userName, x.orderId === r.orderId])));
  assert.deepEqual(await auditsOf(pb), await auditsOf(pa));
  // A changed list price without a reason is refused with the same message.
  const c = await order(items.slice(0, 1));
  const [lc] = await linesOf(c.id);
  const noReason = { unitPrice: new Prisma.Decimal("13"), discountPct: new Prisma.Decimal("0"), reason: null };
  const one = await inTx((tx) => setAgreedLinePriceInTx(tx, lc.id, noReason, sales as never)).catch((e: Error) => e.message);
  const many = await inTx((tx) => setAgreedLinePricesInTx(tx, [{ itemId: lc.id, input: noReason }], sales as never)).catch((e: Error) => e.message);
  assert.equal(many, one);
  assert.match(String(one), /اكتب السبب/);
});
