/* M-3 (Nov 2026): credit is judged at the order's gates — creation, leaving "new", an edit —
   always on the customer's CURRENT terms, limit, hold and exposure. Changing a customer's credit
   terms re-evaluates nothing by itself: no order status changes, no approval request, no
   notification. The next gate applies the new terms. Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor, inTx } from "./_db";
import { createCustomer, updateCustomerCredit } from "@/lib/sales/customers";
import { evaluateOrderCredit } from "@/lib/sales/credit";

const TAG = `ZZCRD${Date.now()}`;
const finance = actor("مالية", ["sales.customers.view", "sales.customers.manage", "sales.credit.manage"], "crd-finance");
const gate = { id: null, name: "اختبار", role: "SUPERVISOR" };

after(async () => { await prisma.$disconnect(); });

async function pricedOrder(customerId: string, n: number, value: number) {
  return prisma.order.create({
    data: {
      orderNumber: `${TAG}-${n}`, customerName: `${TAG} عميل`, customerAccountId: customerId, deliveryDate: "2099-11-20", status: "new",
      items: { create: [{ productName: `${TAG} طماطم`, requiredQuantity: 10, price: { create: { unitPrice: value / 10, taxCode: "EXEMPT", taxRate: 0, source: "manual", reason: "اختبار", setBy: "test" } } }] },
    },
  });
}
const counts = async (orderId: string) => ({
  approvals: await prisma.approvalRequest.count({ where: { entityId: orderId } }),
  notifications: await prisma.notification.count({ where: { entityId: orderId } }),
  status: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).creditStatus,
});

test("a credit-terms change re-evaluates nothing by itself; the next gate judges on the current limit and exposure", async () => {
  const c = await createCustomer({ name: `${TAG} مطعم آجل`, payment_terms_days: 30, credit_limit: "5000", credit_reason: "عميل جديد" }, finance);
  const o = await pricedOrder(c.id, 1, 2000);
  // Gate 1 (block mode): 2,000 of 5,000 — within the limit.
  assert.equal(await inTx((tx) => evaluateOrderCredit(tx, o.id, "block", gate)), "ok");
  const before = await counts(o.id);
  assert.deepEqual(before, { approvals: 0, notifications: 0, status: "ok" });

  // Finance lowers the limit below the exposure: nothing happens to the order on its own.
  const cur = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  await updateCustomerCredit(c.id, { credit_limit: "1500", reason: "مراجعة الحد", expected_version: cur.version }, finance);
  assert.deepEqual(await counts(o.id), before, "no automatic re-evaluation, approval or notification on a terms change");

  // The next gate applies the current limit: 2,000 > 1,500 → held for finance's approval.
  assert.equal(await inTx((tx) => evaluateOrderCredit(tx, o.id, "block", gate)), "pending_approval");
  const req = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "sales.credit", entityId: o.id, status: "pending" } });
  assert.ok(req.summary?.includes("1500.00") && req.summary.includes("2000.00"), `judged on the current limit and exposure: ${req.summary}`);

  // Raising the limit again changes nothing until the next gate, which then clears the hold
  // and withdraws the request — never an automatic approval.
  const cur2 = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  await updateCustomerCredit(c.id, { credit_limit: "10000", reason: "رفع الحد", expected_version: cur2.version }, finance);
  assert.equal((await counts(o.id)).status, "pending_approval");
  assert.equal(await inTx((tx) => evaluateOrderCredit(tx, o.id, "block", gate)), "ok");
  const closed = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
  assert.equal(closed.status, "cancelled", "the request is withdrawn, not approved");
});

test("the exposure at the gate counts the customer's other open orders as they are now", async () => {
  const c = await createCustomer({ name: `${TAG} فندق آجل`, payment_terms_days: 15, credit_limit: "3000", credit_reason: "عميل جديد" }, finance);
  const first = await pricedOrder(c.id, 2, 2000);
  assert.equal(await inTx((tx) => evaluateOrderCredit(tx, first.id, "block", gate)), "ok");
  const second = await pricedOrder(c.id, 3, 1500);
  // 2,000 + 1,500 = 3,500 > 3,000.
  assert.equal(await inTx((tx) => evaluateOrderCredit(tx, second.id, "block", gate)), "pending_approval");
  // Warn mode never holds: it notifies finance once (deduplicated), with no approval request.
  const third = await pricedOrder(c.id, 4, 100);
  assert.equal(await inTx((tx) => evaluateOrderCredit(tx, third.id, "warn", gate)), "warning");
  assert.equal(await inTx((tx) => evaluateOrderCredit(tx, third.id, "warn", gate)), "warning");
  assert.deepEqual([(await counts(third.id)).approvals, await prisma.notification.count({ where: { entityId: third.id, type: "sales.credit_warning" } }) > 0], [0, true]);
});
