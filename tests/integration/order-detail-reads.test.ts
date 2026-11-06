/* The order detail screen's side reads (Nov 2026).
   - The stock panel assesses an order's lines only when the order waits for stock (the only
     time the panel shows them), and then in a fixed number of statements whatever its size;
     the coverage is the same as the per-line assessment gave.
   - Cancel / reopen: what the screen is told equals what the services refuse with — a
     dispatched order, an order on a trip, a trip that has left, an issued invoice, and an
     invoice fully credited (still refused: no policy change, only accurate words).
   Synthetic data on the test database. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, taxNo } from "./_db";
import { createCustomer } from "@/lib/sales/customers";
import { createCreditNote, issueInvoice } from "@/lib/sales/invoicing";
import { cancelOrder, reopenOrder } from "@/lib/orders-service";
import { assessOrderStock } from "@/lib/sales/stock-commitment";
import { orderStockView } from "@/lib/sales/stock-hold";
import { orderActionView, orderStockPanel } from "@/lib/orderDetailReads";
import { ApiError } from "@/lib/rbac";

/** Query events arrive asynchronously: let them land before the window opens and before it closes. */
const settle = () => new Promise((r) => setTimeout(r, 25));
const measure = <T>(fn: () => Promise<T>) => settle().then(() => countQueries(async () => { const result = await fn(); await settle(); return result; }));
const TAG = `ZZODR${Date.now()}`;
const day = `2099-12-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const floor = actor("مجهز", ["orders.view", "orders.prepare"]);
const buyer = actor("مشتريات", ["orders.view", "purchasing.requests.view"]);
const sup = actor("مشرف", ["orders.view", "orders.edit", "orders.approve"]);
const acct = actor("محاسب", ["sales.invoices.manage", "sales.invoices.view", "sales.customers.manage"]);
let customerId = "";
const productIds: string[] = [];
let n = 0;

before(async () => {
  customerId = (await createCustomer({ name: `${TAG} Customer`, tax_registration_no: taxNo() }, acct)).id;
  for (let i = 0; i < 50; i++) productIds.push((await prisma.stockProduct.create({ data: { name: `${TAG} P${i}`, nameAr: `${TAG} صنف ${i}`, unit: "KG" } })).id);
});
after(() => prisma.$disconnect());

async function makeOrder(lines: number, data: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return prisma.order.create({
    data: {
      orderNumber: `${TAG}-${++n}`, customerName: `${TAG} Customer`, customerAccountId: customerId, deliveryDate: day, status: "new",
      items: { create: productIds.slice(0, lines).map((pid, i) => ({ productName: `${TAG} صنف ${i}`, stockProductId: pid, requiredQuantity: 5, unit: "KG" })) },
      ...data,
    },
  });
}
async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err));
    return { status: err.status, message: err.message };
  }
  assert.fail("expected a refusal");
}

test("stock panel: an order that is not held is not assessed — a fixed, tiny cost at any size", async () => {
  const small = await makeOrder(5, { status: "preparing" });
  const big = await makeOrder(50, { status: "preparing" });
  await orderStockPanel(small.id, floor as never);
  const a = await measure(() => orderStockPanel(small.id, floor as never));
  const b = await measure(() => orderStockPanel(big.id, floor as never));
  assert.deepEqual([a.result.lines, a.result.suggestions, a.result.releasable], [[], null, false]);
  assert.equal(b.queries, a.queries, "the same statements for 5 and 50 lines");
  assert.ok(a.queries <= 1, `${a.queries} statements for the floor (the order's state only)`);
  // Purchasing still sees the order's suggestions on any order (none here).
  const p = await measure(() => orderStockPanel(big.id, buyer as never));
  assert.deepEqual(p.result.suggestions, []);
  assert.ok(p.queries <= 3, `${p.queries} statements with suggestions`);
});

test("stock panel: a held order is assessed in a fixed number of statements, with the per-line coverage it always had", async () => {
  const small = await makeOrder(5, { stockStatus: "awaiting_stock" });
  const big = await makeOrder(50, { stockStatus: "awaiting_stock" });
  await orderStockPanel(small.id, floor as never); // warm the per-process caches (warehouse)
  const a = await measure(() => orderStockPanel(small.id, floor as never));
  const b = await measure(() => orderStockPanel(big.id, floor as never));
  assert.equal(a.result.lines.length, 5);
  assert.equal(b.result.lines.length, 50);
  assert.equal(b.queries, a.queries, `5 lines: ${a.queries}, 50 lines: ${b.queries} statements`);
  // The order header is read once (orderStockPanel hands it to orderStockView).
  assert.ok(a.queries <= 10, `${a.queries} statements for a held order`);
  // Same judgement as the per-line assessment it replaces.
  const old = await assessOrderStock(prisma as never, big.id);
  assert.deepEqual(
    b.result.lines.map((l) => [l.itemId, l.requestedBase, l.available, l.shortage]),
    old!.coverage.map((c) => [c.itemId, c.requestedBase.toFixed(), c.available.toFixed(), c.shortage.toFixed()])
  );
  assert.deepEqual(b.result.shortfalls, old!.shortfalls);
  assert.equal(b.result.releasable, false, "nothing in stock for these products");
  // orderStockView itself answers the same.
  assert.deepEqual((await orderStockView(big.id, floor as never)).lines, b.result.lines);
});

test("cancel / reopen: the screen is told what the services refuse with", async () => {
  // Open, on no trip: both fine (reopen is not offered on a "new" order).
  const open = await makeOrder(1);
  let v = await orderActionView(open.id);
  assert.deepEqual([v.cancel.ok, v.reopen.offered], [true, false]);

  // Dispatched, no invoice: cancel says reopen first; reopen is possible.
  const left = await makeOrder(1, { status: "dispatched" });
  v = await orderActionView(left.id);
  const c = await refusal(cancelOrder(left.id, sup as never, `${TAG} x`, left.version));
  assert.deepEqual([v.cancel.ok, v.cancel.status, v.cancel.message], [false, c.status, c.message]);
  assert.equal(v.reopen.ok, true);

  // On a trip that has not left: cancel refused (take it off the trip); reopen fine.
  const vehicle = await prisma.vehicle.create({ data: { code: `${TAG}-V`, plate: `${TAG}-P` } });
  const driver = await prisma.driver.create({ data: { name: `${TAG} سواق` } });
  const loaded = await makeOrder(1, { status: "loaded" });
  // A number in the trip shape that no real sequence reaches.
  const trip = await prisma.trip.create({ data: { number: `TRP-9999-${String(Date.now()).slice(-9)}`, status: "loaded", tripDate: day, vehicleId: vehicle.id, driverId: driver.id, createdBy: "test" } });
  await prisma.tripStop.create({ data: { tripId: trip.id, orderId: loaded.id, sequence: 1 } });
  v = await orderActionView(loaded.id);
  const t = await refusal(cancelOrder(loaded.id, sup as never, `${TAG} x`, loaded.version));
  assert.deepEqual([v.cancel.ok, v.cancel.status, v.cancel.message, v.cancel.trip], [false, t.status, t.message, trip.number]);
  assert.equal(v.reopen.ok, true);

  // The trip has left: reopen refused, the delivery result is the correction.
  await prisma.trip.update({ where: { id: trip.id }, data: { status: "in_transit" } });
  await prisma.order.update({ where: { id: loaded.id }, data: { status: "dispatched" } });
  const moved = await prisma.order.findUniqueOrThrow({ where: { id: loaded.id } });
  v = await orderActionView(loaded.id);
  const r = await refusal(reopenOrder(loaded.id, "preparing", sup as never, `${TAG} x`, moved.version));
  assert.deepEqual([v.reopen.ok, v.reopen.status, v.reopen.message], [false, r.status, r.message]);
  assert.match(r.message, new RegExp(`${trip.number} — التصحيح بنتيجة التسليم`));
});

test("an issued invoice blocks reopen; fully credited, it still does — and now says the credit note closed the order", async () => {
  const o = await makeOrder(1, { status: "dispatched" });
  const inv = await prisma.salesInvoice.create({
    data: {
      orderId: o.id, customerId,
      gross: new Prisma.Decimal("100"), discountTotal: new Prisma.Decimal(0), net: new Prisma.Decimal("100"), taxTotal: new Prisma.Decimal(0), total: new Prisma.Decimal("100"),
      createdBy: "test",
      lines: { create: { lineNo: 1, description: `${TAG} مانجا`, uomCode: "KG", quantity: new Prisma.Decimal(10), unitPrice: new Prisma.Decimal(10), taxCode: "EXEMPT", taxRate: new Prisma.Decimal(0), gross: new Prisma.Decimal(100), discount: new Prisma.Decimal(0), net: new Prisma.Decimal(100), tax: new Prisma.Decimal(0), total: new Prisma.Decimal(100) } },
    },
    include: { lines: true },
  });
  const issued = await issueInvoice(inv.id, {}, acct as never);

  let v = await orderActionView(o.id);
  let r = await refusal(reopenOrder(o.id, "preparing", sup as never, `${TAG} x`, o.version));
  assert.deepEqual([v.reopen.ok, v.reopen.status, v.reopen.message, v.reopen.invoice], [false, r.status, r.message, { id: inv.id, number: issued.number }]);
  assert.equal(r.status, 409);
  assert.match(r.message, new RegExp(`فاتورة صادرة ${issued.number} — مينفعش يتفتح تاني؛ المرتجع أو الإلغاء بإشعار دائن`));
  // Cancel is "reopen first" (and the reopen note says why that is closed).
  assert.equal(v.cancel.message, (await refusal(cancelOrder(o.id, sup as never, `${TAG} x`, o.version))).message);

  // Partly credited: the same path.
  await createCreditNote(inv.id, { reason: `${TAG} جزء`, lines: [{ invoice_line_id: inv.lines[0].id, quantity: 4 }] }, acct as never);
  r = await refusal(reopenOrder(o.id, "preparing", sup as never, `${TAG} x`, o.version));
  assert.equal(r.message, v.reopen.message);

  // Fully credited (no goods returned): still refused, with the closing credit notes named.
  await createCreditNote(inv.id, { reason: `${TAG} الباقي`, full: true }, acct as never);
  const notes = await prisma.creditNote.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: "asc" } });
  const viewed = await measure(() => orderActionView(o.id));
  v = viewed.result;
  r = await refusal(reopenOrder(o.id, "preparing", sup as never, `${TAG} x`, o.version));
  assert.deepEqual([v.reopen.ok, v.reopen.status, v.reopen.message], [false, r.status, r.message]);
  // Two credit notes close it: the plural wording.
  assert.equal(notes.length, 2);
  assert.equal(r.message, `الفاتورة ${issued.number} متخصومة بالكامل بالإشعارات ${notes.map((x) => x.number).join(", ")} — الأوردر اتقفل بالإشعارات دي ومفيش إعادة فتح بعد الفاتورة؛ لو هتبيعه تاني اعمل نسخة من الأوردر`);
  assert.equal(v.reopen.detail, "الإشعار ماكانش معاه رجوع بضاعة للمخزن");
  assert.ok(viewed.queries <= 5, `${viewed.queries} statements for the action state`);
  // Nothing was written by the refused reopens.
  const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([after.status, after.version], ["dispatched", o.version]);
  assert.equal((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "issued");
});

test("ORD-02: delivered on a trip that has left and invoiced — the invoice blocks reopen, not the trip, on the screen and in the service", async () => {
  const o = await makeOrder(1, { status: "dispatched" });
  const vehicle = await prisma.vehicle.create({ data: { code: `${TAG}-V2`, plate: `${TAG}-P2` } });
  const driver = await prisma.driver.create({ data: { name: `${TAG} سواق 2` } });
  const trip = await prisma.trip.create({ data: { number: `TRP-9998-${String(Date.now()).slice(-9)}`, status: "completed", tripDate: day, vehicleId: vehicle.id, driverId: driver.id, createdBy: "test" } });
  await prisma.tripStop.create({ data: { tripId: trip.id, orderId: o.id, sequence: 1 } });

  // Not invoiced yet: the delivery result is still the correction (unchanged).
  let v = await orderActionView(o.id);
  let r = await refusal(reopenOrder(o.id, "preparing", sup as never, `${TAG} x`, o.version));
  assert.deepEqual([v.reopen.ok, v.reopen.status, v.reopen.message], [false, r.status, r.message]);
  assert.match(r.message, new RegExp(`${trip.number} — التصحيح بنتيجة التسليم`));

  const inv = await prisma.salesInvoice.create({
    data: {
      orderId: o.id, customerId,
      gross: new Prisma.Decimal("50"), discountTotal: new Prisma.Decimal(0), net: new Prisma.Decimal("50"), taxTotal: new Prisma.Decimal(0), total: new Prisma.Decimal("50"),
      createdBy: "test",
      lines: { create: { lineNo: 1, description: `${TAG} مانجا`, uomCode: "KG", quantity: new Prisma.Decimal(5), unitPrice: new Prisma.Decimal(10), taxCode: "EXEMPT", taxRate: new Prisma.Decimal(0), gross: new Prisma.Decimal(50), discount: new Prisma.Decimal(0), net: new Prisma.Decimal(50), tax: new Prisma.Decimal(0), total: new Prisma.Decimal(50) } },
    },
  });
  // A draft does not block (it is voided on reopen) and does not change the trip answer.
  v = await orderActionView(o.id);
  assert.match(v.reopen.message!, /التصحيح بنتيجة التسليم/);

  const issued = await issueInvoice(inv.id, {}, acct as never);
  v = await orderActionView(o.id);
  r = await refusal(reopenOrder(o.id, "preparing", sup as never, `${TAG} x`, o.version));
  assert.deepEqual([v.reopen.ok, v.reopen.status, v.reopen.message, v.reopen.invoice, v.reopen.trip], [false, r.status, r.message, { id: inv.id, number: issued.number }, trip.number]);
  assert.equal(r.status, 409);
  assert.match(r.message, new RegExp(`فاتورة صادرة ${issued.number} — مينفعش يتفتح تاني؛ المرتجع أو الإلغاء بإشعار دائن`));

  // Fully credited: "closed by the credit note — copy the order", on the screen and in the service.
  await createCreditNote(inv.id, { reason: `${TAG} كله`, full: true }, acct as never);
  v = await orderActionView(o.id);
  r = await refusal(reopenOrder(o.id, "preparing", sup as never, `${TAG} x`, o.version));
  assert.deepEqual([v.reopen.ok, v.reopen.status, v.reopen.message], [false, r.status, r.message]);
  assert.match(r.message, /متخصومة بالكامل بالإشعار .* اعمل نسخة من الأوردر$/);
  // Nothing was written by the refused reopens.
  const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([after.status, after.version], ["dispatched", o.version]);
});
