/* Treasury: cash boxes and bank accounts as master data, transfers between them, and the
   cash-flow classification of accounts.
   - a new bank/cash box gets its own GL account and is usable by receipts at once;
   - a transfer posts Dr destination / Cr source (+ fee to bank charges), changes no P&L,
     is idempotent, refuses to overdraw a cash box, waits for a second person above the
     approval threshold, and is reversed once;
   - an account with a balance cannot be retired, a cash box with money cannot be closed;
   - the cash-flow statement counts every cash account, classifies by the account's own
     category and flags what is not classified — never guessing from the type;
   - VAT accounts refuse manual journals; the DB refuses edits to a transfer.
   Settings touched are restored at the end. */
import { PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";

const TAG = `ZZTRS${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = new Date().toISOString().slice(0, 10);
const n = (v: any) => Number(v ?? 0);
const code = (prefix: string) => `${prefix}${String(Date.now()).slice(-5)}`;
const setSetting = (key: string, value: unknown) => call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: `${TAG} اختبار` });
const journal = async (id: string) => (await call("karim", "GET", `/api/accounting/journals/${id}`)).body.journal;
const net = (j: any, accountCode: string) => (j?.lines ?? []).filter((l: any) => l.account.code === accountCode).reduce((s: number, l: any) => s + n(l.debit) - n(l.credit), 0);
const cashRows = async () => (await call("karim", "GET", "/api/accounting/cash-accounts?all=1")).body.cashAccounts as any[];
const balanceOf = async (id: string) => n((await cashRows()).find((r) => r.id === id)?.balance);

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "karim", "mona", "mostafa"]) await login(u);
  const accounts = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts as any[];
  const A = (c: string) => accounts.find((a) => a.code === c).id;

  // A run that stopped half-way may have left these switched on: start from the shipped defaults.
  for (const k of ["accounting.bank_charges_account", "accounting.transfer_approval", "accounting.transfer_approval_threshold"]) await setSetting(k, null);

  section("1. ACCESS");
  check("sales cannot list cash accounts -> 403", (await call("mona", "GET", "/api/accounting/cash-accounts")).status === 403);
  check("the floor cannot create a cash account -> 403", (await call("mostafa", "POST", "/api/accounting/cash-accounts", { type: "cash", name: "x", name_ar: "x" })).status === 403);
  check("…nor a transfer -> 403", (await call("mostafa", "POST", "/api/accounting/transfers", {})).status === 403);

  section("2. A NEW BANK ACCOUNT AND CASH BOX");
  let r = await call("karim", "POST", "/api/accounting/cash-accounts", { type: "bank", name: `${TAG} NBE`, name_ar: `${TAG} البنك الأهلي`, bank_name: "NBE", account_number: "EG00 1234" });
  check("bank account created -> 201", r.status === 201, r.body);
  const bank = r.body.cashAccount;
  r = await call("karim", "POST", "/api/accounting/cash-accounts", { type: "cash", name: `${TAG} Branch box`, name_ar: `${TAG} خزينة الفرع` });
  const box = r.body.cashAccount;
  check("cash box created -> 201", r.status === 201 && !!box?.id, r.body);
  check("a cash box takes no bank details -> 400", (await call("karim", "POST", "/api/accounting/cash-accounts", { type: "cash", name: "y", name_ar: "y", account_number: "1" })).status === 400);
  let rows = await cashRows();
  const bankRow = rows.find((x) => x.id === bank.id);
  check("…each has its own GL account (12xx / 11xx) at zero", /^12\d\d$/.test(bankRow?.glAccount.code) && /^11\d\d$/.test(rows.find((x) => x.id === box.id)?.glAccount.code) && bankRow.balance === "0.00", bankRow);
  const chart = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts as any[];
  check("…and the GL account sits under Assets, postable", chart.some((a) => a.id === bankRow.glAccount.id && a.parentId === "acc_1000" && a.postable));
  const formsView = (await call("mostafa", "GET", "/api/accounting/cash-accounts")).status;
  check("a role without money workflows cannot read the list (403)", formsView === 403);

  section("3. MONEY IN: capital to the main box, then a customer receipt into the new bank");
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} capital`, lines: [{ account_id: A("1100"), debit: 5000 }, { account_id: A("3100"), credit: 5000 }] });
  check("capital paid in (manual journal Dr cash / Cr capital)", r.status === 201, r.body);
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;
  r = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, cash_account_id: bank.id, amount: 300, method: "bank_transfer" });
  check("a receipt can land in the new bank at once", r.status === 201, r.body);
  check("…the bank shows 300", (await balanceOf(bank.id)) === 300);

  section("4. TRANSFER: cash → new bank");
  const plBefore = (await call("karim", "GET", `/api/accounting/pnl?from=${today}&to=${today}`)).body;
  const cashBefore = await balanceOf("cash_main");
  const key = `${TAG}-tr-1`;
  const body = { from_cash_account_id: "cash_main", to_cash_account_id: bank.id, amount: "1200", date: today, reference: "DEP-1", idempotency_key: key };
  r = await call("karim", "POST", "/api/accounting/transfers", body);
  check("transfer posted -> 201", r.status === 201 && r.body.transfer.status === "posted" && /^CT-\d{4}-\d{5}$/.test(r.body.transfer.number), r.body);
  const tr1 = r.body.transfer;
  const je = await journal(tr1.entry.id);
  check("…Dr bank 1200 / Cr cash 1200, nothing else", je.lines.length === 2 && net(je, bankRow.glAccount.code) === 1200 && net(je, "1100") === -1200, je.lines);
  check("…balances moved", (await balanceOf(bank.id)) === 1500 && (await balanceOf("cash_main")) === cashBefore - 1200);
  const plAfter = (await call("karim", "GET", `/api/accounting/pnl?from=${today}&to=${today}`)).body;
  check("…no revenue or expense from a transfer", plAfter.netIncome === plBefore.netIncome, [plBefore.netIncome, plAfter.netIncome]);
  r = await call("karim", "POST", "/api/accounting/transfers", body);
  check("the same submit again returns the same transfer (200, no second posting)", r.status === 200 && r.body.transfer.id === tr1.id, r.body);
  check("…bank still 1500", (await balanceOf(bank.id)) === 1500);
  check("the same key on a different transfer -> 409", (await call("karim", "POST", "/api/accounting/transfers", { ...body, amount: "1300" })).status === 409);
  check("from = to -> 400", (await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: bank.id, to_cash_account_id: bank.id, amount: 1 })).status === 400);
  check("zero or negative amount -> 400", (await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "cash_main", to_cash_account_id: bank.id, amount: "0" })).status === 400);
  r = await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: box.id, to_cash_account_id: bank.id, amount: "10" });
  check("an empty cash box cannot pay out (no negative cash) -> 409", r.status === 409, r.body);
  // Concurrency: two different transfers racing on the same small box — only what is there leaves.
  await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "cash_main", to_cash_account_id: box.id, amount: "100" });
  const race = await Promise.all([1, 2, 3].map((i) => call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: box.id, to_cash_account_id: bank.id, amount: "60", idempotency_key: `${TAG}-race-${i}` })));
  check("three racing transfers of 60 from a box holding 100: exactly one posts", race.filter((x) => x.status === 201).length === 1 && race.filter((x) => x.status === 409).length === 2, race.map((x) => x.status));
  check("…the box is left with 40, never below zero", (await balanceOf(box.id)) === 40);

  section("5. TRANSFER FEE (bank charges account)");
  const charges = (await call("karim", "POST", "/api/accounting/accounts", { code: code("64"), name: `${TAG} Bank charges`, name_ar: `${TAG} مصاريف بنك`, parent_id: "acc_6000" })).body.account;
  check("a fee without the bank charges account configured -> 400", (await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: bank.id, to_cash_account_id: "cash_main", amount: "100", fee: "5" })).status === 400);
  await setSetting("accounting.bank_charges_account", charges.code);
  check("a fee on a cash box -> 400", (await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "cash_main", to_cash_account_id: bank.id, amount: "100", fee: "5" })).status === 400);
  r = await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: bank.id, to_cash_account_id: "cash_main", amount: "100", fee: "5" });
  const feeJe = await journal(r.body.transfer?.entry?.id);
  check("bank → cash 100 with a 5 fee: Dr cash 100, Dr charges 5, Cr bank 105", r.status === 201 && net(feeJe, "1100") === 100 && net(feeJe, charges.code) === 5 && net(feeJe, bankRow.glAccount.code) === -105, feeJe?.lines);

  section("6. APPROVAL ABOVE THE THRESHOLD (a second person)");
  await setSetting("accounting.transfer_approval", true);
  await setSetting("accounting.transfer_approval_threshold", 500);
  r = await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "cash_main", to_cash_account_id: bank.id, amount: "100" });
  check("below the threshold posts at once", r.status === 201 && r.body.transfer.status === "posted");
  r = await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "cash_main", to_cash_account_id: bank.id, amount: "800" });
  check("800 above 500 waits for approval -> 202, no journal", r.status === 202 && r.body.transfer.status === "pending_approval" && !r.body.transfer.entry, r.body);
  const pendingTr = r.body.transfer;
  const bankMid = await balanceOf(bank.id);
  let approval = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === pendingTr.id);
  check("…it is in the approvals inbox", approval?.type === "accounting.cash_transfer", approval);
  check("the one who recorded it cannot approve it -> 403", (await call("karim", "POST", `/api/approvals/${approval.id}/decide`, { decision: "approve" })).status === 403);
  r = await call("admin", "POST", `/api/approvals/${approval.id}/decide`, { decision: "approve", expected_version: approval.version });
  check("someone else approves -> posted", r.status === 200 && (await call("karim", "GET", "/api/accounting/transfers?limit=5")).body.transfers.find((x: any) => x.id === pendingTr.id)?.status === "posted", r.body);
  check("…and only now the bank moved (+800)", (await balanceOf(bank.id)) === bankMid + 800);
  r = await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "cash_main", to_cash_account_id: bank.id, amount: "900" });
  approval = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === r.body.transfer.id);
  await call("admin", "POST", `/api/approvals/${approval.id}/decide`, { decision: "reject", comment: "مش مطلوب", expected_version: approval.version });
  const rejected = (await call("karim", "GET", "/api/accounting/transfers?limit=10")).body.transfers.find((x: any) => x.id === r.body.transfer.id);
  check("a rejected transfer posts nothing", rejected?.status === "rejected" && !rejected.entry && (await balanceOf(bank.id)) === bankMid + 800, rejected);
  await setSetting("accounting.transfer_approval", null);
  await setSetting("accounting.transfer_approval_threshold", null);

  section("7. REVERSAL");
  check("a reason is required -> 400", (await call("karim", "POST", `/api/accounting/transfers/${tr1.id}/reverse`, {})).status === 400);
  r = await call("karim", "POST", `/api/accounting/transfers/${tr1.id}/reverse`, { reason: "اتسجل غلط" });
  check("reversed -> 200 with the reversing entry", r.status === 200 && !!r.body.transfer.reversal, r.body);
  const revJe = (await call("karim", "GET", "/api/accounting/journals?source_type=cash_transfer_reversal")).body.journals.find((j: any) => j.description.includes(tr1.number));
  const rev = await journal(revJe?.id);
  check("…Dr cash 1200 / Cr bank 1200", net(rev, "1100") === 1200 && net(rev, bankRow.glAccount.code) === -1200, rev?.lines);
  check("a second reversal -> 409", (await call("karim", "POST", `/api/accounting/transfers/${tr1.id}/reverse`, { reason: "تاني" })).status === 409);

  section("8. RETIRING ACCOUNTS");
  rows = await cashRows();
  const bv = rows.find((x) => x.id === bank.id);
  check("a bank with money cannot be deactivated -> 409", (await call("karim", "PATCH", `/api/accounting/cash-accounts/${bank.id}`, { active: false, version: bv.version })).status === 409);
  const boxRow = rows.find((x) => x.id === box.id);
  await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: box.id, to_cash_account_id: "cash_main", amount: boxRow.balance });
  const boxNow = (await cashRows()).find((x) => x.id === box.id);
  r = await call("karim", "PATCH", `/api/accounting/cash-accounts/${box.id}`, { active: false, version: boxNow.version });
  check("an emptied cash box is deactivated", r.status === 200 && r.body.cashAccount.active === false, r.body);
  check("…and nothing can be received into it -> 400", (await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, cash_account_id: box.id, amount: 5, method: "cash" })).status === 400);
  check("…its GL account is retired with it", (await call("karim", "GET", "/api/accounting/accounts")).body.accounts.find((a: any) => a.id === boxNow.glAccount.id)?.active === false);
  check("…and it is gone from the forms' list", !(await call("karim", "GET", "/api/accounting/cash-accounts")).body.cashAccounts.some((x: any) => x.id === box.id));
  r = await call("karim", "PATCH", `/api/accounting/cash-accounts/${box.id}`, { active: true });
  check("reactivated", r.status === 200 && r.body.cashAccount.active === true);
  check("a stale version -> 409", (await call("karim", "PATCH", `/api/accounting/cash-accounts/${box.id}`, { name_ar: "x", version: 1 })).status === 409);

  section("9. ACCOUNTS: classification and retirement");
  const prepaid = (await call("karim", "POST", "/api/accounting/accounts", { code: code("18"), name: `${TAG} Prepaid rent`, name_ar: `${TAG} إيجار مقدم`, parent_id: "acc_1000" })).body.account;
  check("a new asset account inherits operating from Assets (not investing by type)", prepaid?.cashFlowCategory === "operating", prepaid);
  const loan = (await call("karim", "POST", "/api/accounting/accounts", { code: code("24"), name: `${TAG} Bank loan`, name_ar: `${TAG} قرض بنكي`, parent_id: "acc_2000", cash_flow_category: "financing" })).body.account;
  check("the accountant can classify a loan as financing", loan?.cashFlowCategory === "financing", loan);
  check("revenue/expense accounts take no classification -> 400", (await call("karim", "POST", "/api/accounting/accounts", { code: code("66"), name: "z", name_ar: "z", parent_id: "acc_6000", cash_flow_category: "operating" })).status === 400);
  check("fixed-asset accounts are not created by hand -> 400", (await call("karim", "POST", "/api/accounting/accounts", { code: code("17"), name: "z", name_ar: "z", parent_id: "acc_1700" })).status === 400);
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} rent prepaid`, lines: [{ account_id: prepaid.id, debit: 600 }, { account_id: A("1100"), credit: 600 }] });
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} loan`, lines: [{ account_id: A("1100"), debit: 2000 }, { account_id: loan.id, credit: 2000 }] });
  let cf = (await call("karim", "GET", `/api/management/cash-flow?from=${today}&to=${today}`)).body.report;
  const line = (sec: string, c: string) => cf.sections[sec].lines.find((l: any) => l.accountCode === c);
  check("cash flow: prepaid rent −600 in operating", n(line("operating", prepaid.code)?.amount) === -600, cf.sections.operating.lines);
  check("cash flow: the loan +2000 in financing", n(line("financing", loan.code)?.amount) === 2000, cf.sections.financing.lines);
  check("cash flow: the transfers net to nothing (both sides are cash) and the report balances", cf._balanced === true, [cf.netCashFlow, cf.cashTotal]);
  check("cash flow: the new bank is one of the cash accounts", cf.cashAccounts.some((c: any) => c.code === bankRow.glAccount.code), cf.cashAccounts.map((c: any) => c.code));
  r = await call("karim", "PATCH", `/api/accounting/accounts/${prepaid.id}`, { cash_flow_category: null });
  check("a non-system account can be set back to not classified", r.status === 200 && r.body.account.cashFlowCategory === null, r.body);
  cf = (await call("karim", "GET", `/api/management/cash-flow?from=${today}&to=${today}`)).body.report;
  check("…then it is flagged, shown under operating, and the report still balances", line("operating", prepaid.code)?.unclassified === true && cf.unclassified.some((u: any) => u.code === prepaid.code) && cf._balanced === true, cf.unclassified);
  await call("karim", "PATCH", `/api/accounting/accounts/${prepaid.id}`, { cash_flow_category: "operating" });
  check("a system account cannot lose its classification -> 400", (await call("karim", "PATCH", `/api/accounting/accounts/${A("1300")}`, { cash_flow_category: null })).status === 400);
  check("an account with a balance cannot be retired -> 409", (await call("karim", "PATCH", `/api/accounting/accounts/${prepaid.id}`, { active: false })).status === 409);
  check("a system account cannot be retired -> 400", (await call("karim", "PATCH", `/api/accounting/accounts/${A("6100")}`, { active: false })).status === 400);
  r = await call("karim", "PATCH", `/api/accounting/accounts/${loan.id}`, { name_ar: `${TAG} قرض البنك الأهلي` });
  check("rename -> 200", r.status === 200 && r.body.account.nameAr.endsWith("قرض البنك الأهلي"));

  section("10. CONTROL ACCOUNTS AND DATABASE GUARDS");
  for (const c of ["1500", "2200", "2250"]) {
    check(`manual journal on VAT account ${c} -> 400`, (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} vat`, lines: [{ account_id: A(c), debit: 1 }, { account_id: A("1100"), credit: 1 }] })).status === 400);
  }
  let refused = false;
  try { await db.$executeRawUnsafe(`UPDATE "CashTransfer" SET "amount" = 1 WHERE "id" = '${tr1.id}'`); } catch { refused = true; }
  check("DB: a transfer's amount cannot be edited", refused);
  refused = false;
  try { await db.$executeRawUnsafe(`DELETE FROM "CashTransfer" WHERE "id" = '${tr1.id}'`); } catch { refused = true; }
  check("DB: a transfer cannot be deleted", refused);
  refused = false;
  try { await db.$executeRawUnsafe(`UPDATE "CashTransfer" SET "reversalReason" = 'x' WHERE "id" = '${tr1.id}'`); } catch { refused = true; }
  check("DB: a reversal is recorded once", refused);
  const tb = (await call("karim", "GET", `/api/accounting/trial-balance?from=2000-01-01&to=2099-12-31`)).body;
  check("trial balance still balances", tb.trialBalance?.balanced === true);
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("integrity check: every check green (trial balance, traceability, AR/AP, inventory)", health?.ok === true, health?.checks?.filter((c: any) => !c.ok));

  await setSetting("accounting.bank_charges_account", null);
  await db.$disconnect();
  finish("TREASURY");
}

main().catch((e) => { console.error(e); process.exit(1); });
