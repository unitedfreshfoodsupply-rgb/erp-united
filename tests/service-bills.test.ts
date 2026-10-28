/* Service bills: a supplier invoice with no goods receipt behind it — rent, utilities,
   transport, maintenance, equipment. Each line is an expense (or asset) account with its
   tax; posting is Dr those accounts / Dr input VAT / Cr the supplier, and from there the
   bill is paid, aged, stated and VAT-summarised exactly like a goods bill. */
import { call, login, makeChecker } from "./_harness";

const TAG = `ZZSVC-${Date.now()}`;
const { check, section, finish } = makeChecker();
const today = new Date().toISOString().slice(0, 10);
const n = (v: any) => Number(v ?? 0);
const code = (prefix: string) => `${prefix}${String(Date.now()).slice(-5)}`;

const journalOf = async (sourceType: string, number: string) => {
  const list = (await call("karim", "GET", `/api/accounting/journals?source_type=${sourceType}&limit=30`)).body.journals ?? [];
  const head = list.find((j: any) => String(j.description).includes(number));
  return head ? (await call("karim", "GET", `/api/accounting/journals/${head.id}`)).body.journal : null;
};
const net = (journal: any, accountCode: string) =>
  (journal?.lines ?? []).filter((l: any) => l.account.code === accountCode).reduce((s: number, l: any) => s + n(l.debit) - n(l.credit), 0);
const approvalFor = async (entityId: string) => (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === entityId);

async function main() {
  section("0. SETUP");
  for (const u of ["admin", "karim", "omar", "ahmed", "mona"]) await login(u);
  const rent = (await call("karim", "POST", "/api/accounting/accounts", { code: code("61"), name: `${TAG} Rent`, name_ar: `${TAG} إيجار`, parent_id: "acc_6000" })).body.account;
  const truck = (await call("karim", "POST", "/api/accounting/accounts", { code: code("18"), name: `${TAG} Equipment`, name_ar: `${TAG} معدات`, parent_id: "acc_1000" })).body.account;
  const landlord = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} المالك` })).body.supplier;
  check("rent and equipment accounts, a supplier", !!rent?.id && !!truck?.id && !!landlord?.id, { rent, truck, landlord });
  const vatBefore = (await call("karim", "GET", `/api/accounting/vat-summary?from=${today}&to=${today}`)).body.summary;

  section("1. DRAFT");
  const draft = { kind: "service", supplier_id: landlord.id, supplier_invoice_no: `${TAG}-R10`, bill_date: today, lines: [{ account_id: rent.id, description: "إيجار المخزن — أكتوبر", amount: "1000", tax_code: "VAT14" }] };
  const r1 = await call("karim", "POST", "/api/purchasing/bills", draft);
  check("service bill 1,000 + VAT 14% -> 201 draft", r1.status === 201 && r1.body.bill?.status === "draft" && r1.body.bill?.kind === "service", r1.body);
  const bill = r1.body.bill;
  check("totals: net 1,000, tax 140, total 1,140", n(bill?.net) === 1000 && n(bill?.taxTotal) === 140 && n(bill?.total) === 1140, bill);
  check("same supplier invoice number again -> 409", (await call("karim", "POST", "/api/purchasing/bills", draft)).status === 409);
  check("a line on the customers control account -> 400", (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X1`, lines: [{ ...draft.lines[0], account_id: "acc_1300" }] })).status === 400);
  check("a line on the input VAT account -> 400", (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X2`, lines: [{ ...draft.lines[0], account_id: "acc_1500" }] })).status === 400);
  check("a line on a header account -> 400", (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X3`, lines: [{ ...draft.lines[0], account_id: "acc_6000" }] })).status === 400);
  check("a line on a revenue account -> 400", (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X4`, lines: [{ ...draft.lines[0], account_id: "acc_4100" }] })).status === 400);
  check("a line on the cash account -> 400", (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X5`, lines: [{ ...draft.lines[0], account_id: "acc_1100" }] })).status === 400);
  for (const [id, label] of [["acc_5100", "COGS"], ["acc_5200", "inventory adjustments"], ["acc_5300", "purchase price variance"]]) {
    check(`a line on ${label} -> 400`, (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-K${id}`, lines: [{ ...draft.lines[0], account_id: id }] })).status === 400);
  }
  const general = await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-G1`, lines: [{ ...draft.lines[0], account_id: "acc_6100" }] });
  check("a line on general expenses (6100, a system account) -> 201", general.status === 201, general.body);
  check("…cancelled again", (await call("karim", "POST", `/api/purchasing/bills/${general.body.bill?.id}/cancel`, { reason: "اختبار" })).body.bill?.status === "cancelled");
  check("an unknown tax code -> 400", (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X6`, lines: [{ ...draft.lines[0], tax_code: "NOPE" }] })).status === 400);
  check("a zero amount -> 400", (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X7`, lines: [{ ...draft.lines[0], amount: "0" }] })).status === 400);
  check("the floor cannot book bills -> 403", (await call("ahmed", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-X8` })).status === 403);
  const edited = await call("karim", "PUT", `/api/purchasing/bills/${bill.id}`, { ...draft, lines: [...draft.lines, { account_id: truck.id, description: "رف تبريد", amount: "500", tax_code: "VAT14" }], expected_version: bill.version });
  check("edit the draft: add an equipment line (500) -> 200", edited.status === 200 && n(edited.body.bill?.total) === 1710, edited.body);
  check("editing a service bill as a goods bill -> 400", (await call("karim", "PUT", `/api/purchasing/bills/${bill.id}`, { supplier_id: landlord.id, supplier_invoice_no: `${TAG}-R10`, bill_date: today, lines: [{ intake_id: "x", unit_price: "1" }] })).status === 400);

  section("2. APPROVAL ABOVE THE THRESHOLD (default 0: every service bill)");
  const posting = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  check("post -> waits for approval", posting.body.bill?.status === "pending_approval", posting.body);
  const ap = await approvalFor(bill.id);
  check("the approval names the bill and its total", ap?.type === "purchasing.bill" && /1710\.00/.test(ap?.summary ?? ""), ap);
  check("the accountant who booked it cannot approve it -> 403", (await call("karim", "POST", `/api/approvals/${ap?.id}/decide`, { decision: "approve" })).status === 403);
  check("management approves -> 200", (await call("admin", "POST", `/api/approvals/${ap?.id}/decide`, { decision: "approve", comment: "تمام" })).status === 200);
  const posted = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
  check("posted, open 1,710", posted?.status === "posted" && posted?.open === "1710.00", posted);
  check("a posted service bill cannot be edited -> 409", (await call("karim", "PUT", `/api/purchasing/bills/${bill.id}`, { ...draft, expected_version: posted?.version })).status === 409);

  section("3. JOURNAL, STATEMENT, AGING, VAT");
  const j = await journalOf("supplier_bill", bill.number);
  check("journal: Dr rent 1,000, Dr equipment 500, Dr VAT input 210, Cr suppliers 1,710", net(j, rent.code) === 1000 && net(j, truck.code) === 500 && net(j, "1500") === 210 && net(j, "2100") === -1710, j?.lines);
  check("supplier statement: owed 1,710", (await call("karim", "GET", `/api/purchasing/suppliers/${landlord.id}/statement`)).body.payable === "1710.00");
  const aging = (await call("karim", "GET", "/api/purchasing/reports/ap-aging")).body.aging;
  check("AP aging includes it", n((aging?.rows ?? aging ?? []).find?.((r: any) => r.supplier?.id === landlord.id)?.total) === 1710, aging?.rows?.slice?.(0, 3));
  const vat = (await call("karim", "GET", `/api/accounting/vat-summary?from=${today}&to=${today}`)).body.summary;
  check("VAT summary: input tax up by 210", Math.round((n(vat?.totals?.inputTax) - n(vatBefore?.totals?.inputTax)) * 100) === 21000, [vatBefore?.totals, vat?.totals]);
  check("…and still reconciles to the ledger", vat?.ledger?.reconciled === true, vat?.ledger);

  section("4. ALLOWANCE (DEBIT NOTE) ON A SERVICE LINE");
  const rentLine = posted.serviceLines.find((l: any) => l.accountId === rent.id);
  const over = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "خصم", lines: [{ service_line_id: rentLine.id, amount: "1000.01" }] });
  check("more than the line -> 400", over.status === 400, over.body);
  const dnKey = `${TAG}-dn1`;
  const dn = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "خصم أيام إغلاق", lines: [{ service_line_id: rentLine.id, amount: "100" }], idempotency_key: dnKey });
  check("allowance 100 on the rent line -> 201", dn.status === 201, dn.body);
  check("same key, same note -> the same debit note", (await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "خصم أيام إغلاق", lines: [{ service_line_id: rentLine.id, amount: "100" }], idempotency_key: dnKey })).body.debitNote?.id === dn.body.debitNote?.id);
  const jd = await journalOf("debit_note", dn.body.debitNote?.number);
  check("journal: Dr suppliers 114, Cr rent 100, Cr VAT input 14", net(jd, "2100") === 114 && net(jd, rent.code) === -100 && net(jd, "1500") === -14, jd?.lines);
  const rest = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "باقي الإيجار", lines: [{ service_line_id: rentLine.id, amount: "900" }] });
  check("the rest of the line (900) comes off exactly", rest.status === 201 && n(rest.body.debitNote?.total) === 1026, rest.body);
  check("nothing left on that line -> 400", (await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "x", lines: [{ service_line_id: rentLine.id, amount: "0.01" }] })).status === 400);
  const after = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
  check("bill open now 570 (equipment line + its tax)", after?.open === "570.00", after);

  section("5. PAID LIKE ANY BILL");
  const pay = await call("karim", "POST", "/api/accounting/payments", { party_id: landlord.id, amount: "570", method: "bank_transfer", cash_account_id: "bank_main", auto: true });
  check("payment 570 -> 201", pay.status === 201, pay.body);
  check("supplier owed nothing", (await call("karim", "GET", `/api/purchasing/suppliers/${landlord.id}/statement`)).body.payable === "0.00");
  const vatEnd = (await call("karim", "GET", `/api/accounting/vat-summary?from=${today}&to=${today}`)).body.summary;
  check("VAT summary nets the allowances (input 210 − 14 − 126 = 70)", Math.round((n(vatEnd?.totals?.inputTax) - n(vatBefore?.totals?.inputTax)) * 100) === 7000 && vatEnd?.ledger?.reconciled === true, vatEnd?.totals);
  check("Accounts Health green", (await call("karim", "GET", "/api/accounting/integrity")).body.integrity?.ok === true);

  section("6. A SMALL BILL UNDER A RAISED THRESHOLD POSTS AT ONCE");
  check("threshold raised to 500", (await call("admin", "PATCH", "/api/admin/settings/purchasing.service_bill_approval_threshold", { value: 500, reason: TAG })).status === 200);
  const small = (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-W1`, lines: [{ account_id: rent.id, description: "مياه", amount: "200", tax_code: "VAT14" }] })).body.bill;
  check("228 under 500 posts without approval", (await call("karim", "POST", `/api/purchasing/bills/${small?.id}/post`, {})).body.bill?.status === "posted");
  const cancelMe = (await call("karim", "POST", "/api/purchasing/bills", { ...draft, supplier_invoice_no: `${TAG}-C1` })).body.bill;
  check("a draft service bill can be cancelled", (await call("karim", "POST", `/api/purchasing/bills/${cancelMe?.id}/cancel`, { reason: "مكرر" })).body.bill?.status === "cancelled");
  check("threshold back to default", (await call("admin", "PATCH", "/api/admin/settings/purchasing.service_bill_approval_threshold", { value: null, reason: TAG })).status === 200);
  check("bill list shows the kind", ((await call("karim", "GET", `/api/purchasing/bills`)).body.bills ?? []).find((b: any) => b.id === bill.id)?.kind === "service");
  finish("SERVICE-BILLS");
}

main().catch((e) => {
  console.error("SUITE CRASHED", e);
  process.exit(1);
});
