/* REPORT EXPORTS — CSV downloads mirror their JSON views (same permission, same
   data), carry a UTF-8 BOM for Excel, and are denied to unauthorized roles. */
import { call, login, makeChecker } from "./_harness";

const { check, section, finish } = makeChecker();
const TAG = `ZZEXP${Date.now() % 1_000_000_000}`;

async function hasBom(res: Response): Promise<boolean> {
  // UTF-8 encodes U+FEFF as three bytes EF BB BF; text() would strip them.
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

async function main() {
  for (const u of ["admin", "karim", "mona", "omar", "hossam"]) await login(u);

  section("1. FIXTURES");
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} مورد` })).body.supplier;
  check("fixtures ready", !!customer?.id && !!supplier?.id);

  section("2. EXPORTS REQUIRE THE VIEW PERMISSION");
  // hossam (stock) cannot view customer statements for export; karim (finance) can.
  const denied = await fetch(`${process.env.BASE ?? "http://localhost:3111"}/api/sales/customers/${customer.id}/statement/export`);
  check("unauthenticated request refused (401)", denied.status === 401, denied.status);

  section("3. CUSTOMER STATEMENT CSV");
  const url = (p: string) => `${process.env.BASE ?? "http://localhost:3111"}${p}`;
  const loginBody = await fetch(url("/api/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "karim", password: "1234" }) });
  const cookie = loginBody.headers.get("set-cookie")?.split(";")[0] ?? "";
  const res = await fetch(url(`/api/sales/customers/${customer.id}/statement/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie } });
  const text = await res.text();
  check("customer export 200", res.status === 200, res.status);
  check("UTF-8 BOM for Excel", await hasBom(await fetch(url(`/api/sales/customers/${customer.id}/statement/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie } })));
  check("CSV content-type", (res.headers.get("content-type") ?? "").includes("text/csv"));
  check("attachment filename", (res.headers.get("content-disposition") ?? "").includes("attachment"));
  check("header row present", text.includes("كشف حساب"));
  check("closing balance row present", text.includes("الرصيد الختامي"));

  section("4. SUPPLIER STATEMENT CSV");
  const sup = await fetch(url(`/api/purchasing/suppliers/${supplier.id}/statement/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie } });
  check("supplier export 200", sup.status === 200, sup.status);
  check("supplier BOM", await hasBom(sup));

  section("5. MANAGEMENT FINANCE CSV");
  const fin = await fetch(url(`/api/management/finance/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie } });
  check("finance report export 200", fin.status === 200, fin.status);
  check("finance BOM", await hasBom(fin));
  // The receivables/payables summary rows carry the aging totals (they were blank: the
  // export read a `balance` field the aging report does not have).
  const finJson = await (await fetch(url(`/api/management/finance?from=2000-01-01&to=2099-12-31`), { headers: { cookie } })).json();
  const finText = await (await fetch(url(`/api/management/finance/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie } })).text();
  const rowAmount = (label: string) => finText.split("\r\n").find((l) => l.startsWith(label))?.split(",")[1] ?? null;
  check("finance CSV receivables total = aging total", rowAmount("عملاء (كبار)") === finJson.report.receivables.totals.total, `${rowAmount("عملاء (كبار)")} vs ${finJson.report.receivables.totals.total}`);
  check("finance CSV payables total = aging total", rowAmount("موردون (كبار)") === finJson.report.payables.totals.total, `${rowAmount("موردون (كبار)")} vs ${finJson.report.payables.totals.total}`);

  section("6. VALUATION CSV");
  const val = await fetch(url(`/api/inventory/reports/valuation/export`), { headers: { cookie } });
  check("valuation export 200", val.status === 200, val.status);
  check("valuation BOM", await hasBom(val));
  const valText = await (await fetch(url(`/api/inventory/reports/valuation/export`), { headers: { cookie } })).text();
  check("valuation total row", valText.includes("قيمة المخزون") || valText.includes("inventory"), "");

  section("6b. EXPORT LANGUAGE (?lang=en; Arabic stays the default)");
  const enStmt = await (await fetch(url(`/api/sales/customers/${customer.id}/statement/export?from=2000-01-01&to=2099-12-31&lang=en`), { headers: { cookie } })).text();
  check("English statement: English titles", enStmt.includes("Statement of account") && enStmt.includes("Closing balance") && enStmt.split("\r\n")[0].includes("Balance"));
  check("English statement: no Arabic fixed labels", !enStmt.includes("الرصيد الختامي") && !enStmt.includes("كشف حساب"));
  // A receipt gives the statement a system-written reference ("تحصيل · <typed reference>").
  const rc = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, amount: "10", method: "cash", cash_account_id: "cash_main", reference: `${TAG}-CHQ`, idempotency_key: `${TAG}-rc` });
  check("receipt for the statement fixture", rc.status === 200 || rc.status === 201, rc.status);
  const enRows = await (await fetch(url(`/api/sales/customers/${customer.id}/statement/export?from=2000-01-01&to=2099-12-31&lang=en`), { headers: { cookie } })).text();
  check("English statement: system reference reads in English, typed reference as stored", enRows.includes(`Receipt · ${TAG}-CHQ`) && !enRows.includes("تحصيل"));
  const legacyRows = await (await fetch(url(`/api/sales/customers/${customer.id}/statement/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie } })).text();
  check("default statement export keeps the stored reference", legacyRows.includes(`تحصيل · ${TAG}-CHQ`));
  check("default statement export keeps the line kind as its code", legacyRows.split("\r\n").some((l) => l.split(",")[1] === "receipt"));
  // Names come from the card in the export's language (customers and suppliers with both names).
  const cust2 = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Nile Hotel`, name_ar: `${TAG} فندق النيل` })).body.customer;
  const sup2 = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} Delta Farms`, name_ar: `${TAG} مزارع الدلتا` })).body.supplier;
  const firstRow = async (path: string) => (await (await fetch(url(path), { headers: { cookie } })).text()).replace(/^\uFEFF/, "").split("\r\n")[1] ?? "";
  const stmt = (kind: "customers" | "suppliers", id: string, l: string) => `/api/${kind === "customers" ? "sales" : "purchasing"}/${kind}/${id}/statement/export?from=2000-01-01&to=2099-12-31&lang=${l}`;
  check("English customer statement: the English name", (await firstRow(stmt("customers", cust2.id, "en"))).includes(`${TAG} Nile Hotel`));
  check("Arabic customer statement: the Arabic name", (await firstRow(stmt("customers", cust2.id, "ar"))).includes(`${TAG} فندق النيل`));
  check("English supplier statement: the English name", (await firstRow(stmt("suppliers", sup2.id, "en"))).includes(`${TAG} Delta Farms`));
  check("Arabic supplier statement: the Arabic name", (await firstRow(stmt("suppliers", sup2.id, "ar"))).includes(`${TAG} مزارع الدلتا`));
  const arStmt = await (await fetch(url(`/api/sales/customers/${customer.id}/statement/export?from=2000-01-01&to=2099-12-31&lang=ar`), { headers: { cookie } })).text();
  check("Arabic statement (?lang=ar): Arabic column titles", arStmt.split("\r\n")[0].includes("الرصيد"));
  // Without ?lang every export writes exactly what it wrote before this phase: machine keys
  // as the header row (integrations parse these files), values as stored.
  const head = (t: string) => t.replace(/^\uFEFF/, "").split("\r\n")[0];
  const legacy: [string, string][] = [
    [`/api/sales/customers/${customer.id}/statement/export?from=2000-01-01&to=2099-12-31`, "date,kind,number,reference,debit,credit,balance"],
    [`/api/purchasing/suppliers/${supplier.id}/statement/export?from=2000-01-01&to=2099-12-31`, "date,kind,number,reference,debit,credit,balance"],
    [`/api/accounting/vat-summary/export?from=2000-01-01&to=2099-12-31`, "section,output,input,diff"],
    [`/api/accounting/withholding/export?side=receivable&from=2000-01-01&to=2099-12-31`, "date,document,party_code,party_name,document_amount,withheld,certificate,account"],
    [`/api/inventory/reports/valuation/export`, "product,unit,quantity,value,averageCost"],
    [`/api/management/finance/export?from=2000-01-01&to=2099-12-31`, "section,amount,extra"],
  ];
  for (const [path, keys] of legacy) {
    const r = await fetch(url(path), { headers: { cookie } });
    const body = await r.text();
    // A withholding report with no rows writes only its total row; its header is still the keys.
    check(`default export unchanged: ${path.split("?")[0]}`, r.status === 200 && head(body) === keys, `${r.status} ${head(body).slice(0, 80)}`);
  }
  const enFin = await (await fetch(url(`/api/management/finance/export?from=2000-01-01&to=2099-12-31&lang=en`), { headers: { cookie } })).text();
  // Read both languages now (section 5's file predates the receipt posted above).
  const arFin = await (await fetch(url(`/api/management/finance/export?from=2000-01-01&to=2099-12-31&lang=ar`), { headers: { cookie } })).text();
  const total = (text: string, label: string) => text.split("\r\n").find((l) => l.startsWith(label))?.split(",")[1] ?? null;
  check("English finance: same receivables total as Arabic", total(enFin, "Customers (largest)") !== null && total(enFin, "Customers (largest)") === total(arFin, "عملاء (كبار)"), `${total(enFin, "Customers (largest)")} vs ${total(arFin, "عملاء (كبار)")}`);
  const enVal = await (await fetch(url(`/api/inventory/reports/valuation/export?lang=en`), { headers: { cookie } })).text();
  check("English valuation: English total row and titles", enVal.includes("Inventory value") && enVal.split("\r\n")[0].includes("Average cost"));

  section("7. AUTHORIZATION");
  const loginMona = await fetch(url("/api/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "mona", password: "1234" }) });
  const cookieMona = loginMona.headers.get("set-cookie")?.split(";")[0] ?? "";
  const deniedFin = await fetch(url(`/api/management/finance/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie: cookieMona } });
  check("sales role denied finance export (403)", deniedFin.status === 403, deniedFin.status);

  finish("EXPORTS");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });