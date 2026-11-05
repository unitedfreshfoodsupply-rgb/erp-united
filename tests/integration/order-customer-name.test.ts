/* An order names its customer through the customer card (Nov 2026). While the order is open,
   every operational view — the picking sheet, trip planning, exception queues, the delayed-orders
   report, printed documents — shows the card as it is now, in the reader's language. A dispatched
   order's documents are history: they keep the name frozen on the order when it left. A rename
   writes nothing to any order. Also: the integrity check that every party id in the ledger and the
   opening balances points to a record. Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { createCustomer, updateCustomer } from "@/lib/sales/customers";
import { dailyConsolidatedSheet } from "@/lib/picking-sheet";
import { plannableOrders } from "@/lib/operations/trips";
import { listIssueExceptions } from "@/lib/inventory/dispatch";
import { listExceptions } from "@/lib/operations/exceptions";
import { reportParams, runReport } from "@/lib/reports/engine";
import { orderCustomerName, orderDocumentCustomerName } from "@/lib/locale/names";
import { danglingPartyReferences, integrityReport } from "@/lib/accounting/integrity";

const TAG = `ZZOCN${Date.now()}`;
const day = `2099-11-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const sales = actor("مدير مبيعات", ["sales.customers.view", "sales.customers.manage"], "ocn-sales");
const all = { can: () => true };

after(async () => { await prisma.$disconnect(); });

test("open orders show the customer card as it is now; a dispatched order's documents keep the name it left with", async () => {
  const c = await createCustomer({ name: `${TAG} Nile Hotel`, name_ar: `${TAG} فندق النيل` }, sales);
  const open = await prisma.order.create({ data: { orderNumber: `${TAG}-1`, customerName: `${TAG} فندق النيل`, customerAccountId: c.id, deliveryDate: day, status: "preparing", items: { create: [{ productName: `${TAG} طماطم`, requiredQuantity: 10 }] } }, include: { items: true } });
  const left = await prisma.order.create({ data: { orderNumber: `${TAG}-2`, customerName: `${TAG} فندق النيل`, customerAccountId: c.id, deliveryDate: day, status: "dispatched", items: { create: [{ productName: `${TAG} طماطم`, requiredQuantity: 4 }] } } });
  const unmapped = await prisma.order.create({ data: { orderNumber: `${TAG}-3`, customerName: `${TAG} مطعم من الواتساب`, deliveryDate: day, status: "new", items: { create: [{ productName: `${TAG} طماطم`, requiredQuantity: 2 }] } } });
  await prisma.stockIssueException.create({ data: { orderId: open.id, orderItemId: open.items[0].id, productName: `${TAG} طماطم`, unit: "KG", requestedQty: 10, issuedQty: 0, reason: "unmapped" } });
  await prisma.operationalException.create({ data: { type: "delivery_failure", sourceType: "order", sourceId: open.id, orderId: open.id, description: `${TAG} اختبار`, createdBy: "test" } });

  const cur = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  await updateCustomer(c.id, { name: `${TAG} Grand Nile Hotel`, name_ar: `${TAG} فندق النيل الكبير`, expected_version: cur.version }, sales);
  const nowAr = `${TAG} فندق النيل الكبير`;
  const nowEn = `${TAG} Grand Nile Hotel`;

  // Picking sheet: the open orders, under the current card (Arabic-first, both names for the reader).
  const sheet = await dailyConsolidatedSheet(day);
  const allocs = sheet.lines.flatMap((l) => l.allocations);
  const a = allocs.find((x) => x.orderId === open.id)!;
  assert.equal(a.customerName, nowAr);
  assert.equal(orderCustomerName(a, "en"), nowEn);
  assert.equal(allocs.find((x) => x.orderId === unmapped.id)?.customerName, `${TAG} مطعم من الواتساب`, "an unmapped order shows the name as received");

  // Trip planning, the stock-issue and operational exception queues.
  const plan = (await plannableOrders(day)).find((o) => o.id === open.id)!;
  assert.deepEqual([orderCustomerName(plan, "ar"), orderCustomerName(plan, "en")], [nowAr, nowEn]);
  const issue = (await listIssueExceptions({ orderId: open.id }))[0];
  assert.equal(orderCustomerName(issue.order, "en"), nowEn);
  const ops = (await listExceptions({ orderId: open.id }))[0];
  assert.equal(orderCustomerName(ops.order!, "ar"), nowAr);

  // The delayed-orders report: the current card in both languages; the unmapped text as received.
  const past = await prisma.order.create({ data: { orderNumber: `${TAG}-4`, customerName: `${TAG} فندق النيل`, customerAccountId: c.id, deliveryDate: "2001-01-02", status: "new" } });
  const rep = await runReport("delayed-orders", reportParams(new URLSearchParams({ from: "2001-01-01", to: "2001-01-03" })), all);
  const row = rep.rows.find((r: any) => r.number === past.orderNumber) as any;
  assert.deepEqual([row?.customer_ar, row?.customer_en], [nowAr, nowEn]);
  assert.ok(rep.columns.some((col: any) => col.key === "customer_ar") && rep.columns.some((col: any) => col.key === "customer_en"));

  // Documents: an open order prints the card as it is now; a dispatched one prints the name it left with.
  assert.equal(orderDocumentCustomerName({ ...open, customerAccount: { name: nowEn, nameAr: nowAr } }, "ar"), nowAr);
  assert.equal(orderDocumentCustomerName({ ...open, customerAccount: { name: nowEn, nameAr: nowAr } }, "en"), nowEn);
  assert.equal(orderDocumentCustomerName({ ...left, customerAccount: { name: nowEn, nameAr: nowAr } }, "en"), `${TAG} فندق النيل`);

  // The rename wrote nothing to any order (the stored name is history, or the intake text).
  const rows = await prisma.order.findMany({ where: { id: { in: [open.id, left.id, unmapped.id] } }, select: { id: true, customerName: true, version: true } });
  for (const o of rows) assert.equal(o.version, 1, o.id);
  assert.deepEqual(rows.map((o) => o.customerName).sort(), [`${TAG} فندق النيل`, `${TAG} فندق النيل`, `${TAG} مطعم من الواتساب`].sort());
});

test("integrity: every party id in the ledger and the opening balances points to a record", async () => {
  const report = await integrityReport();
  const check = report.checks.find((c) => c.key === "party_references");
  assert.ok(check, "the check is part of the integrity report");
  assert.deepEqual([check!.ok, check!.count], [true, 0], JSON.stringify(check!.detail));

  // A dangling id is found (inside a transaction that is rolled back: nothing stays behind).
  const rollback = new Error("rollback");
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.partyOpeningBalance.create({ data: { partyType: "supplier", partyId: `${TAG}-missing`, date: "2026-10-31", amount: 1, dueDate: "2026-10-31", createdBy: "integration-test" } });
    const found = await danglingPartyReferences(tx);
    assert.deepEqual(found.filter((r) => r.partyId.startsWith(TAG)).map((r) => [r.source, r.partyType, r.count]), [["opening_balance", "supplier", 1]]);
    throw rollback;
  }), (e) => e === rollback);
  // An unknown party type never gets that far: the database refuses it.
  await assert.rejects(prisma.partyOpeningBalance.create({ data: { partyType: "vendor", partyId: `${TAG}-x`, date: "2026-10-31", amount: 1, dueDate: "2026-10-31", createdBy: "integration-test" } }), /PartyOpeningBalance_values/);
  assert.equal(await prisma.partyOpeningBalance.count({ where: { partyId: { startsWith: TAG } } }), 0);
});
