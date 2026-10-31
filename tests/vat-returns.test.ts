/* VAT returns and manual-journal approval.
   VAT: a return sets off input against output VAT from the ledger's balances at its end
   date (Dr output / Cr input / Cr payable), carries excess input forward, is paid from a
   cash or bank account (Dr payable / Cr cash), freezes VAT in its period (app and DB), and
   — while unpaid — can be voided to free the period. Returns follow each other without
   gaps or overlaps. The suite works on past-dated ranges after the last live return so it
   never locks today's VAT for the suites that follow.
   Journals: above the threshold a manual journal waits for someone else with approval
   permission; the requester cannot approve it; rejection and withdrawal post nothing. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";
import { inTx } from "@/lib/tx";
import { postJournal } from "@/lib/accounting/ledger";

const TAG = `ZZVAT${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const n = (v: any) => Number(v ?? 0);
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const setSetting = (key: string, value: unknown) => call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: `${TAG} اختبار` });
const SYS = { id: null, name: "اختبار", role: "SYSTEM" };

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "karim", "mona", "omar"]) await login(u);
  // Service bills wait for a second person at the default threshold: approve as management.
  const postBill = async (id: string) => {
    let res = await call("karim", "POST", `/api/purchasing/bills/${id}/post`, {});
    if (res.body?.bill?.status === "pending_approval") {
      const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === id);
      const d = await call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version });
      res = { status: d.status, body: { ...d.body, bill: (await call("karim", "GET", `/api/purchasing/bills/${id}`)).body.bill, error: d.body?.error } };
    }
    return res;
  };
  const glAsOf = async (key: string, asOf: string) => {
    const [r] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${key} AND e."date" <= ${asOf}`;
    return n(r?.b);
  };

  section("0. WHERE TO START");
  let list = (await call("karim", "GET", "/api/accounting/vat-returns")).body;
  check("the accountant lists returns and the VAT balances", Array.isArray(list.returns) && list.balances?.input !== undefined, list);
  check("sales cannot see VAT returns -> 403", (await call("mona", "GET", "/api/accounting/vat-returns")).status === 403);
  const D1 = list.nextFrom ?? "2025-01-01";
  check("the range is in the past (never today's VAT)", D1 < addDays(new Date().toISOString().slice(0, 10), -30), D1);
  const D1end = addDays(D1, 4), D2 = addDays(D1, 5), D2end = addDays(D1, 9);

  const today = todayBiz();

  section("1. A RETURN THAT ONLY CARRIES INPUT FORWARD");
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مالك المخزن` })).body.supplier;
  let r = await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier.id, supplier_invoice_no: `${TAG}-1`, bill_date: D1, lines: [{ account_id: "acc_6100", description: "إيجار", amount: "400", tax_code: "VAT14" }] });
  const bill1 = r.body.bill;
  r = await postBill(bill1?.id);
  check("a service bill dated D1 posts 56 input VAT", r.body.bill?.status === "posted" && n(r.body.bill.taxTotal) === 56, r.body);
  const out1 = Math.max(-(await glAsOf("vat_output", D1end)), 0);
  const in1 = Math.max(await glAsOf("vat_input", D1end), 0);
  r = await call("karim", "GET", `/api/accounting/vat-returns/preview?from=${D1}&to=${D1end}`);
  const p1 = r.body.preview;
  check("preview: output, input and the set-off from the ledger", n(p1.outputTax) === out1 && n(p1.inputTax) === in1 && n(p1.inputUsed) === Math.min(out1, in1), [p1, out1, in1]);
  check("preview: payable + used = output; carried = input − used", n(p1.payable) + n(p1.inputUsed) === n(p1.outputTax) && Math.abs(n(p1.carryForward) - (n(p1.inputTax) - n(p1.inputUsed))) < 0.005);
  check("preview: the documents reconcile with the ledger", p1.reconciled === true && p1.problems.length === 0, p1.problems);
  check("a period that has not ended cannot be filed -> 400", (await call("karim", "POST", "/api/accounting/vat-returns", { period_from: D1, period_to: "2099-12-31" })).status === 400);
  check("sales cannot file -> 403", (await call("mona", "POST", "/api/accounting/vat-returns", { period_from: D1, period_to: D1end })).status === 403);
  r = await call("karim", "POST", "/api/accounting/vat-returns", { period_from: D1, period_to: D1end, reference: `${TAG}-R1` });
  const ret1 = r.body.vatReturn;
  check("filed -> 201 (VAT-YYYY-####)", r.status === 201 && /^VAT-\d{4}-\d{4}$/.test(ret1?.number), r.body);
  check("…output VAT is cleared at the period end", Math.abs(await glAsOf("vat_output", D1end)) < 0.005);
  check("…input VAT left = what is carried forward", Math.abs((await glAsOf("vat_input", D1end)) - n(ret1.carryForward)) < 0.005, [await glAsOf("vat_input", D1end), ret1.carryForward]);
  check("…status: paid at once when nothing is due, filed otherwise", ret1.status === (n(ret1.payable) === 0 ? "paid" : "filed"), ret1.status);

  section("2. THE FILED PERIOD IS FROZEN FOR VAT");
  r = await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier.id, supplier_invoice_no: `${TAG}-LATE`, bill_date: addDays(D1, 2), lines: [{ account_id: "acc_6100", description: "متأخرة", amount: "100", tax_code: "VAT14" }] });
  const late = await postBill(r.body.bill?.id);
  check("a taxed bill dated inside the filed period is refused (409) and stays unposted", late.status === 409 && /فترة الضريبة/.test(late.body.error ?? "") && late.body.bill?.status !== "posted", [late.status, late.body.error, late.body.bill?.status]);
  let refused = false;
  try { await inTx((tx) => postJournal(tx, { date: addDays(D1, 1), description: `${TAG} raw`, sourceType: "manual", sourceId: `${TAG}-raw`, lines: [{ key: "vat_input", amount: new Prisma.Decimal(1) }, { key: "cash", amount: new Prisma.Decimal(-1) }] }, SYS)); } catch { refused = true; }
  check("…and the database refuses VAT lines in it whatever the path", refused);
  check("an overlapping return -> 409", (await call("karim", "POST", "/api/accounting/vat-returns", { period_from: addDays(D1, 2), period_to: D2end })).status === 409);
  check("a gap after the last return -> 409", (await call("karim", "POST", "/api/accounting/vat-returns", { period_from: addDays(D2, 1), period_to: D2end })).status === 409);

  section("3. A RETURN WITH VAT DUE, PAID FROM THE BANK");
  // Fixture: output VAT on D2 (as an invoice would post it), so something is due.
  await inTx((tx) => postJournal(tx, { date: D2, description: `${TAG} مبيعات خاضعة`, sourceType: "manual", sourceId: `${TAG}-out`, lines: [{ key: "cash", amount: new Prisma.Decimal(1140) }, { key: "sales", amount: new Prisma.Decimal(-1000) }, { key: "vat_output", amount: new Prisma.Decimal(-140) }] }, SYS));
  await inTx((tx) => postJournal(tx, { date: D2, description: `${TAG} مبيعات خاضعة (كمان)`, sourceType: "manual", sourceId: `${TAG}-out2`, lines: [{ key: "cash", amount: new Prisma.Decimal(570) }, { key: "sales", amount: new Prisma.Decimal(-500) }, { key: "vat_output", amount: new Prisma.Decimal(-70) }] }, SYS));
  const p2 = (await call("karim", "GET", `/api/accounting/vat-returns/preview?from=${D2}&to=${D2end}`)).body.preview;
  // The fixture lines bypass documents, so the summary shows them as unreconciled — that is the check working.
  check("ledger VAT not backed by documents makes the summary unreconciled and blocks filing", p2.reconciled === false && p2.problems.includes("summary_not_reconciled"), p2);
  check("…filing is refused while unreconciled (409)", (await call("karim", "POST", "/api/accounting/vat-returns", { period_from: D2, period_to: D2end })).status === 409);
  // Back it with a document: void the fixture by mirror entries and post the output through a sales-side source.
  await inTx((tx) => postJournal(tx, { date: D2, description: `${TAG} عكس`, sourceType: "manual", sourceId: `${TAG}-out-rev`, lines: [{ key: "cash", amount: new Prisma.Decimal(-1710) }, { key: "sales", amount: new Prisma.Decimal(1500) }, { key: "vat_output", amount: new Prisma.Decimal(210) }] }, SYS));
  // A real taxed sale issued on D2: a VAT-14 product, an order dispatched, invoiced on D2.
  for (const u of ["hossam", "sara"]) await login(u);
  const prod = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Juice`, unit: "KG" })).body.product;
  await call("karim", "PATCH", `/api/sales/products/${prod.id}/tax`, { tax_code: "VAT14", reason: "عصير مصنّع — خاضع" });
  const sup3 = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مصنع` })).body.supplier;
  await call("admin", "POST", "/api/stock/intakes", { supplier_id: sup3.id, product_id: prod.id, received_kg: 50, unit_cost: "10" });
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} كافيه` })).body.customer;
  const o = (await call("sara", "POST", "/api/orders", { customer_account_id: customer.id, customer_name: customer.name, delivery_date: today, items: [{ stock_product_id: prod.id, product_name: prod.name, quantity: 20 }] })).body.order;
  await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: "200", reason: "عقد" });
  await call("sara", "POST", `/api/orders/${o.id}/status`, { to: "loading", reason: "مباشر" });
  await call("sara", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: 20, mark_done: true });
  await call("sara", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", reason: "خرج", vehicle: "x", driver_name: "y", crate_count: 1 });
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
  r = await call("karim", "POST", `/api/sales/invoices/${inv?.id}/issue`, { issue_date: D2 });
  check("a taxed invoice issued on D2: 4000 + 560 output VAT", r.status === 200 && n(r.body.invoice?.taxTotal) === 560 && r.body.invoice.issueDate === D2, r.body);
  const supplier2 = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} صيانة` })).body.supplier;
  r = await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier2.id, supplier_invoice_no: `${TAG}-2`, bill_date: D2, lines: [{ account_id: "acc_6200", description: "صيانة عربية", amount: "300", tax_code: "VAT14" }] });
  await postBill(r.body.bill?.id);
  const p3 = (await call("karim", "GET", `/api/accounting/vat-returns/preview?from=${D2}&to=${D2end}`)).body.preview;
  check("with documents behind every VAT line the period reconciles", p3.reconciled === true && p3.problems.length === 0, p3);
  check("…the credit carried from the previous return is used again", n(p3.inputTax) >= n(ret1.carryForward) + 42 - 0.005, [p3.inputTax, ret1.carryForward]);
  r = await call("karim", "POST", "/api/accounting/vat-returns", { period_from: D2, period_to: D2end });
  const ret2 = r.body.vatReturn;
  check("second return filed, contiguous with the first", r.status === 201 && ret2.periodFrom === D2, r.body);
  const payableBefore = await glAsOf("vat_payable", "9999-12-31");
  check("output 560 less the input available leaves VAT due", n(ret2.payable) > 0, ret2);
  if (n(ret2.payable) > 0) {
    check("paying before the period ends -> 400", (await call("karim", "POST", `/api/accounting/vat-returns/${ret2.id}/pay`, { cash_account_id: "bank_main", date: addDays(D2, 1) })).status === 400);
    r = await call("karim", "POST", `/api/accounting/vat-returns/${ret2.id}/pay`, { cash_account_id: "bank_main", date: D2end, reference: "ETA-123" });
    check("paid from the bank -> 200", r.status === 200 && r.body.vatReturn.status === "paid", r.body);
    check("…VAT payable cleared by the payment", Math.abs((await glAsOf("vat_payable", "9999-12-31")) - (payableBefore + n(ret2.payable))) < 0.005);
    check("a second payment -> 409", (await call("karim", "POST", `/api/accounting/vat-returns/${ret2.id}/pay`, { cash_account_id: "bank_main", date: D2end })).status === 409);
    check("a paid return cannot be voided -> 409", (await call("karim", "POST", `/api/accounting/vat-returns/${ret2.id}/void`, { reason: "x" })).status === 409);
  } else {
    check("nothing due: the return is closed as paid at once", ret2.status === "paid");
  }

  section("4. VOIDING AN UNPAID RETURN (the latest one only)");
  if (n(ret2.payable) === 0) {
    check("an earlier return cannot be voided while a later one is live -> 409", (await call("karim", "POST", `/api/accounting/vat-returns/${ret1.id}/void`, { reason: "x" })).status === 409);
    r = await call("karim", "POST", `/api/accounting/vat-returns/${ret2.id}/void`, { reason: "تصحيح" });
    check("the latest unpaid return is voided and its settlement reversed", r.status === 200 && r.body.vatReturn.status === "voided", r.body);
  }
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("integrity: VAT payable = unpaid returns", health.checks.find((c: any) => c.key === "vat_payable")?.ok === true, health.checks.find((c: any) => c.key === "vat_payable"));
  check("integrity: every entry traceable, all checks green", health.ok === true, health.checks.filter((c: any) => !c.ok));
  refused = false;
  try { await db.$executeRawUnsafe(`UPDATE "VatReturn" SET "outputTax" = "outputTax" + 1, "payable" = "payable" + 1 WHERE "id" = '${ret1.id}'`); } catch { refused = true; }
  check("DB: a filed return's figures cannot be edited", refused);
  refused = false;
  try { await db.$executeRawUnsafe(`DELETE FROM "VatReturn" WHERE "id" = '${ret1.id}'`); } catch { refused = true; }
  check("DB: a return cannot be deleted", refused);

  section("5. MANUAL JOURNALS ABOVE THE THRESHOLD NEED SOMEONE ELSE");
  const lines = (amount: number) => [{ account_id: "acc_6100", debit: amount }, { account_id: "acc_1100", credit: amount }];
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} off`, lines: lines(5000) });
  check("approval off (default): a large journal posts at once -> 201", r.status === 201 && !!r.body.journal?.number, r.body);
  await setSetting("accounting.manual_journal_approval", true);
  await setSetting("accounting.manual_journal_approval_threshold", 1000);
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} small`, lines: lines(500) });
  check("below the threshold it still posts at once", r.status === 201 && !!r.body.journal);
  const key = `${TAG}-jr-1`;
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} big`, lines: lines(2500), idempotency_key: key });
  check("2500 above 1000 waits -> 202 with a JR number, nothing posted", r.status === 202 && /^JR-\d{4}-\d{5}$/.test(r.body.journalRequest?.number) && r.body.journalRequest.status === "pending_approval", r.body);
  const jr = r.body.journalRequest;
  check("the same submit again returns the same request", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} big`, lines: lines(2500), idempotency_key: key })).body.journalRequest?.id === jr.id);
  check("…the same key on a different journal -> 409", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} other`, lines: lines(2600), idempotency_key: key })).status === 409);
  check("a request on a control account is refused up front -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} ar`, lines: [{ account_id: "acc_1300", debit: 2000 }, { account_id: "acc_1100", credit: 2000 }] })).status === 400);
  check("no journal entry exists for it yet", !(await call("karim", "GET", "/api/accounting/journals?source_type=manual&limit=50")).body.journals.some((j: any) => j.description === `${TAG} big`));
  let approval = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === jr.id);
  check("it is in the approvals inbox", approval?.type === "accounting.manual_journal", approval);
  check("the requester cannot approve it (403)", (await call("karim", "POST", `/api/approvals/${approval.id}/decide`, { decision: "approve" })).status === 403);
  r = await call("admin", "POST", `/api/approvals/${approval.id}/decide`, { decision: "approve", expected_version: approval.version });
  const reqs = (await call("karim", "GET", "/api/accounting/journal-requests")).body.requests;
  const posted = reqs.find((x: any) => x.id === jr.id);
  check("someone else approves: posted as a manual journal", r.status === 200 && posted?.status === "posted" && !!posted.entry?.number, posted);
  const je = (await call("karim", "GET", `/api/accounting/journals/${posted.entryId}`)).body.journal;
  check("…Dr general expenses 2500 / Cr cash 2500, recorded as the requester's", je.sourceType === "manual" && n(je.total) === 2500 && je.createdBy === posted.requestedBy, je);
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} reject`, lines: lines(3000) });
  approval = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === r.body.journalRequest.id);
  await call("admin", "POST", `/api/approvals/${approval.id}/decide`, { decision: "reject", comment: "مش مبرر", expected_version: approval.version });
  check("a rejected request posts nothing", (await call("karim", "GET", "/api/accounting/journal-requests")).body.requests.find((x: any) => x.id === r.body.journalRequest.id)?.status === "rejected");
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} withdraw`, lines: lines(4000) });
  const w = await call("karim", "POST", `/api/accounting/journal-requests/${r.body.journalRequest.id}/cancel`, { reason: "اتسجل غلط" });
  check("the requester withdraws a waiting request", w.status === 200 && w.body.request.status === "cancelled", w.body);
  check("…and it leaves the approvals inbox", !(await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.some((a: any) => a.entityId === r.body.journalRequest.id));
  refused = false;
  try { await db.$executeRawUnsafe(`UPDATE "JournalRequest" SET "total" = 1 WHERE "id" = '${jr.id}'`); } catch { refused = true; }
  check("DB: what was requested cannot be edited", refused);
  await setSetting("accounting.manual_journal_approval", null);
  await setSetting("accounting.manual_journal_approval_threshold", null);

  await db.$disconnect();
  finish("VAT RETURNS & JOURNAL APPROVAL");
}

main().catch((e) => { console.error(e); process.exit(1); });
