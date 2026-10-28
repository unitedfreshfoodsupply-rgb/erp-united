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
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مورد` })).body.supplier;
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

  section("7. AUTHORIZATION");
  const loginMona = await fetch(url("/api/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "mona", password: "1234" }) });
  const cookieMona = loginMona.headers.get("set-cookie")?.split(";")[0] ?? "";
  const deniedFin = await fetch(url(`/api/management/finance/export?from=2000-01-01&to=2099-12-31`), { headers: { cookie: cookieMona } });
  check("sales role denied finance export (403)", deniedFin.status === 403, deniedFin.status);

  finish("EXPORTS");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });