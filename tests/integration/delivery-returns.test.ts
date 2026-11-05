import { countQueries } from "./_query-count";
/* Goods that come back after dispatch (Nov 2026).

   - LOG-6: a dispatched order whose customer already sent goods back (a posted return linked
     to it) cannot be reopened — reversing the whole issue would put those goods back twice. And
     the return cap counts the live issue only, not one a reopen took back.
   - PW-10 / LOG-8: goods refused at the door come back in the order line's own unit (a crate of
     18 kg is 18 kg, not 1 kg), so a credit note for them is backed; the trip's weight counts
     crate lines at their weight.
   - PW-7: a delivery result raises its exceptions and posts its return in a fixed number of
     statements, whatever the number of lines.
   Synthetic data on the test database. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor, taxNo } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { postMovements, type MoveInput } from "@/lib/inventory/ledger";
import { D } from "@/lib/inventory/decimal";
import { createCustomerReturn, reverseDocument } from "@/lib/inventory/documents";
import { createCustomer } from "@/lib/sales/customers";
import { createCreditNote, issueInvoice } from "@/lib/sales/invoicing";
import { createOrder, moveOrderStatus, reopenOrder } from "@/lib/orders-service";
import { confirmLoaded, createTrip, dispatchTrip, recordDelivery, startLoading } from "@/lib/operations/trips";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZRET${Date.now()}`;
const today = todayLocalISO();
const day = `2099-08-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role] as string[], ids[username], role), source: "manual" as const });
let sales: ReturnType<typeof as>, loader: ReturnType<typeof as>, sup: ReturnType<typeof as>, stock: ReturnType<typeof as>, admin: ReturnType<typeof as>;
let customerId = "";
let supplierId = "";
let seq = 0;

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  loader = as("mostafa", "LOADER", "مصطفى تحميل");
  sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  stock = as("hossam", "STOCK_CONTROLLER", "حسام مخازن");
  admin = as("admin", "SUPER_ADMIN", "مدير النظام");
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق`, tax_registration_no: taxNo() }, sales as never)).id;
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-4${String(Date.now()).slice(-7)}`, name: `${TAG} مورد` } })).id;
});
after(() => prisma.$disconnect());

/** A KG product with `kg` in stock at 10 a kilo; `crate` > 0 adds a CRATE packaging of that many kg. */
async function product(kg: number, crate = 0) {
  const k = ++seq;
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} P${k}`, unit: "KG" } });
  if (crate) await prisma.productPackaging.create({ data: { productId: p.id, uomCode: "CRATE", qtyInBaseUnit: crate } });
  const intake = await prisma.stockIntake.create({ data: { receiptNumber: `${TAG}-RC${k}`, receivedDate: today, supplierId, productId: p.id, receivedQty: 1, goodQty: 1, warehouseId: "wh_main", locationId: "loc_recv", recordedBy: "test" } });
  const move: MoveInput = { productId: p.id, warehouseId: "wh_main", locationId: "loc_cold_1", lotId: null, quantity: D(kg), kind: "intake", intakeId: intake.id, unitCost: D(10), costSource: "purchase" };
  await inTx((tx) => postMovements(tx, [move], { actorId: null, actorName: "test", effectiveDate: today }));
  return p;
}
/** An order of these lines, loaded (prepared = loaded = required) and ready to leave. */
async function loadedOrder(lines: { productId: string; quantity: number; unit: string }[]) {
  const o = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items: lines.map((l) => ({ stock_product_id: l.productId, product_name: "", quantity: l.quantity, unit: l.unit })) } as never, sales as never);
  for (const i of await prisma.orderItem.findMany({ where: { orderId: o.id } })) {
    await prisma.orderItem.update({ where: { id: i.id }, data: { preparedQuantity: i.requiredQuantity, loadedQuantity: i.requiredQuantity, preparationStatus: "done", loadingStatus: "done" } });
  }
  await prisma.order.update({ where: { id: o.id }, data: { status: "loaded", crateCount: 2 } });
  return o.id;
}
const version = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).version;
const ship = { vehicle: "TRK-R", driverName: "سواق", crateCount: 2 };
async function fleet(capacityKg: number | null = null) {
  const k = ++seq;
  const vehicle = await prisma.vehicle.create({ data: { code: `${TAG}-V${k}`, plate: `${TAG}-${k}`, type: "truck", capacityKg } });
  const driver = await prisma.driver.create({ data: { name: `${TAG} سواق ${k}` } });
  return { vehicle_id: vehicle.id, driver_id: driver.id };
}
/** Plans, loads and dispatches a trip of these (loaded) orders. */
async function dispatchedTrip(orderIds: string[]) {
  const trip = await createTrip({ ...(await fleet()), order_ids: orderIds }, sup as never);
  await startLoading(trip.id, loader as never);
  await confirmLoaded(trip.id, loader as never);
  await dispatchTrip(trip.id, {}, loader as never);
  return prisma.tripStop.findMany({ where: { tripId: trip.id }, orderBy: { sequence: "asc" } });
}
const rejects = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: { status?: number; message?: string }) => e.status === status && (!re || re.test(e.message ?? "")));

test("LOG-6: a dispatched order with a customer return on it is not reopened; the return cap counts the live issue only", async () => {
  const p = await product(300);
  const o = await loadedOrder([{ productId: p.id, quantity: 100, unit: "KG" }]);
  await moveOrderStatus(o, "dispatched", loader as never, { ...ship, expectedVersion: await version(o) });
  const ret = (await createCustomerReturn({ order_id: o, reason: `${TAG} رفض جزئي`, lines: [{ product_id: p.id, quantity: 30 }] }, stock as never)).document;

  await rejects(reopenOrder(o, "ready_for_loading", sup as never, "إلغاء", await version(o)), 409, new RegExp(`اتسجل مرتجع ${ret.number}`));
  await rejects(moveOrderStatus(o, "ready_for_loading", sup as never, { reason: "تصحيح", expectedVersion: await version(o) }), 409, /اعكس المرتجع الأول/);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o } })).status, "dispatched", "nothing moved");
  assert.equal(await prisma.inventoryDocument.count({ where: { sourceType: "order", sourceId: o, type: "issue", status: "posted" } }), 1, "the issue stands");

  // Taking the return back first, the order reopens; dispatched again, it shipped 100 — not 200.
  await reverseDocument(ret.id, { reason: "اتسجل غلط" }, stock as never);
  await reopenOrder(o, "ready_for_loading", sup as never, "إلغاء", await version(o));
  for (const i of await prisma.orderItem.findMany({ where: { orderId: o } })) await prisma.orderItem.update({ where: { id: i.id }, data: { loadingStatus: "done" } });
  await prisma.order.update({ where: { id: o }, data: { status: "loaded" } });
  await moveOrderStatus(o, "dispatched", loader as never, { ...ship, expectedVersion: await version(o) });
  await rejects(createCustomerReturn({ order_id: o, reason: `${TAG} كتير`, lines: [{ product_id: p.id, quantity: 101 }] }, stock as never), 409, /أكتر من اللي اتشحن للطلب \(100\.000\)/);
  const back = await createCustomerReturn({ order_id: o, reason: `${TAG} كله`, lines: [{ product_id: p.id, quantity: 100 }] }, stock as never);
  assert.equal(back.document.movements.reduce((a, m) => a.plus(m.quantity), D(0)).toString(), "100");
});

test("PW-10: goods refused at the door come back in the line's unit — 2 crates of 18 kg are 36 kg — and a credit note for them is backed", async () => {
  const crate = await product(200, 18);
  const loose = await product(50);
  const a = await loadedOrder([{ productId: crate.id, quantity: 5, unit: "CRATE" }, { productId: loose.id, quantity: 4, unit: "KG" }]);
  const b = await loadedOrder([{ productId: crate.id, quantity: 3, unit: "CRATE" }, { productId: loose.id, quantity: 2, unit: "KG" }]);
  const [stopA, stopB] = await dispatchedTrip([a, b]);
  const itemsA = await prisma.orderItem.findMany({ where: { orderId: a } });
  const crateLine = itemsA.find((i) => i.unit === "CRATE")!;

  await recordDelivery(stopA.id, { result: "delivered", receiver_name: "أمين", lines: [{ order_item_id: crateLine.id, rejected_qty: 2, reason: "مضروب" }] }, loader as never);
  const docA = (await prisma.tripStop.findUniqueOrThrow({ where: { id: stopA.id } })).returnDocumentId!;
  const movesA = await prisma.stockMovement.findMany({ where: { documentId: docA } });
  assert.deepEqual(movesA.map((m) => [m.productId, m.quantity.toString(), m.locationId, m.unitCost?.toString()]), [[crate.id, "36", "loc_quarantine", "10"]], "2 crates = 36 kg, back at the cost they left at");

  // The delivery failed: everything comes back, each line in its own unit.
  await recordDelivery(stopB.id, { result: "failed", failure_reason: "المحل مقفول" }, loader as never);
  const docB = (await prisma.tripStop.findUniqueOrThrow({ where: { id: stopB.id } })).returnDocumentId!;
  const movesB = await prisma.stockMovement.findMany({ where: { documentId: docB } });
  assert.deepEqual(movesB.map((m) => [m.productId, m.quantity.toString()]).sort(), [[crate.id, "54"], [loose.id, "2"]].sort());

  // A credit note for the 2 crates against that return document: 36 kg credited, 36 kg came back.
  const zero = new Prisma.Decimal(0);
  const inv = await prisma.salesInvoice.create({
    data: {
      customerId, gross: new Prisma.Decimal(500), discountTotal: zero, net: new Prisma.Decimal(500), taxTotal: zero, total: new Prisma.Decimal(500), createdBy: "test",
      lines: { create: { lineNo: 1, productId: crate.id, description: crate.name, uomCode: "CRATE", quantity: new Prisma.Decimal(5), unitPrice: new Prisma.Decimal(100), taxCode: "EXEMPT", taxRate: zero, gross: new Prisma.Decimal(500), discount: zero, net: new Prisma.Decimal(500), tax: zero, total: new Prisma.Decimal(500) } },
    },
    include: { lines: true },
  });
  await issueInvoice(inv.id, {}, admin as never);
  const cn = await createCreditNote(inv.id, { reason: "رفض عند التسليم", lines: [{ invoice_line_id: inv.lines[0].id, quantity: 2 }], return_document_id: docA }, admin as never);
  assert.equal(D((cn as { total: Prisma.Decimal }).total).toString(), "200");
});

test("LOG-8: a trip's weight counts crate lines at their weight", async () => {
  const crate = await product(200, 18);
  const o = await loadedOrder([{ productId: crate.id, quantity: 6, unit: "CRATE" }]);
  await rejects(createTrip({ ...(await fleet(100)), order_ids: [o] }, sup as never), 409, /الحمولة 108 كجم أكبر من سعة العربية/);
  const trip = await createTrip({ ...(await fleet(110)), order_ids: [o] }, sup as never);
  assert.ok(trip.id, "108 kg fit in 110");
});

test("PW-7: a delivery result costs the same at 5 and 30 lines (return, exceptions and notices batched)", async () => {
  const counts: Record<number, number> = {};
  for (const n of [5, 30]) {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push({ productId: (await product(40, i % 2 ? 5 : 0)).id, quantity: 4, unit: i % 2 ? "CRATE" : "KG" });
    const o = await loadedOrder(lines);
    const [stop] = await dispatchedTrip([o]);
    const items = await prisma.orderItem.findMany({ where: { orderId: o } });
    const result = { result: "delivered", receiver_name: "أمين", lines: items.map((i) => ({ order_item_id: i.id, shortage_qty: 1, rejected_qty: 1, reason: "ناقص ومرفوض" })) };
    counts[n] = (await countQueries(() => recordDelivery(stop.id, result, loader as never))).queries;
    const raised = await prisma.operationalException.findMany({ where: { sourceId: stop.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    assert.equal(raised.length, n * 2, "a shortage and a rejection per line");
    assert.deepEqual(raised.slice(0, 2).map((x) => x.type), ["shortage", "rejection"], "in line order, as raised one by one");
    const ret = await prisma.stockMovement.findMany({ where: { document: { sourceType: "order", sourceId: o, type: "customer_return" } } });
    const crates = lines.filter((l) => l.unit === "CRATE").length;
    assert.equal(ret.reduce((a, m) => a.plus(m.quantity), D(0)).toString(), String(n - crates + crates * 5), "one rejected unit per line, a crate at 5 kg");
    assert.equal(await prisma.auditLog.count({ where: { action: "exception_raised", entityId: { in: raised.map((x) => x.id) } } }), n * 2);
  }
  console.log(`delivery statements: ${JSON.stringify(counts)}`);
  assert.equal(counts[30], counts[5], `the delivery result grows with lines: ${JSON.stringify(counts)}`);
});
