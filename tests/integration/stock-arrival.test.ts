/* The awaiting-stock check on every path that makes stock sellable (release gate D-2, Nov 2026).
   Every stock movement (postMovements) and every reservation change reports to one place
   (lib/inventory/availability-changes.ts); at commit, the orders waiting for a product whose
   sellable availability rose are re-checked and their people told — once per change, with what
   is still missing. Waste, quarantine and expired lots never count. Telling reserves and raises
   nothing. Synthetic data on the test database. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, inTx, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { recordIntake, updateIntake } from "@/lib/stock-service";
import { cancelOrder, createOrder } from "@/lib/orders-service";
import { createAdjustment, createSorting, postOpeningStockInTx } from "@/lib/inventory/documents";
import { updateLotExpiry } from "@/lib/inventory/products";
import { createLocation, updateLocation } from "@/lib/core/org-service";
import { decideApproval } from "@/lib/core/approval-handlers";
import { mapOrderProductName } from "@/lib/product-master-service";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZARR${Date.now()}`;
const day = `2099-12-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role], ids[username], role), source: "manual" as const, permissions: ROLE_PERMISSIONS[role] as string[] });
let sales: ReturnType<typeof as>, sup: ReturnType<typeof as>, stock: ReturnType<typeof as>, admin: ReturnType<typeof as>, accountant: ReturnType<typeof as>;
let supplierId = "", customerId = "";

async function product(label: string) {
  return (await prisma.stockProduct.create({ data: { name: `${TAG} ${label}`, nameAr: `${TAG} ${label}`, unit: "KG" } })).id;
}
const receive = (productId: string, kg: number, extra: Record<string, unknown> = {}) =>
  recordIntake({ supplier_id: supplierId, product_id: productId, received_kg: kg, unit_cost: "5", location_id: "loc_cold_1", ...extra } as never, stock as never);
const line = (productId: string, quantity: number) => ({ stock_product_id: productId, product_name: "", quantity, unit: "KG" });
const order = (items: ReturnType<typeof line>[], allowShortage = true) =>
  createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, allow_shortage: allowShortage, items } as never, sales as never);
const notes = (orderId: string) => prisma.notification.findMany({ where: { entityType: "order", entityId: orderId, type: { startsWith: "order.stock_" } }, orderBy: { createdAt: "asc" } });
const types = async (orderId: string) => [...new Set((await notes(orderId)).map((n) => n.type))];
/** Telling never reserves, moves or buys: still held, nothing reserved, one open suggestion per short line. */
async function untouched(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.deepEqual([o.stockStatus, o.status], ["awaiting_stock", "new"]);
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: orderId, status: "active" } }), 0);
  const open = await prisma.purchaseRequest.groupBy({ by: ["orderItemId"], where: { orderId, status: { in: ["pending_approval", "approved"] } }, _count: { _all: true } });
  assert.ok(open.every((g) => g._count._all === 1), "never a second open suggestion for a line");
}

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  stock = as("hossam", "STOCK_CONTROLLER", "حسام مخازن");
  admin = as("admin", "SUPER_ADMIN", "مدير النظام");
  accountant = as("karim", "ACCOUNTANT", "كريم محاسب");
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-5${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "fruit" } })).id;
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
});
after(() => prisma.$disconnect());

test("Grade B produced by grading after receipt tells the orders waiting for the Grade B SKU — not those of the graded product", async () => {
  const a = await product("عنب");
  const b = await product("عنب فرزة");
  const raw = (await receive(a, 20)).intake;
  const forA = await order([line(a, 25)]);
  const forB = await order([line(b, 5)]);
  assert.deepEqual(await types(forB.id), []);
  const before = (await notes(forA.id)).length;
  // No waste: nothing to approve, the 6 Grade B kilos are sellable at once on their own SKU.
  await createSorting({ intake_id: raw.id, input_kg: "20", good_kg: "14", grade_b_kg: "6", waste_kg: "0", grade_b_product_id: b, reason: TAG }, stock as never);
  assert.deepEqual(await types(forB.id), ["order.stock_ready"], "the Grade B SKU's order is told");
  assert.equal((await notes(forA.id)).length, before, "the graded product lost sellable stock: its order hears nothing");
  await untouched(forB.id);
});

test("opening stock tells waiting orders, whether posted by an approved batch (inTx) or outside it", async () => {
  const p = await product("كمثرى");
  const q = await product("خوخ");
  const o = await order([line(p, 4)]);
  await inTx((tx) => postOpeningStockInTx(tx, { date: todayLocalISO(), sourceId: `${TAG}:1`, lines: [{ product_id: p, quantity: "4", unit_cost: "6" }] }, accountant as never));
  assert.deepEqual(await types(o.id), ["order.stock_ready"]);
  await untouched(o.id);
  // A caller with its own transaction (not inTx): the check runs right away, not lost.
  const o2 = await order([line(q, 2)]);
  await prisma.$transaction((tx) => postOpeningStockInTx(tx, { date: todayLocalISO(), sourceId: `${TAG}:2`, lines: [{ product_id: q, quantity: "2", unit_cost: "6" }] }, accountant as never));
  assert.deepEqual(await types(o2.id), ["order.stock_ready"]);
});

test("an upward receipt correction tells; a downward one does not", async () => {
  const p = await product("تفاح");
  const { intake } = await receive(p, 6);
  const o = await order([line(p, 10)]);
  assert.deepEqual(await types(o.id), []);
  const v1 = (await prisma.stockIntake.findUniqueOrThrow({ where: { id: intake.id } })).version;
  await updateIntake(intake.id, { received_kg: 7 }, stock as never, `${TAG} وزن غلط`, v1);
  assert.deepEqual(await types(o.id), [], "7 of 10 is still short (one line: nothing covered yet)");
  const v2 = (await prisma.stockIntake.findUniqueOrThrow({ where: { id: intake.id } })).version;
  await updateIntake(intake.id, { received_kg: 10 }, stock as never, `${TAG} وزن غلط`, v2);
  assert.deepEqual(await types(o.id), ["order.stock_ready"]);
  const n = (await notes(o.id)).length;
  const v3 = (await prisma.stockIntake.findUniqueOrThrow({ where: { id: intake.id } })).version;
  await updateIntake(intake.id, { received_kg: 9 }, stock as never, `${TAG} وزن غلط`, v3);
  assert.equal((await notes(o.id)).length, n);
  await untouched(o.id);
});

test("a positive stock adjustment tells when it posts — at its approval by someone else, not when it is asked for", async () => {
  const p = await product("أناناس");
  const o = await order([line(p, 3)]);
  const res = await createAdjustment({ reason: `${TAG} جرد`, lines: [{ product_id: p, quantity: "3", location_id: "loc_cold_1" }] }, stock as never);
  assert.deepEqual(await types(o.id), [], "waiting for approval: nothing posted yet");
  const a = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "inventory.adjustment", entityId: res.document.id, status: "pending" } });
  await decideApproval(a.id, "approve", admin as never, { comment: TAG });
  assert.deepEqual(await types(o.id), ["order.stock_ready"]);
  await untouched(o.id);
});

test("waste never tells: a delivery that is all waste, before and after its loss is approved", async () => {
  const p = await product("بلح");
  const o = await order([line(p, 1)]);
  const { intake } = await receive(p, 5, { waste_qty: 5 });
  assert.deepEqual(await types(o.id), []);
  const a = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "inventory.grading_loss", entityId: intake.id, status: "pending" } });
  await decideApproval(a.id, "approve", sup as never, { comment: TAG });
  assert.deepEqual(await types(o.id), [], "nothing sellable was released");
  await untouched(o.id);
});

test("a released reservation tells: another order cancelled frees what it held", async () => {
  const p = await product("كيوي");
  await receive(p, 10);
  const holder = await order([line(p, 10)], false);
  assert.equal(holder.stockStatus, "ok");
  const waiting = await order([line(p, 10)]);
  assert.equal(waiting.stockStatus, "awaiting_stock");
  await cancelOrder(holder.id, sup as never, `${TAG} العميل لغى`);
  assert.deepEqual(await types(waiting.id), ["order.stock_ready"]);
  await untouched(waiting.id);
});

test("stock that did not move but became sellable tells: an expiry corrected, a quarantine turned into a shelf", async () => {
  const p = await product("رمان");
  const { intake } = await receive(p, 3, { expiry_date: "2020-01-01", received_date: "2019-12-01" });
  const o = await order([line(p, 3)]);
  assert.deepEqual(await types(o.id), [], "an expired lot is not sellable");
  const lot = await prisma.stockLot.findUniqueOrThrow({ where: { id: intake.lotId! } });
  await updateLotExpiry(lot.id, { expiry_date: "2099-12-31", reason: `${TAG} تاريخ غلط`, expected_version: lot.version }, stock as never);
  assert.deepEqual(await types(o.id), ["order.stock_ready"]);

  const q = await product("جوافة");
  const wh = await prisma.warehouse.findFirstOrThrow({ where: { id: "wh_main" } });
  const hold = await createLocation({ warehouse_id: wh.id, code: `Q${String(Date.now()).slice(-6)}`, name: `${TAG} hold`, type: "quarantine" }, admin as never);
  await receive(q, 2, { location_id: hold.id });
  const o2 = await order([line(q, 2)]);
  assert.deepEqual(await types(o2.id), []);
  await updateLocation(hold.id, { type: "cold_room", expected_version: hold.version }, admin as never);
  assert.deepEqual(await types(o2.id), ["order.stock_ready"]);
});

test("the notice names the product and what is still missing; another product's arrival tells nobody", async () => {
  const a = await product("برتقال");
  const b = await product("يوسفي");
  const o = await order([line(a, 4), line(b, 6)]);
  await receive(b, 2); // b is still short
  assert.deepEqual(await types(o.id), []);
  await receive(a, 4);
  const [n] = await notes(o.id);
  assert.equal(n.type, "order.stock_partial");
  assert.match(n.body ?? "", /1 من 2 سطر ناقص اتغطى/);
  assert.match(n.body ?? "", new RegExp(`${TAG} يوسفي 4 KG`), "what is still missing, by product, in its unit");
  const other = await product("ليمون");
  const unrelated = await order([line(other, 1)]);
  await receive(a, 3);
  assert.deepEqual(await types(unrelated.id), []);
  await untouched(o.id);
});

test("two rises at once (an order cancelled while a receipt posts) still tell the order it is ready", async () => {
  for (let round = 0; round < 3; round++) {
    // One product: each transaction alone brings only half of what the order needs.
    const p = await product(`تين ${round}`);
    await receive(p, 5);
    const holder = await order([line(p, 5)], false);
    const waiting = await order([line(p, 10)]);
    await Promise.all([cancelOrder(holder.id, sup as never, `${TAG} لغى`), receive(p, 5)]);
    assert.ok((await types(waiting.id)).includes("order.stock_ready"), `round ${round}: the last to commit sees both`);
    await untouched(waiting.id);
    // Two products: each transaction covers one line.
    const a = await product(`كاكا ${round}`);
    const b = await product(`قشطة ${round}`);
    await receive(b, 5);
    const holderB = await order([line(b, 5)], false);
    const both = await order([line(a, 5), line(b, 5)]);
    await Promise.all([cancelOrder(holderB.id, sup as never, `${TAG} لغى`), receive(a, 5)]);
    assert.ok((await types(both.id)).includes("order.stock_ready"), `round ${round}: both lines covered, the order is told it is ready`);
  }
});

test("re-mapping order lines frees their old product once: the waiting order hears the final state, not each step", async () => {
  const a = await product("مشمش");
  const b = await product("مشمش مستورد");
  await receive(a, 10);
  await receive(b, 10);
  const name = `${TAG} مشمش X`;
  const o1 = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items: [{ stock_product_id: a, product_name: name, quantity: 5, unit: "KG" }] } as never, sales as never);
  const o2 = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items: [{ stock_product_id: a, product_name: name, quantity: 5, unit: "KG" }] } as never, sales as never);
  assert.deepEqual([o1.stockStatus, o2.stockStatus], ["ok", "ok"]);
  // The customer's own wording on the line (as an imported order keeps it), mapped to A.
  await prisma.orderItem.updateMany({ where: { orderId: { in: [o1.id, o2.id] } }, data: { productName: name } });
  const waiting = await order([line(a, 5), line(a, 5)]);
  await mapOrderProductName({ product_name: name, product_id: b, create_alias: false, reason: TAG }, admin as never);
  assert.deepEqual(await types(waiting.id), ["order.stock_ready"], "one transaction, one final state");
  await untouched(waiting.id);
});

test("concurrent receipts tell each person once per change, and reserve or raise nothing", async () => {
  const p = await product("موز");
  const o = await order([line(p, 3)]);
  await Promise.all([1, 2, 3].map(() => receive(p, 1)));
  const told = await notes(o.id);
  assert.ok(told.length >= 1);
  const per = new Map<string, number>();
  for (const n of told) per.set(`${n.recipientId}|${n.dedupeKey}`, (per.get(`${n.recipientId}|${n.dedupeKey}`) ?? 0) + 1);
  assert.ok([...per.values()].every((c) => c === 1), "one row per person and state");
  assert.ok(told.some((n) => n.recipientId === ids.mona) && told.some((n) => n.recipientId === ids.sara), "the creator and whoever may release it");
  assert.ok(!told.some((n) => n.recipientId === ids.hossam), "not the receiver who caused it");
  await untouched(o.id);
});

test("more than 200 orders waiting on one product: every one is told by one receipt", async () => {
  const p = await product("بطيخ");
  const waiting: string[] = [];
  for (let i = 0; i < 205; i++) waiting.push((await order([line(p, 1)])).id);
  await receive(p, 205);
  const told = await prisma.notification.groupBy({ by: ["entityId"], where: { entityType: "order", entityId: { in: waiting }, type: "order.stock_ready" } });
  assert.equal(told.length, 205, "it used to stop at the oldest 200");
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: { in: waiting }, status: "active" } }), 0);
});
