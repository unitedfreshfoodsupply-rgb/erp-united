/* Settling a receipt or payment partly without cash: tax the customer withheld, a bank
   charge, an approved small difference — and tax we withheld from a supplier. The
   party's balance is settled by the full amount, the cash leg is the amount less the
   deductions, each deduction posts to the account the accountant configured, and a
   reversal brings every leg back. Settings are restored at the end so the suites that
   follow see the feature off, as shipped. */
import { call, login, makeChecker } from "./_harness";

const TAG = `ZZSETTLE-${Date.now()}`;
const { check, section, finish } = makeChecker();
const today = new Date().toISOString().slice(0, 10);
const n = (v: any) => Number(v ?? 0);
const code = (prefix: string) => `${prefix}${String(Date.now()).slice(-5)}`;
const SETTINGS = ["accounting.withholding_receivable_account", "accounting.withholding_payable_account", "accounting.bank_charges_account", "accounting.write_off_account", "accounting.write_off_limit"];

const setSetting = (key: string, value: unknown) => call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: `${TAG} اختبار` });
const journalOf = async (sourceType: string, number: string) => {
  const list = (await call("karim", "GET", `/api/accounting/journals?source_type=${sourceType}&limit=20`)).body.journals ?? [];
  const head = list.find((j: any) => String(j.description).includes(number));
  return head ? (await call("karim", "GET", `/api/accounting/journals/${head.id}`)).body.journal : null;
};
const net = (journal: any, accountCode: string) =>
  (journal?.lines ?? []).filter((l: any) => l.account.code === accountCode).reduce((s: number, l: any) => s + n(l.debit) - n(l.credit), 0);
const openOf = async (customerId: string) => (await call("karim", "GET", `/api/accounting/customers/${customerId}/open-invoices`)).body.invoices ?? [];

async function main() {
  section("0. SETUP");
  for (const u of ["admin", "karim", "mona", "omar", "ahmed"]) await login(u);
  const accounts = {
    whtIn: (await call("karim", "POST", "/api/accounting/accounts", { code: code("17"), name: `${TAG} WHT receivable`, name_ar: `${TAG} ضرائب خصم لنا`, parent_id: "acc_1000" })).body.account,
    whtOut: (await call("karim", "POST", "/api/accounting/accounts", { code: code("24"), name: `${TAG} WHT payable`, name_ar: `${TAG} ضرائب خصم علينا`, parent_id: "acc_2000" })).body.account,
    bank: (await call("karim", "POST", "/api/accounting/accounts", { code: code("64"), name: `${TAG} Bank charges`, name_ar: `${TAG} مصاريف بنك`, parent_id: "acc_6000" })).body.account,
    diff: (await call("karim", "POST", "/api/accounting/accounts", { code: code("65"), name: `${TAG} Differences`, name_ar: `${TAG} فروق تحصيل`, parent_id: "acc_6000" })).body.account,
  };
  check("four accounts created", Object.values(accounts).every((a: any) => !!a?.id), accounts);
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} فندق` })).body.customer;
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مزرعة` })).body.supplier;
  const ob = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: customer.id, date: today, amount: "1000", reference: `${TAG}-AR` });
  const ob2 = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: customer.id, date: today, amount: "500.50", reference: `${TAG}-AR2` });
  const obs = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "supplier", party_id: supplier.id, date: today, amount: "1000", reference: `${TAG}-AP` });
  check("open documents: customer 1,000 + 500.50, supplier 1,000", ob.status === 201 && ob2.status === 201 && obs.status === 201, [ob.status, ob2.status, obs.status]);

  section("1. OFF UNTIL CONFIGURED");
  const off = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, amount: "1000", method: "bank_transfer", cash_account_id: "bank_main", auto: true, deductions: [{ kind: "withholding", amount: "10" }] });
  check("withholding with no account configured -> 400", off.status === 400, off.body);
  check("…English message names what to configure", /accounting settings/.test((await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, amount: "1000", method: "cash", cash_account_id: "cash_main", deductions: [{ kind: "withholding", amount: "10" }] }, { "accept-language": "en" })).body.error ?? ""));
  check("a non-admin cannot configure it -> 403", (await call("karim", "PATCH", `/api/admin/settings/${SETTINGS[0]}`, { value: accounts.whtIn.code, reason: "x" })).status === 403);
  check("a mistyped account code is refused by the setting -> 400", (await setSetting(SETTINGS[0], "17 7")).status === 400);
  check("configure: withholding receivable / payable, bank charges, differences", (await Promise.all([
    setSetting("accounting.withholding_receivable_account", accounts.whtIn.code),
    setSetting("accounting.withholding_payable_account", accounts.whtOut.code),
    setSetting("accounting.bank_charges_account", accounts.bank.code),
    setSetting("accounting.write_off_account", accounts.diff.code),
  ])).every((r) => r.status === 200));

  section("2. RECEIPT NET OF WITHHOLDING AND A BANK CHARGE");
  const key = `${TAG}-r1`;
  const body = { party_id: customer.id, amount: "1000", method: "bank_transfer", cash_account_id: "bank_main", date: today, idempotency_key: key, allocations: [{ document_id: (await openOf(customer.id)).find((d: any) => n(d.open) === 1000)?.id, amount: "1000" }], deductions: [{ kind: "withholding", amount: "10", reference: "CERT-41-0001" }, { kind: "bank_charge", amount: "15" }] };
  const r1 = await call("karim", "POST", "/api/accounting/receipts", body);
  check("receipt 1,000 with withholding 10 and bank charge 15 -> 201", r1.status === 201, r1.body);
  const rc = r1.body.receipt;
  const j1 = await journalOf("customer_receipt", rc?.number);
  check("journal: Dr bank 975", net(j1, "1200") === 975, j1?.lines);
  check("journal: Dr withholding receivable 10", net(j1, accounts.whtIn.code) === 10);
  check("journal: Dr bank charges 15", net(j1, accounts.bank.code) === 15);
  check("journal: Cr customers 1,000 (the whole invoice settled)", net(j1, "1300") === -1000);
  check("the 1,000 document is no longer open", !(await openOf(customer.id)).some((d: any) => n(d.open) === 1000));
  const listed = (await call("karim", "GET", `/api/accounting/receipts?limit=50`)).body.receipts.find((x: any) => x.id === rc?.id);
  check("the list shows amount 1,000, cash 975 and both deductions", listed?.amount === "1000.00" && listed?.cashAmount === "975.00" && listed?.deductions?.length === 2, listed);
  check("same key, same submit -> the same receipt", (await call("karim", "POST", "/api/accounting/receipts", body)).body.receipt?.id === rc?.id);
  check("same key, different deductions -> 409", (await call("karim", "POST", "/api/accounting/receipts", { ...body, deductions: [{ kind: "withholding", amount: "11", reference: "CERT-41-0001" }] })).status === 409);
  const integ = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("Accounts Health still green (customers = GL 1300)", integ?.ok === true, integ?.checks?.filter((c: any) => !c.ok));

  section("3. REFUSALS");
  const base = { party_id: customer.id, amount: "500.50", method: "cash", cash_account_id: "cash_main" };
  check("deductions equal to the amount -> 400", (await call("karim", "POST", "/api/accounting/receipts", { ...base, deductions: [{ kind: "withholding", amount: "500.50" }] })).status === 400);
  check("the same kind twice -> 400", (await call("karim", "POST", "/api/accounting/receipts", { ...base, deductions: [{ kind: "bank_charge", amount: "1" }, { kind: "bank_charge", amount: "2" }] })).status === 400);
  check("an unknown kind -> 400", (await call("karim", "POST", "/api/accounting/receipts", { ...base, deductions: [{ kind: "gift", amount: "1" }] })).status === 400);
  check("a write-off while the limit is 0 -> 400", (await call("karim", "POST", "/api/accounting/receipts", { ...base, deductions: [{ kind: "write_off", amount: "0.50" }] })).status === 400);
  check("bank charges on a supplier payment -> 400", (await call("karim", "POST", "/api/accounting/payments", { party_id: supplier.id, amount: "100", method: "cash", cash_account_id: "cash_main", deductions: [{ kind: "bank_charge", amount: "1" }] })).status === 400);
  check("the floor cannot record a receipt at all -> 403", (await call("ahmed", "POST", "/api/accounting/receipts", { ...base, deductions: [{ kind: "withholding", amount: "1" }] })).status === 403);

  section("4. AN APPROVED SMALL DIFFERENCE");
  check("limit set to 1.00", (await setSetting("accounting.write_off_limit", 1)).status === 200);
  check("difference 1.50 above the limit -> 400", (await call("karim", "POST", "/api/accounting/receipts", { ...base, amount: "500.50", deductions: [{ kind: "write_off", amount: "1.50" }] })).status === 400);
  const r2 = await call("karim", "POST", "/api/accounting/receipts", { ...base, amount: "500.50", auto: true, deductions: [{ kind: "write_off", amount: "0.50" }] });
  check("customer pays 500 on 500.50; 0.50 allowed -> 201", r2.status === 201, r2.body);
  const j2 = await journalOf("customer_receipt", r2.body.receipt?.number);
  check("journal: Dr cash 500, Dr differences 0.50, Cr customers 500.50", net(j2, "1100") === 500 && net(j2, accounts.diff.code) === 0.5 && net(j2, "1300") === -500.5, j2?.lines);
  check("the customer owes nothing", (await openOf(customer.id)).length === 0, await openOf(customer.id));

  section("5. REVERSAL BRINGS EVERY LEG BACK");
  const rev = await call("karim", "POST", `/api/accounting/receipts/${rc?.id}/reverse`, { reason: `${TAG} شيك مرتد` });
  check("reverse the 1,000 receipt -> 201", rev.status === 201, rev.body);
  const jr = await journalOf("receipt_reversal", rc?.number);
  check("reversal: Cr bank 975, Cr withholding 10, Cr bank charges 15, Dr customers 1,000", net(jr, "1200") === -975 && net(jr, accounts.whtIn.code) === -10 && net(jr, accounts.bank.code) === -15 && net(jr, "1300") === 1000, jr?.lines);
  check("the 1,000 document is open again", (await openOf(customer.id)).some((d: any) => n(d.open) === 1000));

  section("6. TAX WE WITHHOLD FROM A SUPPLIER");
  const p1 = await call("karim", "POST", "/api/accounting/payments", { party_id: supplier.id, amount: "1000", method: "bank_transfer", cash_account_id: "bank_main", auto: true, deductions: [{ kind: "withholding", amount: "10", reference: "OUR-41-0001" }] });
  check("payment 1,000 withholding 10 -> 201", p1.status === 201, p1.body);
  const jp = await journalOf("supplier_payment", p1.body.payment?.number);
  check("journal: Dr suppliers 1,000, Cr bank 990, Cr withholding payable 10", net(jp, "2100") === 1000 && net(jp, "1200") === -990 && net(jp, accounts.whtOut.code) === -10, jp?.lines);
  check("the supplier is owed nothing", ((await call("karim", "GET", `/api/accounting/suppliers/${supplier.id}/open-bills`)).body.bills ?? []).length === 0);

  section("7. WITHHOLDING REPORT");
  const recv = (await call("karim", "GET", `/api/accounting/withholding?side=receivable&from=${today}&to=${today}`)).body.report;
  check("receivable report leaves out the reversed receipt", !recv?.rows?.some((r: any) => r.document === rc?.number), recv);
  const pay = (await call("karim", "GET", `/api/accounting/withholding?side=payable&from=${today}&to=${today}`)).body.report;
  const mine = pay?.rows?.find((r: any) => r.document === p1.body.payment?.number);
  check("payable report lists the payment with its certificate", mine?.amount === "10.00" && mine?.reference === "OUR-41-0001", pay);
  const csv = await fetch(`${process.env.BASE ?? "http://localhost:3111"}/api/accounting/withholding/export?side=payable&from=${today}&to=${today}`, { headers: { cookie: (await import("./_harness")).cookieFor("karim") } });
  check("CSV export downloads", csv.status === 200 && (await csv.text()).includes("OUR-41-0001"));
  check("the floor cannot read it -> 403", (await call("ahmed", "GET", "/api/accounting/withholding")).status === 403);
  check("an invalid period -> 400", (await call("karim", "GET", "/api/accounting/withholding?from=2026-13-01")).status === 400);

  section("8. SHIPPED DEFAULTS RESTORED");
  check("settings back to default (feature off)", (await Promise.all(SETTINGS.map((k) => setSetting(k, null)))).every((r) => r.status === 200));
  check("Accounts Health green at the end", (await call("karim", "GET", "/api/accounting/integrity")).body.integrity?.ok === true);
  finish("SETTLEMENT-DEDUCTIONS");
}

main().catch((e) => {
  console.error("SUITE CRASHED", e);
  process.exit(1);
});
