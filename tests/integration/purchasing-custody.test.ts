/* Purchasing custody (عهدة شراء) against PostgreSQL — requirement 7.
 *
 * Two synthetic buyers (never real records): "سامح" buys vegetables, "يوسف" buys fruit. The
 * company issues them custody from a cash box / bank (Dr 1600 employee / Cr cash-bank, only after a
 * second person approves), they pay suppliers from it through the existing supplier payment request
 * (Dr AP supplier / Cr 1600 employee, only after approval), and return what is left (Dr cash-bank /
 * Cr 1600). The purchase itself is recognised once, by the existing PO → receipt (GRNI) → bill path.
 *
 *  - 7.4 chain: advance 1000 → PO/receipt/bill 800 → custody payment 800 → return 200
 *  - Scenario 7: both buyers, cash and bank, two suppliers each side, statements reconcile
 *  - Scenario 8: retried submissions never record twice
 *  - Scenario 9: permissions, self-approval, category mismatch and override, custody kept apart
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor, withSetting } from "./_db";
import { decideApproval } from "@/lib/core/approval-handlers";
import { createEmployeeTransaction, createExpense, employeeStatement, saveEmployee } from "@/lib/hr/service";
import { createAdvancePlan } from "@/lib/hr/advance-plans";
import { custodyBalance, custodyStatement, listCustody, missingCustodyReceipts, salaryAdvanceBalance } from "@/lib/hr/custody";
import { createPayment, reversePayment } from "@/lib/accounting/cash";
import { createCashAccount } from "@/lib/accounting/treasury";
import { postJournal } from "@/lib/accounting/ledger";
import { integrityReport } from "@/lib/accounting/integrity";
import { createPurchaseOrder, sendPurchaseOrder, submitPurchaseOrder } from "@/lib/purchasing/orders";
import { createBill, postBill } from "@/lib/purchasing/bills";
import { createIntake } from "@/lib/stock-service";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZCUS${Date.now()}`;
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const status = (s: number, code?: string) => (e: any) => e?.status === s && (!code || e?.code === code);
const today = todayLocalISO();

// Real users of the test database (approval requests and notifications carry their ids).
let hr = actor("موارد بشرية", ["hr.advances.manage", "hr.employees.manage", "hr.expenses.submit", "hr.expenses.approve"], null, "ACCOUNTANT");
let finance = actor("المدير المالي", ["accounting.manage", "accounting.view", "accounting.payments.manage", "hr.advances.manage"], null, "ACCOUNTANT");
let clerk = actor("محاسب السداد", ["accounting.payments.manage"], null, "ACCOUNTANT");
let senior = actor("رئيس الحسابات", ["accounting.payments.manage", "accounting.manage"], null, "ACCOUNTANT");
const buyer = actor("مشتريات", ["purchasing.orders.manage", "purchasing.prices.manage"], "cus-buyer");
const store = actor("أمين مخزن", ["stock.receive", "stock.sort", "stock.view", "stock.valuation.view"], "cus-store");
const billing = actor("فواتير الموردين", ["purchasing.bills.manage", "purchasing.bills.view"], "cus-bills");

let samah = "", youssef = "", nobody = "";
let vegA = "", vegB = "", fruitA = "";
let okra = "", mango = "";
let cash = { id: "", accountId: "" }, bank = { id: "", accountId: "" };
let restoreThreshold: (() => Promise<void>) | null = null;

const glBalance = async (accountId: string) => {
  const s = await prisma.journalLine.aggregate({ where: { accountId }, _sum: { debit: true, credit: true } });
  return D(s._sum.debit).minus(D(s._sum.credit));
};
const keyBalance = async (systemKey: string, partyType?: string, partyId?: string) => {
  const s = await prisma.journalLine.aggregate({ where: { account: { systemKey }, ...(partyType ? { partyType, partyId } : {}) }, _sum: { debit: true, credit: true } });
  return D(s._sum.debit).minus(D(s._sum.credit));
};
const advances = (employeeId: string) => keyBalance("employee_advances", "employee", employeeId);
/** AP is a credit balance: what we owe the supplier, positive. */
const owed = async (supplierId: string) => (await keyBalance("ap", "supplier", supplierId)).negated();
const pendingRequest = (entityId: string) => prisma.approvalRequest.findFirstOrThrow({ where: { entityId, status: "pending" } });
const approve = async (entityId: string, who = finance) => { const r = await pendingRequest(entityId); return decideApproval(r.id, "approve", who as never, { expectedVersion: r.version }); };
const reject = async (entityId: string, who = finance) => { const r = await pendingRequest(entityId); return decideApproval(r.id, "reject", who as never, { comment: "مش مطلوب", expectedVersion: r.version }); };
const key = (s: string) => `${TAG}-${s}`;

async function fund(c: { accountId: string }, amount: number) {
  const capital = await prisma.account.findUniqueOrThrow({ where: { systemKey: "capital" } });
  await inTx((tx) => postJournal(tx, { date: today, description: `${TAG} تمويل`, sourceType: "manual", sourceId: `${TAG}-fund-${c.accountId}`, lines: [{ accountId: c.accountId, amount: D(amount) }, { accountId: capital.id, amount: D(-amount) }] }, finance));
}

/** Issues custody (a request) and has finance approve it; returns the posted EmployeeTransaction id. */
async function issue(employeeId: string, amount: number, from: { id: string }, ref: string) {
  const r: any = await createEmployeeTransaction({ employee_id: employeeId, type: "advance", purpose: "purchasing_custody", amount, cash_account_id: from.id, date: today, reference: ref, idempotency_key: key(`adv-${ref}`) }, hr);
  assert.equal(r.document.status, "pending_approval");
  await approve(r.custodyRequest.id);
  const req = await prisma.employeeCustodyRequest.findUniqueOrThrow({ where: { id: r.custodyRequest.id } });
  assert.equal(req.status, "posted");
  return req.transactionId!;
}

/** The existing purchase path, unchanged: PO → receipt (Dr inventory / Cr GRNI) → posted bill (Dr GRNI / Cr AP). */
async function purchase(supplierId: string, productId: string, kg: number, price: string, invoiceNo: string) {
  const po = await createPurchaseOrder({ supplier_id: supplierId, lines: [{ product_id: productId, quantity: kg, unit_price: price }] }, buyer);
  await submitPurchaseOrder(po.id, buyer);
  await sendPurchaseOrder(po.id, buyer);
  const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { poId: po.id } });
  const intake = await createIntake({ purchase_order_line_id: line.id, received_kg: kg } as never, store);
  const bill = await createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-${invoiceNo}`, bill_date: today, lines: [{ intake_id: intake.id, unit_price: price }] }, billing);
  const posted = await postBill(bill.id, billing);
  assert.equal(posted.status, "posted");
  return posted;
}

/** A custody payment request by the clerk, approved by finance; returns the posted payment. */
async function payFromCustody(employeeId: string, supplierId: string, amount: number, billId: string, k: string, by = clerk, extra: Record<string, unknown> = {}) {
  const r: any = await createPayment({ party_id: supplierId, custody_employee_id: employeeId, amount, method: "cash", allocations: [{ document_id: billId, amount }], idempotency_key: key(k), ...extra }, by);
  assert.equal(r.document.status, "pending_approval", "a custody payment always waits for approval");
  await approve(r.paymentRequest.id);
  const req = await prisma.supplierPaymentRequest.findUniqueOrThrow({ where: { id: r.paymentRequest.id } });
  assert.equal(req.status, "posted");
  return prisma.supplierPayment.findUniqueOrThrow({ where: { id: req.paymentId! } });
}

const returnCustody = (employeeId: string, amount: number, to: { id: string }, k: string) =>
  createEmployeeTransaction({ employee_id: employeeId, type: "advance_return", purpose: "purchasing_custody", amount, cash_account_id: to.id, date: today, idempotency_key: key(k) }, hr);

before(async () => {
  const users = await prisma.user.findMany({ where: { active: true }, orderBy: { username: "asc" }, take: 4, select: { id: true } });
  assert.ok(users.length >= 4, "needs four users on the test database (seed)");
  hr = { ...hr, id: users[0].id };
  finance = { ...finance, id: users[1].id };
  clerk = { ...clerk, id: users[2].id };
  senior = { ...senior, id: users[3].id };
  // POs approve themselves under this threshold, so the purchase path needs no extra approver here.
  restoreThreshold = await withSetting("purchasing.po_approval_threshold", 1000000);
  // Synthetic buyers named like the business's two — created only in this test database.
  samah = (await saveEmployee(null, { name: `${TAG} Samah`, name_ar: `${TAG} سامح`, job_title: "مشتري خضار", purchasing_category: "vegetable" }, hr)).id;
  youssef = (await saveEmployee(null, { name: `${TAG} Youssef`, name_ar: `${TAG} يوسف`, job_title: "مشتري فاكهة", purchasing_category: "fruit" }, hr)).id;
  nobody = (await saveEmployee(null, { name: `${TAG} Clerk`, name_ar: `${TAG} موظف إداري` }, hr)).id;
  const sup = (n: string, category: string) => prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-6)}${n}`, name: `${TAG} ${n}`, category, paymentTermsDays: 0 } });
  vegA = (await sup("1", "vegetable")).id;
  vegB = (await sup("2", "vegetable")).id;
  fruitA = (await sup("3", "fruit")).id;
  okra = (await prisma.stockProduct.create({ data: { name: `${TAG} Okra`, unit: "KG" } })).id;
  mango = (await prisma.stockProduct.create({ data: { name: `${TAG} Mango`, unit: "KG" } })).id;
  const c = await createCashAccount({ type: "cash", name: `${TAG} Market cash`, name_ar: `${TAG} خزينة السوق` }, finance);
  const b = await createCashAccount({ type: "bank", name: `${TAG} Bank`, name_ar: `${TAG} بنك` }, finance);
  cash = { id: c.id, accountId: c.accountId };
  bank = { id: b.id, accountId: b.accountId };
  await fund(cash, 20000);
  await fund(bank, 20000);
});
after(async () => {
  await restoreThreshold?.();
  await prisma.$disconnect();
});

test("7.4 chain: advance 1000 → PO/receipt/bill 800 → custody payment 800 → return 200 settles everything once", async () => {
  const cash0 = await glBalance(cash.accountId);
  const inv0 = await keyBalance("inventory");
  const grni0 = await keyBalance("grni");

  // 1. Issue: a request first — nothing moves until someone else approves it.
  const r: any = await createEmployeeTransaction({ employee_id: samah, type: "advance", purpose: "purchasing_custody", amount: 1000, cash_account_id: cash.id, date: today, reference: "CHAIN-1", idempotency_key: key("chain-adv") }, hr);
  assert.match(r.custodyRequest.number, /^CST-\d{4}-\d{5}$/);
  assert.equal((await glBalance(cash.accountId)).toFixed(2), cash0.toFixed(2), "pending: the cash box has not moved");
  assert.equal((await advances(samah)).toFixed(2), "0.00");
  await approve(r.custodyRequest.id);
  const req = await prisma.employeeCustodyRequest.findUniqueOrThrow({ where: { id: r.custodyRequest.id }, include: { transaction: true } });
  assert.equal(req.status, "posted");
  assert.equal(req.decidedById, finance.id, "the approver is recorded");
  assert.equal(req.transaction?.purpose, "purchasing_custody");
  assert.equal(req.transaction?.reference, "CHAIN-1");
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: "employee_transaction", sourceId: req.transactionId! }, include: { lines: { include: { account: true } } } });
  const adv = je.lines.find((l) => l.account.systemKey === "employee_advances")!;
  const out = je.lines.find((l) => l.accountId === cash.accountId)!;
  assert.equal(adv.debit.toFixed(2), "1000.00");
  assert.equal(adv.partyType, "employee");
  assert.equal(adv.partyId, samah);
  assert.equal(out.credit.toFixed(2), "1000.00", "Cr cash 1000 — an advance, never an expense or stock");
  assert.equal(je.lines.length, 2);
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "1000.00");

  // 2. The purchase, recognised once through the existing path.
  const bill = await purchase(vegA, okra, 80, "10", "CHAIN");
  assert.equal(bill.total.toFixed(2), "800.00");
  assert.equal((await owed(vegA)).toFixed(2), "800.00");

  // 3. Paid from custody: Dr AP (supplier) / Cr 1600 (employee), only on approval.
  const pr: any = await createPayment({ party_id: vegA, custody_employee_id: samah, amount: 800, method: "cash", allocations: [{ document_id: bill.id, amount: 800 }], idempotency_key: key("chain-pay") }, clerk);
  assert.equal(pr.document.status, "pending_approval");
  assert.equal((await owed(vegA)).toFixed(2), "800.00", "pending: the payable is still open");
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "1000.00", "pending: custody has not fallen");
  await approve(pr.paymentRequest.id);
  const payReq = await prisma.supplierPaymentRequest.findUniqueOrThrow({ where: { id: pr.paymentRequest.id } });
  const pay = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: payReq.paymentId! } });
  assert.equal(pay.cashAccountId, null);
  assert.equal(pay.custodyEmployeeId, samah);
  const pje = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: "supplier_payment", sourceId: pay.id }, include: { lines: { include: { account: true } } } });
  const ap = pje.lines.find((l) => l.account.systemKey === "ap")!;
  const cust = pje.lines.find((l) => l.account.systemKey === "employee_advances")!;
  assert.equal(ap.debit.toFixed(2), "800.00");
  assert.equal(ap.partyId, vegA);
  assert.equal(cust.credit.toFixed(2), "800.00");
  assert.equal(cust.partyId, samah);
  assert.equal(pje.lines.length, 2, "no cash leg: the money left the treasury when the custody was issued");
  assert.equal((await owed(vegA)).toFixed(2), "0.00");
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "200.00");

  // 4. The rest comes back.
  await returnCustody(samah, 200, cash, "chain-ret");
  assert.equal((await advances(samah)).toFixed(2), "0.00", "1600 = 0 for Samah");
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "0.00");
  assert.equal((await owed(vegA)).toFixed(2), "0.00", "AP = 0 for the supplier");
  assert.equal((await glBalance(cash.accountId)).minus(cash0).toFixed(2), "-800.00", "cash moved −1000 + 200");
  assert.equal((await keyBalance("inventory")).minus(inv0).toFixed(2), "800.00", "inventory valued once, by the receipt");
  assert.equal((await keyBalance("grni")).minus(grni0).toFixed(2), "0.00", "the bill cleared the receipt's GRNI");

  const report = await integrityReport();
  for (const k of ["ap", "inventory", "trial_balance", "traceable", "party_references"]) {
    const c = report.checks.find((x: any) => x.key === k);
    assert.ok(c?.ok, `integrity ${k}: ${JSON.stringify(c)}`);
  }
});

test("Scenario 7: Samah (vegetables, cash) and Youssef (fruit, bank) — issue, pay suppliers, return; custody, AP, cash/bank and GL reconcile", async () => {
  const cash0 = await glBalance(cash.accountId);
  const bank0 = await glBalance(bank.accountId);
  await issue(samah, 1500, cash, "S7-S1");
  await issue(youssef, 2000, bank, "S7-Y1");
  // Additional funds for Youssef the same day.
  await issue(youssef, 500, bank, "S7-Y2");
  assert.equal((await custodyBalance(prisma, youssef)).toFixed(2), "2500.00");

  const b1 = await purchase(vegA, okra, 60, "10", "S7-1");
  const b2 = await purchase(vegB, okra, 70, "10", "S7-2");
  const b3 = await purchase(fruitA, mango, 100, "23", "S7-3");
  const p1 = await payFromCustody(samah, vegA, 600, b1.id, "s7-p1");
  await payFromCustody(samah, vegB, 700, b2.id, "s7-p2");
  await payFromCustody(youssef, fruitA, 2300, b3.id, "s7-p3");
  for (const s of [vegA, vegB, fruitA]) assert.equal((await owed(s)).toFixed(2), "0.00");

  // Before returning: unsettled custody is visible per holder, with the missing receipts.
  const list = await listCustody(finance as never);
  const sh = list.holders.find((h) => h.id === samah)!;
  const yh = list.holders.find((h) => h.id === youssef)!;
  assert.equal(sh.held, "200.00");
  assert.equal(yh.held, "200.00");
  // Every custody payment so far has no receipt attached (the chain's one, and these two).
  const missing0 = await missingCustodyReceipts(finance as never, { employeeId: samah });
  assert.equal(sh.missingReceipts, missing0.payments.length);
  assert.ok(missing0.payments.some((p) => p.id === p1.id));
  assert.equal(yh.missingReceipts, 1);
  // A receipt filed on one payment takes it off the missing list.
  await prisma.attachment.create({ data: { entityType: "supplier_payment", entityId: p1.id, category: "receipt", fileName: "receipt.jpg", contentType: "image/jpeg", sizeBytes: 10, sha256: "0".repeat(64), storageProvider: "local", storageKey: `${TAG}/receipt-${p1.id}`, uploadedBy: "test" } });
  const missing = await missingCustodyReceipts(finance as never, { employeeId: samah });
  assert.equal(missing.payments.length, missing0.payments.length - 1);
  assert.ok(!missing.payments.some((p) => p.id === p1.id));

  await returnCustody(samah, 200, cash, "s7-rs");
  await returnCustody(youssef, 200, bank, "s7-ry");
  for (const e of [samah, youssef]) {
    assert.equal((await custodyBalance(prisma, e)).toFixed(2), "0.00");
    assert.equal((await advances(e)).toFixed(2), "0.00", "GL 1600 per employee = 0");
  }
  assert.equal((await glBalance(cash.accountId)).minus(cash0).toFixed(2), "-1300.00", "cash: −1500 + 200");
  assert.equal((await glBalance(bank.accountId)).minus(bank0).toFixed(2), "-2300.00", "bank: −2500 + 200");

  // The statement: issued, paid (with supplier and bill), returned — documents = ledger.
  const st = await custodyStatement(youssef, finance as never);
  assert.equal(st.totals.issued, "2500.00");
  assert.equal(st.totals.paidToSuppliers, "2300.00");
  assert.equal(st.totals.returned, "200.00");
  assert.equal(st.held, "0.00");
  assert.ok(st.reconciled);
  const payRow = st.rows.find((r) => r.kind === "payment")!;
  assert.equal(payRow.supplier?.id, fruitA);
  assert.deepEqual(payRow.bills, [b3.number]);
  assert.ok(payRow.approvedBy, "the approver is on the statement");
  assert.deepEqual(st.rows.map((r) => r.kind), ["advance", "advance", "payment", "return"]);
  assert.equal(st.rows.at(-1)!.balance, "0.00");
  // The employee statement still reads the whole 1600 balance, now split.
  const es = await employeeStatement(youssef);
  assert.equal(es.advancesHeld, "0.00");
  assert.equal(es.custodyHeld, "0.00");
});

test("Scenario 8: retried submissions record once — custody request, payment request, approval and return", async () => {
  // A custody advance submitted three times at once with one key: one request.
  const body = { employee_id: youssef, type: "advance", purpose: "purchasing_custody", amount: 300, cash_account_id: bank.id, date: today, idempotency_key: key("s8-adv") };
  const many: any[] = await Promise.all([1, 2, 3].map(() => createEmployeeTransaction(body, hr)));
  assert.equal(new Set(many.map((r) => r.custodyRequest.id)).size, 1);
  assert.equal(await prisma.employeeCustodyRequest.count({ where: { idempotencyKey: key("s8-adv") } }), 1);
  assert.equal(many.filter((r) => r.replayed).length, 2);
  // The same key on a different amount is refused, not recorded.
  await assert.rejects(createEmployeeTransaction({ ...body, amount: 301 }, hr), status(409));
  await approve(many[0].custodyRequest.id);
  // A retry after approval returns the same request — no second advance.
  const again: any = await createEmployeeTransaction(body, hr);
  assert.equal(again.custodyRequest.id, many[0].custodyRequest.id);
  assert.equal((await custodyBalance(prisma, youssef)).toFixed(2), "300.00");
  // Deciding it again is refused.
  const decided = await prisma.approvalRequest.findFirstOrThrow({ where: { entityId: many[0].custodyRequest.id } });
  await assert.rejects(decideApproval(decided.id, "approve", finance as never, {}), status(409));

  // A custody payment retried with the same key: one request, one payment, the bill paid once.
  const bill = await purchase(fruitA, mango, 10, "20", "S8");
  const pay = { party_id: fruitA, custody_employee_id: youssef, amount: 200, method: "cash", allocations: [{ document_id: bill.id, amount: 200 }], idempotency_key: key("s8-pay") };
  const reqs: any[] = await Promise.all([1, 2, 3].map(() => createPayment(pay, clerk)));
  assert.equal(new Set(reqs.map((r) => r.paymentRequest.id)).size, 1);
  await approve(reqs[0].paymentRequest.id);
  const replay: any = await createPayment(pay, clerk);
  assert.equal(replay.paymentRequest.id, reqs[0].paymentRequest.id);
  assert.ok(replay.replayed);
  assert.equal(await prisma.supplierPayment.count({ where: { supplierId: fruitA, allocations: { some: { billId: bill.id } } } }), 1);
  assert.equal((await owed(fruitA)).toFixed(2), "0.00");
  assert.equal((await custodyBalance(prisma, youssef)).toFixed(2), "100.00");
  // A second, different payment for the same bill finds nothing open.
  await assert.rejects(createPayment({ ...pay, amount: 50, allocations: [{ document_id: bill.id, amount: 50 }], idempotency_key: key("s8-pay2") }, clerk), status(400));

  // A return retried with one key: returned once.
  const ret = { employee_id: youssef, type: "advance_return", purpose: "purchasing_custody", amount: 100, cash_account_id: bank.id, date: today, idempotency_key: key("s8-ret") };
  const rets: any[] = await Promise.all([1, 2].map(() => createEmployeeTransaction(ret, hr)));
  assert.equal(new Set(rets.map((r) => r.id)).size, 1);
  assert.equal((await custodyBalance(prisma, youssef)).toFixed(2), "0.00");
  assert.equal((await advances(youssef)).toFixed(2), "0.00");
});

test("Scenario 9: permissions are checked on the server, the requester never approves, categories hold unless overridden with a reason", async () => {
  // Permissions.
  const noHr = actor("بدون صلاحية", ["accounting.payments.manage"], clerk.id);
  await assert.rejects(createEmployeeTransaction({ employee_id: samah, type: "advance", purpose: "purchasing_custody", amount: 10, cash_account_id: cash.id }, noHr), status(403));
  const noPay = actor("بدون صلاحية", ["hr.advances.manage"], hr.id);
  await assert.rejects(createPayment({ party_id: vegA, custody_employee_id: samah, amount: 10, method: "cash" }, noPay), status(403));
  // Exactly one source.
  await assert.rejects(createPayment({ party_id: vegA, custody_employee_id: samah, cash_account_id: cash.id, amount: 10, method: "cash" }, clerk), status(400));
  await assert.rejects(createPayment({ party_id: vegA, amount: 10, method: "cash" }, clerk), status(400));

  // Self-approval: whoever asked for the custody cannot approve it, nor the payment.
  const self: any = await createEmployeeTransaction({ employee_id: samah, type: "advance", purpose: "purchasing_custody", amount: 1000, cash_account_id: cash.id, idempotency_key: key("s9-self") }, finance);
  await assert.rejects(approve(self.custodyRequest.id, finance), status(403));
  // An approver without the approval permission is refused too.
  const weak = actor("مراجع", ["accounting.view"], senior.id, "ACCOUNTANT");
  await assert.rejects(approve(self.custodyRequest.id, weak), status(403));
  await approve(self.custodyRequest.id, { ...finance, id: senior.id, name: "رئيس الحسابات" });
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "1000.00");
  // A rejected custody request moves nothing.
  const rej: any = await createEmployeeTransaction({ employee_id: samah, type: "advance", purpose: "purchasing_custody", amount: 999, cash_account_id: cash.id, idempotency_key: key("s9-rej") }, hr);
  await reject(rej.custodyRequest.id);
  assert.equal((await prisma.employeeCustodyRequest.findUniqueOrThrow({ where: { id: rej.custodyRequest.id } })).status, "rejected");
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "1000.00");

  const vegBill = await purchase(vegB, okra, 20, "10", "S9-V");
  const selfPay: any = await createPayment({ party_id: vegB, custody_employee_id: samah, amount: 200, method: "cash", allocations: [{ document_id: vegBill.id, amount: 200 }], idempotency_key: key("s9-selfpay") }, senior);
  await assert.rejects(approve(selfPay.paymentRequest.id, senior), status(403));
  await approve(selfPay.paymentRequest.id);
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "800.00");

  // Category: Samah buys vegetables — paying a fruit supplier from her custody is refused…
  const fruitBill = await purchase(fruitA, mango, 10, "30", "S9-F");
  const cross = { party_id: fruitA, custody_employee_id: samah, amount: 300, method: "cash", allocations: [{ document_id: fruitBill.id, amount: 300 }] };
  await assert.rejects(createPayment({ ...cross, idempotency_key: key("s9-x1") }, clerk), status(400, "custody_category_mismatch"));
  // …a reason alone is not enough without the override permission…
  await assert.rejects(createPayment({ ...cross, custody_override_reason: "مورد الفاكهة الوحيد في السوق النهارده", idempotency_key: key("s9-x2") }, clerk), status(403));
  // …the override permission without a reason is not enough either…
  await assert.rejects(createPayment({ ...cross, idempotency_key: key("s9-x3") }, senior), status(400, "custody_category_mismatch"));
  // …with both, it is recorded, audited, and still needs approval.
  const over: any = await createPayment({ ...cross, custody_override_reason: "مورد الفاكهة الوحيد في السوق النهارده", idempotency_key: key("s9-x4") }, senior);
  assert.equal(over.document.status, "pending_approval");
  assert.ok(await prisma.auditLog.findFirst({ where: { action: "custody_category_override", entityId: over.paymentRequest.id, reason: { contains: "مورد الفاكهة" } } }), "the override and its reason are audited");
  await approve(over.paymentRequest.id);
  const posted = await prisma.supplierPaymentRequest.findUniqueOrThrow({ where: { id: over.paymentRequest.id } });
  assert.ok(await prisma.auditLog.findFirst({ where: { action: "custody_category_override", entityId: posted.paymentId! } }));
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "500.00");
  assert.equal((await owed(fruitA)).toFixed(2), "0.00");
  // An employee with no purchasing category pays nobody from custody without an override.
  await issue(nobody, 100, cash, "S9-N");
  const nb = await purchase(vegA, okra, 5, "10", "S9-N");
  await assert.rejects(createPayment({ party_id: vegA, custody_employee_id: nobody, amount: 50, method: "cash", allocations: [{ document_id: nb.id, amount: 50 }], idempotency_key: key("s9-n") }, clerk), status(400, "custody_category_mismatch"));

  // Custody must cover the payment; pending requests are reserved.
  const big = await purchase(vegA, okra, 100, "10", "S9-BIG");
  await assert.rejects(createPayment({ party_id: vegA, custody_employee_id: samah, amount: 600, method: "cash", allocations: [{ document_id: big.id, amount: 600 }], idempotency_key: key("s9-big") }, clerk), status(409, "custody_insufficient"));
  const hold: any = await createPayment({ party_id: vegA, custody_employee_id: samah, amount: 400, method: "cash", allocations: [{ document_id: big.id, amount: 400 }], idempotency_key: key("s9-hold") }, clerk);
  await assert.rejects(createPayment({ party_id: vegA, custody_employee_id: samah, amount: 200, method: "cash", allocations: [{ document_id: big.id, amount: 200 }], idempotency_key: key("s9-over") }, clerk), status(409, "custody_insufficient"));
  // …and a return cannot take what a pending payment already promises.
  await assert.rejects(returnCustody(samah, 200, cash, "s9-ret-over"), status(400));
  await approve(hold.paymentRequest.id);
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "100.00");

  // Custody is kept apart from salary advances.
  // a) a produce purchase cannot be expensed from custody,
  const expAccount = await prisma.account.findFirstOrThrow({ where: { type: "expense", postable: true, active: true, systemKey: "general_expenses" } });
  await assert.rejects(createExpense({ employee_id: samah, account_id: expAccount.id, amount: 50, description: "خضار من السوق", payment_mode: "advance" }, hr), status(409, "custody_not_expense"));
  // b) a salary return cannot consume custody, and a custody advance gets no payroll instalment plan,
  await assert.rejects(createEmployeeTransaction({ employee_id: samah, type: "advance_return", amount: 50, cash_account_id: cash.id }, hr), status(400));
  const custodyTx = await prisma.employeeTransaction.findFirstOrThrow({ where: { employeeId: samah, purpose: "purchasing_custody", type: "advance" } });
  await assert.rejects(createAdvancePlan({ advance_transaction_id: custodyTx.id, instalment_amount: "50", start_period: today.slice(0, 7), reason: "تقسيط" }, hr), status(400));
  // c) payroll and final settlement see only the salary side of 1600.
  await createEmployeeTransaction({ employee_id: samah, type: "advance", amount: 250, cash_account_id: cash.id, idempotency_key: key("s9-salary") }, hr);
  assert.equal((await advances(samah)).toFixed(2), "350.00", "1600 holds both");
  assert.equal((await salaryAdvanceBalance(prisma, samah)).toFixed(2), "250.00", "…payroll may recover only the salary advance");
  const es = await employeeStatement(samah);
  assert.equal(es.custodyHeld, "100.00");
  assert.equal(es.salaryAdvancesHeld, "250.00");
  // d) the salary advance is returned on its own; the custody stays.
  await createEmployeeTransaction({ employee_id: samah, type: "advance_return", amount: 250, cash_account_id: cash.id, idempotency_key: key("s9-salary-ret") }, hr);
  assert.equal((await custodyBalance(prisma, samah)).toFixed(2), "100.00");
  // Purpose is only for advances and returns.
  await assert.rejects(createEmployeeTransaction({ employee_id: samah, type: "reimbursement", purpose: "purchasing_custody", amount: 1, cash_account_id: cash.id }, hr), status(400));
  // The database itself refuses a payment with two sources or none.
  await assert.rejects(prisma.$executeRaw`UPDATE "SupplierPaymentRequest" SET "cashAccountId" = ${cash.id} WHERE "id" = ${hold.paymentRequest.id}`, /keeps what was asked/);
});

test("reversing a custody payment gives the money back to the custody and reopens the bill", async () => {
  await issue(youssef, 400, bank, "REV-1");
  const bill = await purchase(fruitA, mango, 10, "40", "REV");
  const p = await payFromCustody(youssef, fruitA, 400, bill.id, "rev-pay");
  assert.equal((await custodyBalance(prisma, youssef)).toFixed(2), "0.00");
  await reversePayment(p.id, { reason: "اتسجل على المورد الغلط" }, finance as never);
  assert.equal((await custodyBalance(prisma, youssef)).toFixed(2), "400.00");
  assert.equal((await owed(fruitA)).toFixed(2), "400.00");
  const st = await custodyStatement(youssef, finance as never);
  assert.ok(st.reconciled);
  assert.equal(st.rows.at(-1)!.kind, "payment_reversal");
  await returnCustody(youssef, 400, bank, "rev-ret");
  assert.equal((await advances(youssef)).toFixed(2), "0.00");
});
