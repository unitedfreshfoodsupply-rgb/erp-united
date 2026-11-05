/* Cancel, reopen and the purchase requests of a short line (LOG-4, LOG-10, Nov 2026).
   - Cancelling an order withdraws every request still waiting on it (credit, quantity variance,
     prices); a request left from before cannot be approved on a cancelled order, only rejected.
   - Reopen refuses a new order, and a cancelled order whose prices or credit (block mode) were
     not cleared — a copy goes through both again.
   - A short line with a purchase request raised by hand for the same customer and delivery day
     cannot also be saved awaiting stock (it would raise a second one); the same hand request twice
     (a double tap) is refused.
   Synthetic data on the test database. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, inTx, actor, withSetting } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { recordIntake } from "@/lib/stock-service";
import { cancelOrder, createOrder, moveOrderStatus, reopenOrder, setPreparedQuantity } from "@/lib/orders-service";
import { createPurchaseRequest } from "@/lib/purchasing/requests";
import { requestApproval } from "@/lib/core/approvals";
import { decideApproval } from "@/lib/core/approval-handlers";
import { ApiError } from "@/lib/rbac";

const TAG = `ZZGATE${Date.now()}`;
const day = `2097-05-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, [...ROLE_PERMISSIONS[role]], ids[username], role), source: "manual" as const });
let sales: ReturnType<typeof as>, sup: ReturnType<typeof as>, stock: ReturnType<typeof as>, admin: ReturnType<typeof as>;
let supplierId = "";
let customerId = "";

async function product(label: string, kg = 100) {
  const id = (await prisma.stockProduct.create({ data: { name: `${TAG} ${label}`, nameAr: `${TAG} ${label}`, unit: "KG" } })).id;
  if (kg) await recordIntake({ supplier_id: supplierId, product_id: id, received_kg: kg, unit_cost: "5", location_id: "loc_cold_1" } as never, stock as never);
  return id;
}
const line = (productId: string, quantity: number, price?: string) => ({ stock_product_id: productId, product_name: "", quantity, unit: "KG", ...(price ? { unit_price: price, price_reason: TAG } : {}) });
const order = (items: ReturnType<typeof line>[], extra: Record<string, unknown> = {}, customer = customerId) =>
  createOrder({ customer_account_id: customer, customer_name: "", delivery_date: day, items, ...extra } as never, sales as never);
const pending = (type: string, entityId: string) => prisma.approvalRequest.count({ where: { type, entityId, status: "pending" } });
async function rejects(p: Promise<unknown>, status: number, code?: string, message?: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ApiError, String(err));
    assert.equal(err.status, status, err.message);
    if (code) assert.equal(err.code, code, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
}

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  stock = as("hossam", "STOCK_CONTROLLER", "حسام مخازن");
  admin = as("admin", "SUPER_ADMIN", "أدمن");
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-5${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "vegetable" } })).id;
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
});
after(async () => {
  await prisma.$disconnect();
});

test("LOG-10: cancelling withdraws the order's price-exception and shortage requests, not only its credit", async () => {
  const a = await product("طماطم");
  const priced = await order([line(a, 5, "1")]); // below the stock cost of 5
  assert.equal(priced.pricingStatus, "pending_approval");
  assert.equal(await pending("sales.price_exception", priced.id), 1);
  await cancelOrder(priced.id, sup as never, TAG);
  assert.equal(await pending("sales.price_exception", priced.id), 0);
  const closed = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "sales.price_exception", entityId: priced.id } });
  assert.equal(closed.status, "cancelled");
  assert.match(closed.closedReason ?? "", /الأوردر اتلغى/);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: "approval_cancelled", entityId: closed.id } }));

  const short = await order([line(a, 10)]);
  await moveOrderStatus(short.id, "preparing", sup as never);
  await setPreparedQuantity(short.id, short.items[0].id, 2, sup as never);
  assert.equal(await pending("orders.shortage", short.id), 1);
  await cancelOrder(short.id, sup as never, TAG);
  assert.equal(await pending("orders.shortage", short.id), 0);
});

test("LOG-10: a request left on a cancelled order cannot be approved — it can be rejected, which leaves the order alone", async () => {
  const a = await product("خيار");
  const o = await order([line(a, 3)]);
  await cancelOrder(o.id, sup as never, TAG);
  // As requests raised before cancel withdrew them.
  const { request: pe } = await inTx((tx) => requestApproval(tx, { type: "sales.price_exception", entityId: o.id, title: TAG, requester: { id: sales.id, name: sales.name, role: "SALES" } }));
  const { request: sh } = await inTx((tx) => requestApproval(tx, { type: "orders.shortage", entityId: o.id, title: TAG, requester: { id: null, name: "النظام", role: "SYSTEM" } }));
  await prisma.order.update({ where: { id: o.id }, data: { needsReview: true } });
  await rejects(decideApproval(pe.id, "approve", admin as never, { comment: TAG }), 409, undefined, /الأوردر ملغي/);
  await rejects(decideApproval(sh.id, "approve", admin as never, { comment: TAG }), 409, undefined, /الأوردر ملغي/);
  const before = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  await decideApproval(pe.id, "reject", admin as never, { comment: TAG });
  await decideApproval(sh.id, "reject", admin as never, { comment: TAG });
  const afterward = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([afterward.pricingStatus, afterward.version], [before.pricingStatus, before.version], "the cancelled order is not touched");
  assert.equal(await pending("sales.price_exception", o.id) + (await pending("orders.shortage", o.id)), 0, "both left the inbox");
});

test("LOG-10: reopen refuses a new order, and a cancelled order whose prices were not cleared; a clean cancelled order reopens", async () => {
  const a = await product("فلفل");
  const fresh = await order([line(a, 2)]);
  await rejects(reopenOrder(fresh.id, "preparing", sup as never, TAG), 409, undefined, /لسه جديد/);

  const priced = await order([line(a, 2, "1")]);
  await cancelOrder(priced.id, sup as never, TAG);
  await rejects(reopenOrder(priced.id, "preparing", sup as never, TAG), 409, "reopen_needs_clone", /اعمل نسخة من الأوردر/);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: priced.id } })).status, "cancelled");

  const clean = await order([line(a, 2)]);
  await cancelOrder(clean.id, sup as never, TAG);
  const back = await reopenOrder(clean.id, "preparing", sup as never, TAG);
  assert.equal(back.status, "preparing");
  assert.equal(await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: clean.id, status: "active" } }), 1);
});

test("LOG-10: in credit block mode, a cancelled order whose credit was waiting cannot be reopened", async () => {
  const restore = await withSetting("sales.credit_check_mode", "block");
  try {
    const a = await product("بطاطس");
    const tight = (await createCustomer({ name: `${TAG} Tight`, name_ar: `${TAG} محدود`, payment_terms_days: 30, credit_limit: "1", credit_reason: TAG }, admin as never)).id;
    const o = await order([line(a, 2, "10")], {}, tight);
    assert.equal(o.creditStatus, "pending_approval");
    await cancelOrder(o.id, sup as never, TAG);
    assert.equal(await pending("sales.credit", o.id), 0);
    await rejects(reopenOrder(o.id, "preparing", sup as never, TAG), 409, "reopen_needs_clone", /ائتمان/);
  } finally {
    await restore();
  }
});

test("LOG-4: a short line already covered by a hand-raised purchase request is not also saved awaiting stock", async () => {
  const a = await product("مانجو", 20);
  const b = await product("جوافة", 1);
  const pr = await createPurchaseRequest({ product_id: a, quantity: 80, customer_id: customerId, needed_by: day }, sales as never);
  const count = () => prisma.order.count({ where: { customerAccountId: customerId } });
  const n = await count();
  await rejects(order([line(a, 100)], { allow_shortage: true }), 409, "purchase_request_exists", new RegExp(pr.number));
  assert.equal(await count(), n, "nothing saved");
  assert.equal(await prisma.purchaseRequest.count({ where: { productId: a } }), 1, "no second request");
  // Another product's shortage, or another delivery day, is held as before.
  const held = await order([line(b, 5)], { allow_shortage: true });
  assert.equal(held.stockStatus, "awaiting_stock");
  const otherDay = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day.replace(/-(\d\d)$/, (_, d) => `-${String((Number(d) % 28) + 1).padStart(2, "0")}`), items: [line(a, 100)], allow_shortage: true } as never, sales as never);
  assert.equal(otherDay.stockStatus, "awaiting_stock");
  // Within what is available, the order is saved normally.
  assert.equal((await order([line(a, 20)])).stockStatus, "ok");
});

test("LOG-4: the same hand-raised request twice (a double tap) is refused while the first waits for approval", async () => {
  const a = await product("رمان", 0);
  const input = { product_id: a, quantity: 12.5, customer_id: customerId, needed_by: day, customer_reference: `${TAG}-PO` };
  const results = await Promise.allSettled([createPurchaseRequest(input, sales as never), createPurchaseRequest(input, sales as never)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "one of two simultaneous taps");
  const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(refused.reason instanceof ApiError && refused.reason.status === 409 && refused.reason.code === "purchase_request_exists", String(refused.reason));
  assert.equal(await prisma.purchaseRequest.count({ where: { productId: a } }), 1);
  // A different quantity is a different request.
  await createPurchaseRequest({ ...input, quantity: 3 }, sales as never);
  assert.equal(await prisma.purchaseRequest.count({ where: { productId: a } }), 2);
});
