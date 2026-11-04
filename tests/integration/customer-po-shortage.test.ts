/* Customer PO intake and orders waiting for stock (Nov 2026). A customer's PO is saved with its
   PO reference; a fully available order goes ahead exactly as before; a short order is refused
   unless the user asks to save it "awaiting stock" — then it reserves nothing, cannot leave
   "new", is kept off the floor, and each short line raises one procurement suggestion (a
   purchase request linked to the order and the line). Receipts re-read the coverage and tell
   the order's people once per change; "re-check and release" reserves everything or nothing.
   Cancelling the order closes its suggestions; cancelling a PO returns its requests to
   "approved". Synthetic data on the test database. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, inTx, actor, withSetting } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { recordIntake } from "@/lib/stock-service";
import { cancelOrder, createOrder, editRequiredQuantity, listOrders, moveOrderStatus, productionScope } from "@/lib/orders-service";
import { orderStockView, releaseHeldOrder } from "@/lib/sales/stock-hold";
import { StockUnavailableError } from "@/lib/sales/stock-commitment";
import { cancelPurchaseRequest, convertPurchaseRequest, createPurchaseRequest, fulfilPurchaseRequest, listPurchaseRequests, syncOrderSuggestions } from "@/lib/purchasing/requests";
import { cancelPurchaseOrder, submitPurchaseOrder } from "@/lib/purchasing/orders";
import { decideApproval } from "@/lib/core/approval-handlers";
import { searchWhere } from "@/lib/core/search";
import { dailyConsolidatedSheet } from "@/lib/picking-sheet";
import { ApiError } from "@/lib/rbac";

const TAG = `ZZCPO${Date.now()}`;
const day = `2099-10-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role], ids[username], role), source: "manual" as const, permissions: ROLE_PERMISSIONS[role] as string[] });
let sales: ReturnType<typeof as>, sup: ReturnType<typeof as>, buyer: ReturnType<typeof as>, stock: ReturnType<typeof as>, prep: ReturnType<typeof as>;
let supplierId = "", customerId = "";
let restoreThreshold: () => Promise<void> = async () => {};

async function product(label: string) {
  return (await prisma.stockProduct.create({ data: { name: `${TAG} ${label}`, nameAr: `${TAG} ${label}`, unit: "KG" } })).id;
}
async function receive(productId: string, kg: number, extra: Record<string, unknown> = {}) {
  return recordIntake({ supplier_id: supplierId, product_id: productId, received_kg: kg, unit_cost: "5", location_id: "loc_cold_1", ...extra } as never, stock as never);
}
const line = (productId: string, quantity: number) => ({ stock_product_id: productId, product_name: "", quantity, unit: "KG" });
const order = (items: ReturnType<typeof line>[], extra: Record<string, unknown> = {}, who = sales) =>
  createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items, ...extra } as never, who as never);
const activeReservations = (orderId: string) => prisma.stockReservation.count({ where: { sourceType: "order", sourceId: orderId, status: "active" } });
const lineRequests = (orderId: string) => prisma.purchaseRequest.findMany({ where: { orderId, orderItemId: { not: null } }, orderBy: { createdAt: "asc" } });
async function approveRequest(requestId: string) {
  const a = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "purchasing.request", entityId: requestId, status: "pending" } });
  await decideApproval(a.id, "approve", buyer as never, { comment: TAG });
}
async function toPurchaseOrder(requestId: string) {
  await approveRequest(requestId);
  const r = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } });
  const converted = await convertPurchaseRequest(requestId, { supplier_id: supplierId, unit_price: "5", expected_version: r.version }, buyer as never);
  await submitPurchaseOrder(converted.purchaseOrderId!, buyer as never);
  return prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId }, include: { purchaseOrder: true } });
}
async function rejects(p: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ApiError, String(err));
    assert.equal(err.status, status, err.message);
    if (code) assert.equal(err.code, code, err.message);
    return true;
  });
}
const notes = (orderId: string) => prisma.notification.findMany({ where: { entityType: "order", entityId: orderId, type: { startsWith: "order.stock_" } } });

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  buyer = as("omar", "PURCHASER", "عمر مشتريات");
  stock = as("hossam", "STOCK_CONTROLLER", "حسام مخازن");
  prep = as("ahmed", "PREPARER", "أحمد تجهيز");
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-8${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "vegetable" } })).id;
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
  restoreThreshold = await withSetting("purchasing.po_approval_threshold", "1000000");
});
after(async () => {
  await restoreThreshold();
  await prisma.$disconnect();
});

test("scenario 1: everything available — saved, reserved and the workflow is unchanged; a short order without the flag is still refused", async () => {
  const a = await product("طماطم");
  await receive(a, 100);
  const o = await order([line(a, 30)], { customer_po_ref: `  ${TAG}-PO-1  ` });
  assert.equal(o.stockStatus, "ok");
  assert.equal(o.customerPoRef, `${TAG}-PO-1`, "the PO reference is kept, trimmed");
  assert.equal(await activeReservations(o.id), 1);
  assert.equal((await lineRequests(o.id)).length, 0, "no suggestion for a covered order");
  // Even with the flag, a covered order is an ordinary order.
  const o2 = await order([line(a, 10)], { allow_shortage: true });
  assert.equal(o2.stockStatus, "ok");
  assert.equal(await activeReservations(o2.id), 1);
  const moved = await moveOrderStatus(o.id, "preparing", sup as never);
  assert.equal(moved.status, "preparing");

  // Default behaviour (no flag): a shortfall refuses the order and nothing is created.
  const before = await prisma.order.count({ where: { customerAccountId: customerId } });
  await assert.rejects(order([line(a, 1000)]), (err: unknown) => err instanceof StockUnavailableError && err.status === 409 && err.code === "stock_unavailable");
  await assert.rejects(order([line(a, 1000)], { allow_shortage: "yes" }), StockUnavailableError, "only an explicit true holds");
  assert.equal(await prisma.order.count({ where: { customerAccountId: customerId } }), before);
  // A data problem (an unmapped line) is never held, flag or not.
  await assert.rejects(
    createOrder({ external_id: `${TAG}-n8n-unmapped`, customer_name: `${TAG} Hotel`, delivery_date: day, allow_shortage: true, items: [{ product_name: `${TAG} مش في الدليل`, quantity: 5 }] }, { id: null, name: "n8n", role: "SYSTEM", source: "n8n", permissions: ["orders.create"] }),
    (err: unknown) => err instanceof StockUnavailableError && err.shortfalls[0].reason === "unmapped"
  );
  await rejects(order([line(a, 1)], { customer_po_ref: "x".repeat(101) }), 400);
  // The PO reference is searchable.
  const found = await listOrders({ q: `${TAG}-PO-1` });
  assert.deepEqual(found.map((x) => x.id), [o.id]);
});

test("scenario 2: one line short — held, suggestion linked to the line, PO, receipt notifies, release continues the workflow", async () => {
  const a = await product("خيار");
  const b = await product("فلفل");
  await receive(a, 50);
  await receive(b, 5);
  const o = await order([line(a, 10), line(b, 8)], { allow_shortage: true, customer_po_ref: `${TAG}-PO-2`, delivery_time: "09:30", notes: "باب الخدمة" });
  assert.equal(o.stockStatus, "awaiting_stock");
  assert.equal(o.status, "new");
  assert.equal(await activeReservations(o.id), 0, "a held order reserves nothing, not even its available line");
  const held = await prisma.auditLog.findFirstOrThrow({ where: { orderId: o.id, action: "order_held_for_stock" } });
  assert.match(held.newValue ?? "", /الناقص 3/);

  const [pr, ...more] = await lineRequests(o.id);
  assert.equal(more.length, 0, "only the short line gets a suggestion");
  const bLine = o.items.find((i) => i.stockProductId === b)!;
  assert.equal(pr.orderItemId, bLine.id);
  assert.equal(pr.productId, b);
  assert.equal(pr.status, "pending_approval");
  assert.deepEqual([pr.quantity.toFixed(), pr.requiredQty?.toFixed(), pr.availableQty?.toFixed()], ["3", "8", "5"]);
  assert.equal(pr.customerReference, `${TAG}-PO-2`, "the customer's PO reference, not the notes");
  assert.equal(pr.neededBy, day);
  assert.equal(pr.customerId, customerId);
  assert.ok(await prisma.approvalRequest.findFirst({ where: { type: "purchasing.request", entityId: pr.id, status: "pending" } }), "it waits for purchasing's approval like any request");
  // Purchasing sees it, with the originating order.
  const listed = (await listPurchaseRequests({ orderId: o.id }, buyer as never)).items;
  assert.deepEqual(listed.map((x) => [x.id, x.order?.orderNumber, x.orderItem?.id]), [[pr.id, o.orderNumber, bLine.id]]);

  // Off the floor: boards (stock=ok), production, picking sheet, and it cannot start.
  assert.ok(!(await listOrders({ status: ["new", "preparing"], stockStatus: "ok" })).some((x) => x.id === o.id));
  assert.equal(await prisma.order.count({ where: { AND: [productionScope(), { id: o.id }] } }), 0);
  assert.ok(!(await dailyConsolidatedSheet(day)).lines.some((l) => l.allocations.some((x) => x.orderId === o.id)));
  await rejects(moveOrderStatus(o.id, "preparing", sup as never), 409, "stock_awaiting");
  await rejects(moveOrderStatus(o.id, "ready_for_loading", sup as never, { reason: "override" }), 409, "stock_awaiting");

  const ordered = await toPurchaseOrder(pr.id);
  assert.equal(ordered.status, "ordered");
  // Fulfilment by a second order is refused — the held order itself is resumed.
  await rejects(fulfilPurchaseRequest(pr.id, { delivery_date: day, expected_version: ordered.version }, sales as never), 409);
  await rejects(releaseHeldOrder(o.id, sup as never), 409, "stock_unavailable");
  assert.equal((await notes(o.id)).length, 0);

  // The goods arrive against the PO line: the order is re-read and its people told — nothing reserved.
  const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { poId: ordered.purchaseOrderId! } });
  await receive(b, 3, { purchase_order_line_id: poLine.id, product_id: undefined, supplier_id: undefined, unit_cost: undefined });
  const after1 = await notes(o.id);
  assert.ok(after1.length >= 1 && after1.every((n) => n.type === "order.stock_ready"), JSON.stringify(after1.map((n) => n.type)));
  assert.ok(after1.some((n) => n.recipientId === ids.mona), "the order's creator is told");
  assert.ok(after1.some((n) => n.recipientId === ids.sara), "and whoever may release it");
  const still = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([still.stockStatus, still.status, await activeReservations(o.id)], ["awaiting_stock", "new", 0], "receipt never reserves or moves the order");
  // Another receipt for the order's products: no second notification for the same state.
  await receive(a, 1);
  assert.equal((await notes(o.id)).length, after1.length, "one notification per order per state change, not per receipt");

  const view = await orderStockView(o.id, sales as never);
  assert.equal(view.releasable, true);
  assert.deepEqual(view.lines.map((l) => l.shortage), ["0", "0"]);

  // Release: whoever may edit orders; sales, purchasing and stock may not.
  await rejects(releaseHeldOrder(o.id, sales as never), 403);
  await rejects(releaseHeldOrder(o.id, buyer as never), 403);
  await rejects(releaseHeldOrder(o.id, stock as never), 403);
  const released = await releaseHeldOrder(o.id, sup as never);
  assert.equal(released.stockStatus, "ok");
  assert.equal(await activeReservations(o.id), 2, "every line reserved in full");
  const fulfilled = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.deepEqual([fulfilled.status, fulfilled.fulfilledOrderId], ["fulfilled", o.id], "the suggestion is served by this order");
  // Nothing re-entered: PO ref, lines, delivery and history are as they were.
  assert.deepEqual([released.customerPoRef, released.deliveryTime, released.notes, released.items.length], [`${TAG}-PO-2`, "09:30", "باب الخدمة", 2]);
  assert.ok(await prisma.auditLog.findFirst({ where: { orderId: o.id, action: "order_created" } }));
  assert.ok(await prisma.auditLog.findFirst({ where: { orderId: o.id, action: "order_stock_released" } }));
  await rejects(releaseHeldOrder(o.id, sup as never), 409);
  const moved = await moveOrderStatus(o.id, "preparing", sup as never);
  assert.equal(moved.status, "preparing");
  assert.ok((await listOrders({ status: ["new", "preparing"], stockStatus: "ok" })).some((x) => x.id === o.id), "back on the boards");
});

test("scenario 3: several lines short — told when a line is covered, released only when every line is", async () => {
  const d = await product("فراولة");
  const e = await product("مانجو");
  await receive(e, 2);
  const o = await order([line(d, 4), line(e, 6)], { allow_shortage: true });
  const prs = await lineRequests(o.id);
  assert.deepEqual(prs.map((r) => r.quantity.toFixed()), ["4", "4"]);

  await receive(d, 4);
  const partial = await notes(o.id);
  assert.ok(partial.length >= 1 && partial.every((n) => n.type === "order.stock_partial"));
  await rejects(releaseHeldOrder(o.id, sup as never), 409, "stock_unavailable");
  await receive(d, 1);
  assert.equal((await notes(o.id)).length, partial.length, "the same covered set is not announced twice");
  assert.equal(await activeReservations(o.id), 0);

  await receive(e, 4);
  const all = await notes(o.id);
  assert.ok(all.some((n) => n.type === "order.stock_ready"));
  const released = await releaseHeldOrder(o.id, sup as never);
  assert.equal(released.stockStatus, "ok");
  assert.equal(await activeReservations(o.id), 2);
  // Open (unordered) suggestions are closed as covered.
  const closed = await lineRequests(o.id);
  assert.deepEqual(closed.map((r) => r.status), ["cancelled", "cancelled"]);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: { in: closed.map((r) => r.id) }, status: "pending" } }), 0);
});

test("scenario 4: partial delivery — the remaining requirement stays on the order and the request", async () => {
  const f = await product("بطاطس");
  const o = await order([line(f, 10)], { allow_shortage: true });
  const [pr] = await lineRequests(o.id);
  const ordered = await toPurchaseOrder(pr.id);
  const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { poId: ordered.purchaseOrderId! } });
  await receive(f, 6, { purchase_order_line_id: poLine.id, product_id: undefined, supplier_id: undefined, unit_cost: undefined });
  assert.equal((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ordered.purchaseOrderId! } })).status, "partially_received");
  const view = await orderStockView(o.id, buyer as never);
  assert.deepEqual([view.lines[0].covered, view.lines[0].shortage, view.releasable], ["6", "4", false]);
  await rejects(releaseHeldOrder(o.id, sup as never), 409, "stock_unavailable");
  // Re-sizing while the PO is open: the ordered request already covers the line — no top-up.
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  const rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => [r.status, r.quantity.toFixed()]), [["ordered", "10"]]);
  const listed = (await listPurchaseRequests({ orderId: o.id }, buyer as never)).items[0];
  assert.equal(listed.receivedGood, "6");
  await receive(f, 4, { purchase_order_line_id: poLine.id, product_id: undefined, supplier_id: undefined, unit_cost: undefined });
  const released = await releaseHeldOrder(o.id, sup as never);
  assert.equal(released.stockStatus, "ok");
  assert.equal((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } })).status, "fulfilled");
});

test("scenario 8: repeated save / edit never duplicates suggestions or reservations", async () => {
  const g = await product("كوسة");
  await receive(g, 2);
  const o = await order([line(g, 5)], { allow_shortage: true });
  const item = o.items[0];
  let rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => r.quantity.toFixed()), ["3"]);
  // Syncing again (a retried save) changes nothing.
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  assert.equal((await lineRequests(o.id)).length, 1);

  const edit = async (qty: number) => {
    const cur = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    return editRequiredQuantity(o.id, item.id, qty, sup as never, TAG, cur.version);
  };
  await edit(7);
  rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => [r.status, r.quantity.toFixed(), r.requiredQty?.toFixed()]), [["pending_approval", "5", "7"]], "resized, not duplicated");
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: rows[0].id, action: "purchase_request_quantity_changed" } }));
  await edit(7);
  assert.equal((await lineRequests(o.id)).length, 1);
  assert.equal(await activeReservations(o.id), 0, "editing a held order reserves nothing");
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: rows[0].id, status: "pending" } }), 1, "one approval request, not one per save");

  // Approved, then raised: back for approval (the approver signed off a smaller buy).
  await approveRequest(rows[0].id);
  await edit(9);
  rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => [r.status, r.quantity.toFixed()]), [["pending_approval", "7"]]);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: rows[0].id, status: "pending" } }), 1);

  // Lowered below what is available: the suggestion is closed. Raised again: one new one.
  await edit(2);
  rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => r.status), ["cancelled"]);
  await edit(6);
  rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => [r.status, r.quantity.toFixed()]), [["cancelled", "7"], ["pending_approval", "4"]]);
  assert.equal(await prisma.purchaseRequest.count({ where: { orderItemId: item.id, status: { in: ["pending_approval", "approved"] } } }), 1);

  // The database refuses a second open request for the same line, whatever the path.
  await assert.rejects(
    prisma.purchaseRequest.create({ data: { number: `${TAG}-DUP`, productId: g, uomCode: "KG", quantity: 1, orderId: o.id, orderItemId: item.id, requestedBy: "test" } }),
    (err: unknown) => (err as { code?: string }).code === "P2002"
  );
});

test("cancelling the order closes its suggestions; one already on a PO stays with purchasing", async () => {
  const h = await product("جزر");
  const k = await product("بصل");
  const o = await order([line(h, 3), line(k, 2)], { allow_shortage: true });
  const [prH, prK] = await lineRequests(o.id);
  await toPurchaseOrder(prK.id);
  await cancelOrder(o.id, sup as never, `${TAG} العميل لغى`);
  const [h2, k2] = await lineRequests(o.id);
  assert.deepEqual([h2.status, k2.status], ["cancelled", "ordered"]);
  assert.match(h2.cancelReason ?? "", /الأوردر اتلغى/);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: prH.id, status: "pending" } }), 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: prK.id, action: "purchase_request_origin_cancelled" } }));
  // Purchasing cancels the PO: the request comes back, and with its order gone it is closed.
  await cancelPurchaseOrder(k2.purchaseOrderId!, { reason: TAG }, buyer as never);
  const k3 = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: prK.id } });
  assert.deepEqual([k3.status, k3.purchaseOrderId], ["cancelled", null]);
});

test("cancelling a PO returns its requests from ordered to approved (no more dead end)", async () => {
  const m = await product("ليمون");
  const manual = await createPurchaseRequest({ product_id: m, quantity: 7, customer_id: customerId, needed_by: day }, sales as never);
  const ordered = await toPurchaseOrder(manual.id);
  await rejects(cancelPurchaseRequest(manual.id, { reason: TAG, expected_version: ordered.version }, sales as never), 409);
  await cancelPurchaseOrder(ordered.purchaseOrderId!, { reason: `${TAG} المورد اعتذر` }, buyer as never);
  const back = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: manual.id } });
  assert.deepEqual([back.status, back.purchaseOrderId, back.purchaseOrderLineId, back.decidedBy !== null], ["approved", null, null, true]);
  const row = await prisma.auditLog.findFirstOrThrow({ where: { entityId: manual.id, action: "purchase_request_reopened" } });
  assert.equal(row.reason, `${TAG} المورد اعتذر`);
  // It can be sourced again.
  const again = await convertPurchaseRequest(manual.id, { supplier_id: supplierId, unit_price: "6", expected_version: back.version }, buyer as never);
  assert.equal(again.status, "ordered");

  // A held order's line request returns to approved too and still serves the order.
  const n = await product("نعناع");
  const o = await order([line(n, 2)], { allow_shortage: true });
  const [pr] = await lineRequests(o.id);
  const po = await toPurchaseOrder(pr.id);
  await cancelPurchaseOrder(po.purchaseOrderId!, { reason: TAG }, buyer as never);
  const pr2 = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.deepEqual([pr2.status, pr2.quantity.toFixed(), pr2.orderItemId], ["approved", "2", o.items[0].id]);
});

test("scenario 9: permissions are enforced by the services", async () => {
  const p = await product("ريحان");
  const o = await order([line(p, 1)], { allow_shortage: true }, sales);
  assert.equal(o.stockStatus, "awaiting_stock", "sales may save a customer PO awaiting stock");
  // The purchasing side of the order view follows purchasing.requests.view.
  assert.equal((await orderStockView(o.id, sales as never)).suggestions?.length, 1);
  assert.equal((await orderStockView(o.id, buyer as never)).suggestions?.length, 1);
  assert.equal((await orderStockView(o.id, prep as never)).suggestions, null, "the floor does not see purchase requests");
  assert.equal((await orderStockView(o.id, stock as never)).suggestions, null);
  await rejects(listPurchaseRequests({}, stock as never), 403);
  await rejects(listPurchaseRequests({}, prep as never), 403);
  // Release needs orders.edit; preparation needs the release first, whoever asks.
  for (const who of [sales, buyer, stock, prep]) await rejects(releaseHeldOrder(o.id, who as never), 403);
  await rejects(moveOrderStatus(o.id, "preparing", prep as never), 409, "stock_awaiting");
  // Only purchasing turns a suggestion into a supplier PO.
  const [pr] = await lineRequests(o.id);
  await approveRequest(pr.id);
  const cur = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  await rejects(convertPurchaseRequest(pr.id, { supplier_id: supplierId, expected_version: cur.version }, sales as never), 403);
  await rejects(convertPurchaseRequest(pr.id, { supplier_id: supplierId, expected_version: cur.version }, sup as never), 403);
  // The order's creator cannot approve their own suggestion (four eyes).
  const self = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.notEqual(self.decidedById, self.requestedById);
  // Search finds the order by number (and the request by the order's PO reference when given).
  assert.ok((await searchWhere("order", o.orderNumber)).id?.in.includes(o.id));
});
