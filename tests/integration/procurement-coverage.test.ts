/* Procurement coverage of orders waiting for stock (release gate D-1, Nov 2026). A line's
   suggestion is netted only against what LIVE purchase orders still have to deliver (ordered −
   accepted); closing a PO releases what it will no longer bring, as cancelling does; receipts
   and grading against a PO re-size the suggestion; nothing here reserves or moves the order.
   Synthetic data on the test database. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, inTx, actor, withSetting } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { recordIntake, voidIntake } from "@/lib/stock-service";
import { createOrder, editRequiredQuantity } from "@/lib/orders-service";
import { releaseHeldOrder } from "@/lib/sales/stock-hold";
import { convertPurchaseRequest, syncOrderSuggestions } from "@/lib/purchasing/requests";
import { cancelPurchaseOrder, closePurchaseOrder, submitPurchaseOrder } from "@/lib/purchasing/orders";
import { createSorting } from "@/lib/inventory/documents";
import { decideApproval } from "@/lib/core/approval-handlers";
import { ApiError } from "@/lib/rbac";

const TAG = `ZZCOV${Date.now()}`;
const day = `2099-11-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role], ids[username], role), source: "manual" as const, permissions: ROLE_PERMISSIONS[role] as string[] });
let sales: ReturnType<typeof as>, sup: ReturnType<typeof as>, buyer: ReturnType<typeof as>, stock: ReturnType<typeof as>;
let supplierId = "", customerId = "";
let restoreThreshold: () => Promise<void> = async () => {};

async function product(label: string) {
  return (await prisma.stockProduct.create({ data: { name: `${TAG} ${label}`, nameAr: `${TAG} ${label}`, unit: "KG" } })).id;
}
const receive = (productId: string, kg: number, extra: Record<string, unknown> = {}) =>
  recordIntake({ supplier_id: supplierId, product_id: productId, received_kg: kg, unit_cost: "5", location_id: "loc_cold_1", ...extra } as never, stock as never);
const receiveOnPo = (poLineId: string, kg: number, extra: Record<string, unknown> = {}) =>
  recordIntake({ purchase_order_line_id: poLineId, received_kg: kg, location_id: "loc_cold_1", ...extra } as never, stock as never);
const line = (productId: string, quantity: number) => ({ stock_product_id: productId, product_name: "", quantity, unit: "KG" });
const heldOrder = (items: ReturnType<typeof line>[]) => createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, allow_shortage: true, items } as never, sales as never);
const lineRequests = (orderId: string) => prisma.purchaseRequest.findMany({ where: { orderId, orderItemId: { not: null } }, orderBy: { createdAt: "asc" } });
const openFor = (orderItemId: string) => prisma.purchaseRequest.findMany({ where: { orderItemId, status: { in: ["pending_approval", "approved"] } } });
const reservations = (orderId: string) => prisma.stockReservation.count({ where: { sourceType: "order", sourceId: orderId, status: "active" } });

/** Approved by purchasing — also a suggestion raised by purchasing's own PO close or receipt,
 * which is raised on behalf of whoever saved the order (four eyes). */
async function approve(requestId: string) {
  const a = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "purchasing.request", entityId: requestId, status: "pending" } });
  await decideApproval(a.id, "approve", buyer as never, { comment: TAG });
}
/** Approve (when pending) and convert a request into a submitted supplier PO; returns its line. */
async function toPo(requestId: string) {
  if ((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } })).status === "pending_approval") await approve(requestId);
  const r = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } });
  const converted = await convertPurchaseRequest(requestId, { supplier_id: supplierId, unit_price: "5", expected_version: r.version }, buyer as never);
  await submitPurchaseOrder(converted.purchaseOrderId!, buyer as never);
  return prisma.purchaseOrderLine.findFirstOrThrow({ where: { poId: converted.purchaseOrderId! } });
}
/** The order is exactly as it was saved: still waiting, still new, nothing reserved. */
async function stillHeld(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.deepEqual([o.stockStatus, o.status, await reservations(orderId)], ["awaiting_stock", "new", 0], "the order keeps waiting; nothing is reserved or moved");
}
async function rejects(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (err: unknown) => err instanceof ApiError && err.status === status);
}

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  buyer = as("omar", "PURCHASER", "عمر مشتريات");
  stock = as("hossam", "STOCK_CONTROLLER", "حسام مخازن");
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-6${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "vegetable" } })).id;
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
  restoreThreshold = await withSetting("purchasing.po_approval_threshold", "1000000");
});
after(async () => {
  await restoreThreshold();
  await prisma.$disconnect();
});

test("PO closed after its delivery was rejected in full: the request is released and can be sourced again", async () => {
  const p = await product("طماطم");
  const o = await heldOrder([line(p, 10)]);
  const [pr] = await lineRequests(o.id);
  const poLine = await toPo(pr.id);
  await receiveOnPo(poLine.id, 10, { rejected_kg: 10, rejection_reason: `${TAG} مضروب` });
  assert.equal((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poLine.poId } })).status, "partially_received");
  // While the PO is open the supplier still owes the 10: covered, no second suggestion.
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  assert.equal((await openFor(pr.orderItemId!)).length, 0);

  await rejects(cancelPurchaseOrder(poLine.poId, { reason: TAG }, buyer as never), 409); // something was received
  await closePurchaseOrder(poLine.poId, { reason: `${TAG} المورد مش هيعوض` }, buyer as never);
  const back = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.deepEqual([back.status, back.purchaseOrderId, back.purchaseOrderLineId, back.quantity.toFixed(), back.orderItemId], ["approved", null, null, "10", pr.orderItemId], "nothing came: released like a cancelled PO, sized to the whole shortage");
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: pr.id, action: "purchase_request_reopened", reason: `${TAG} المورد مش هيعوض` } }));
  assert.equal((await openFor(pr.orderItemId!)).length, 1, "exactly one open suggestion for the line");
  await stillHeld(o.id);

  // Reopened coverage: purchasing sources it again; the new PO covers the line (no duplicate).
  const again = await toPo(pr.id);
  assert.notEqual(again.poId, poLine.poId);
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  assert.deepEqual((await lineRequests(o.id)).map((r) => [r.status, r.quantity.toFixed()]), [["ordered", "10"]]);
  await receiveOnPo(again.id, 10);
  const released = await releaseHeldOrder(o.id, sup as never);
  assert.equal(released.stockStatus, "ok");
  assert.equal((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } })).status, "fulfilled");
});

test("PO closed after a partial receipt: what came stays on the PO, the rest is raised again once", async () => {
  const p = await product("خيار");
  const o = await heldOrder([line(p, 10)]);
  const [pr] = await lineRequests(o.id);
  const poLine = await toPo(pr.id);
  await receiveOnPo(poLine.id, 6);
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  assert.deepEqual((await lineRequests(o.id)).map((r) => r.status), ["ordered"], "4 still to come on the open PO: no top-up");

  await closePurchaseOrder(poLine.poId, { reason: `${TAG} اكتفينا` }, buyer as never);
  const rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => [r.status, r.quantity.toFixed(), r.purchaseOrderId === poLine.poId]), [["ordered", "10", true], ["pending_approval", "4", false]], "the bought request keeps its PO; a new suggestion for the 4 the PO will not bring");
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: pr.id, action: "purchase_request_po_closed" } }));
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: rows[1].id, status: "pending" } }), 1, "it waits for approval like any suggestion");
  assert.equal(rows[1].requestedById, ids.mona, "raised for whoever saved the order, so the buyer who closed the PO can approve it");
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: rows[1].id, action: "purchase_request_created", userId: ids.omar } }), "the audit names who caused it");
  await stillHeld(o.id);

  // Retried: nothing changes.
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  assert.equal((await lineRequests(o.id)).length, 2);
  await rejects(closePurchaseOrder(poLine.poId, { reason: TAG }, buyer as never), 409);
  assert.equal((await lineRequests(o.id)).length, 2);

  // The rest arrives from elsewhere: release reserves it; the PO request is served, the open one closed.
  await receive(p, 4);
  await releaseHeldOrder(o.id, sup as never);
  assert.deepEqual((await lineRequests(o.id)).map((r) => r.status), ["fulfilled", "cancelled"]);
});

test("PO cancelled: the request returns to approved, sized to the line's current shortage", async () => {
  const p = await product("فلفل");
  await receive(p, 3);
  const o = await heldOrder([line(p, 10)]);
  const [pr] = await lineRequests(o.id);
  assert.equal(pr.quantity.toFixed(), "7");
  const poLine = await toPo(pr.id);
  // Meanwhile 2 more arrived from another delivery: the line now lacks 5, not 7.
  await receive(p, 2);
  await cancelPurchaseOrder(poLine.poId, { reason: `${TAG} اتلغى` }, buyer as never);
  const back = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.deepEqual([back.status, back.quantity.toFixed(), back.purchaseOrderId], ["approved", "5", null], "released and re-sized; a smaller buy keeps its approval");
  assert.equal((await openFor(pr.orderItemId!)).length, 1);
  await stillHeld(o.id);
});

test("several POs on one line: only what live POs still owe counts; closing one and cancelling another re-size one suggestion", async () => {
  const p = await product("بطاطس");
  const o = await heldOrder([line(p, 10)]);
  const item = o.items[0];
  const [pr1] = await lineRequests(o.id);
  const po1 = await toPo(pr1.id);
  // The customer wants 15: 5 more is raised and bought on a second PO.
  const cur = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
  await editRequiredQuantity(o.id, item.id, 15, sup as never, TAG, cur.version);
  const pr2 = (await openFor(item.id))[0];
  assert.equal(pr2.quantity.toFixed(), "5");
  const po2 = await toPo(pr2.id);
  await inTx((tx) => syncOrderSuggestions(tx, o.id, sales));
  assert.equal((await openFor(item.id)).length, 0, "10 + 5 on order covers 15");

  // PO1 delivers 6 and is closed: 15 − 6 in stock − 5 still owed by PO2 = 4.
  await receiveOnPo(po1.id, 6);
  await closePurchaseOrder(po1.poId, { reason: TAG }, buyer as never);
  let open = await openFor(item.id);
  assert.deepEqual(open.map((r) => r.quantity.toFixed()), ["4"]);
  // PO2 is cancelled: its request cannot reopen beside the open one, so it is cancelled and the
  // open suggestion grows to the whole 9 — back to approval if it had been approved.
  await approve(open[0].id);
  await cancelPurchaseOrder(po2.poId, { reason: TAG }, buyer as never);
  assert.equal((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr2.id } })).status, "cancelled");
  open = await openFor(item.id);
  assert.deepEqual(open.map((r) => [r.status, r.quantity.toFixed()]), [["pending_approval", "9"]]);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: open[0].id, status: "pending" } }), 1);
  await stillHeld(o.id);
});

async function decideLoss(entityId: string, decision: "approve" | "reject") {
  const a = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "inventory.grading_loss", entityId, status: "pending" } });
  await decideApproval(a.id, decision, sup as never, { comment: TAG });
}

test("graded at receipt: what is held for the loss approval still counts, only the Grade B and waste part is raised again", async () => {
  const p = await product("فراولة");
  const b = (await prisma.stockProduct.create({ data: { name: `${TAG} فراولة فرزة`, nameAr: `${TAG} فراولة فرزة`, unit: "KG" } })).id;
  const o = await heldOrder([line(p, 10)]);
  const [pr] = await lineRequests(o.id);
  const poLine = await toPo(pr.id);
  // 10 accepted (the PO is fully received): 2 Grade B on its own SKU and 1 waste; the 7 good wait
  // in quarantine for the grading-loss approval (on by default, any loss).
  const { intake } = await receiveOnPo(poLine.id, 10, { grade_b_qty: 2, waste_qty: 1, grade_b_product_id: b });
  assert.equal((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poLine.poId } })).status, "received");
  assert.equal((await prisma.stockMovement.aggregate({ where: { intakeId: intake.id, productId: p, location: { type: "quarantine" } }, _sum: { quantity: true } }))._sum.quantity?.toFixed(), "7", "held for the approval");
  assert.deepEqual((await openFor(pr.orderItemId!)).map((r) => r.quantity.toFixed()), ["3"], "raised by the receipt itself; the held 7 is not bought again");
  // The loss is approved: the 7 become sellable — the suggestion stays as it is, still one.
  await decideLoss(intake.id, "approve");
  assert.deepEqual((await openFor(pr.orderItemId!)).map((r) => r.quantity.toFixed()), ["3"]);
  await stillHeld(o.id);

  // Graded after receipt: the second PO's delivery comes in raw, then 1 of its 3 is waste.
  const second = await toPo((await openFor(pr.orderItemId!))[0].id);
  const { intake: raw } = await receiveOnPo(second.id, 3);
  assert.equal((await openFor(pr.orderItemId!)).length, 0, "10 sellable: covered");
  const sorted = await createSorting({ intake_id: raw.id, input_kg: "3", good_kg: "2", grade_b_kg: "0", waste_kg: "1", reason: TAG }, stock as never);
  assert.deepEqual((await openFor(pr.orderItemId!)).map((r) => r.quantity.toFixed()), ["1"], "the waste is raised again; the 2 held good are not");
  await decideLoss(sorted.document.id, "approve");
  assert.deepEqual((await openFor(pr.orderItemId!)).map((r) => r.quantity.toFixed()), ["1"]);
  assert.equal(await prisma.purchaseRequest.count({ where: { orderItemId: pr.orderItemId, status: { in: ["pending_approval", "approved"] } } }), 1);
  await stillHeld(o.id);
});

test("a held receipt voided after its loss was rejected: the PO owes it again; closing the PO raises it again", async () => {
  const p = await product("مانجو");
  const o = await heldOrder([line(p, 10)]);
  const [pr] = await lineRequests(o.id);
  const poLine = await toPo(pr.id);
  const { intake } = await receiveOnPo(poLine.id, 10, { waste_qty: 4 });
  assert.deepEqual((await openFor(pr.orderItemId!)).map((r) => r.quantity.toFixed()), ["4"], "6 held in quarantine still count; the 4 waste do not");
  await decideLoss(intake.id, "reject");
  const cur = await prisma.stockIntake.findUniqueOrThrow({ where: { id: intake.id } });
  await voidIntake(intake.id, stock as never, TAG, cur.version);
  assert.notEqual((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poLine.poId } })).status, "received");
  assert.equal((await openFor(pr.orderItemId!)).length, 0, "the receipt is undone: the live PO owes all 10 again");
  await closePurchaseOrder(poLine.poId, { reason: `${TAG} المورد اعتذر` }, buyer as never);
  const open = await openFor(pr.orderItemId!);
  assert.deepEqual(open.map((r) => [r.id, r.status, r.quantity.toFixed()]), [[pr.id, "approved", "10"]], "nothing accepted any more: the request itself comes back, once");
  await stillHeld(o.id);
});

test("a receipt voided after its PO was closed: the request it no longer has anything on is released, not stuck", async () => {
  const p = await product("بصل");
  const o = await heldOrder([line(p, 10)]);
  const [pr] = await lineRequests(o.id);
  const poLine = await toPo(pr.id);
  const { intake } = await receiveOnPo(poLine.id, 6);
  await closePurchaseOrder(poLine.poId, { reason: TAG }, buyer as never);
  assert.deepEqual((await lineRequests(o.id)).map((r) => [r.status, r.quantity.toFixed()]), [["ordered", "10"], ["pending_approval", "4"]]);
  const cur = await prisma.stockIntake.findUniqueOrThrow({ where: { id: intake.id } });
  await voidIntake(intake.id, stock as never, TAG, cur.version);
  const rows = await lineRequests(o.id);
  assert.deepEqual(rows.map((r) => [r.status, r.quantity.toFixed()]), [["cancelled", "10"], ["pending_approval", "10"]], "nothing accepted on the closed PO any more: released (the line already has an open request), and that one now asks for all 10");
  assert.equal(rows[0].purchaseOrderId, null);
  await stillHeld(o.id);
});

test("two POs of one line closed at the same time: both go through, one open suggestion", async () => {
  const p = await product("ثوم");
  const o = await heldOrder([line(p, 10)]);
  const item = o.items[0];
  const [pr1] = await lineRequests(o.id);
  const po1 = await toPo(pr1.id);
  const cur = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
  await editRequiredQuantity(o.id, item.id, 15, sup as never, TAG, cur.version);
  const po2 = await toPo((await openFor(item.id))[0].id);
  const results = await Promise.allSettled([po1, po2].map((l) => closePurchaseOrder(l.poId, { reason: TAG }, buyer as never)));
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
  const open = await openFor(item.id);
  assert.deepEqual(open.map((r) => r.quantity.toFixed()), ["15"], "one request comes back for the whole 15; the other is cancelled");
  await stillHeld(o.id);
});

test("retries and races never duplicate a suggestion", async () => {
  const p = await product("كوسة");
  const o = await heldOrder([line(p, 8)]);
  const [pr] = await lineRequests(o.id);
  const poLine = await toPo(pr.id);
  await receiveOnPo(poLine.id, 2);
  // Two closes at once: one goes through, the other is refused; one suggestion for the 6.
  const results = await Promise.allSettled([1, 2].map(() => closePurchaseOrder(poLine.poId, { reason: TAG }, buyer as never)));
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  // Concurrent re-syncs (a retried save beside a receipt): still one.
  await Promise.all([1, 2, 3].map(() => inTx((tx) => syncOrderSuggestions(tx, o.id, sales))));
  const open = await openFor(pr.orderItemId!);
  assert.deepEqual(open.map((r) => r.quantity.toFixed()), ["6"]);
  assert.equal(await prisma.approvalRequest.count({ where: { type: "purchasing.request", entityId: open[0].id, status: "pending" } }), 1, "one approval request, not one per retry");
  // The database still refuses a second open request on the line, whatever the path.
  await assert.rejects(
    prisma.purchaseRequest.create({ data: { number: `${TAG}-DUP`, productId: p, uomCode: "KG", quantity: 1, orderId: o.id, orderItemId: pr.orderItemId, requestedBy: "test" } }),
    (err: unknown) => (err as { code?: string }).code === "P2002"
  );
  await stillHeld(o.id);
});
