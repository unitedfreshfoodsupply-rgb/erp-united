// Home dashboard (/api/home): who may open it, that each section appears only with its
// permission (no figure leaks to a role that cannot open the screen behind it), and that the
// figures agree with the screens they summarise.
import { call, login, makeChecker, page } from "./_harness";

const { check, section, finish } = makeChecker();
const n = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

async function main() {
  for (const u of ["admin", "karim", "ahmed", "mostafa", "mona", "hossam", "sara"]) await login(u);

  section("H1. WHO MAY OPEN IT");
  check("anonymous API -> 401", (await call(null, "GET", "/api/home")).status === 401);
  for (const u of ["ahmed", "mostafa"]) check(`floor role ${u} -> 403`, (await call(u, "GET", "/api/home")).status === 403);
  for (const u of ["admin", "karim", "mona", "hossam", "sara"]) check(`${u} -> 200`, (await call(u, "GET", "/api/home")).status === 200);
  const anonPage = await page(null, "/home");
  check("anonymous page is sent to /login", [302, 307].includes(anonPage.status) && (anonPage.location ?? "").includes("/login"), anonPage.status);

  section("H2. SECTIONS FOLLOW PERMISSIONS");
  const mona = (await call("mona", "GET", "/api/home")).body;
  check("sales: operations shown (orders.view)", !!mona.operations);
  check("sales: no finance figures (no reports.finance)", mona.sales === undefined && mona.receivables === undefined);
  check("sales: no stock figures (no stock.view)", mona.stock === undefined);
  const hossam = (await call("hossam", "GET", "/api/home")).body;
  check("stock controller: stock shown, no finance or operations", !!hossam.stock && hossam.sales === undefined && hossam.receivables === undefined && hossam.operations === undefined);
  check("stock controller: no invoice or approval actions it cannot act on", !hossam.actions.some((a: { key: string }) => ["draft-invoices", "orders-to-invoice", "eta-pending", "orders-review"].includes(a.key)));
  const karim = (await call("karim", "GET", "/api/home")).body;
  check("accountant: finance, receivables, stock and operations shown", !!karim.sales && !!karim.receivables && !!karim.stock && !!karim.operations);
  check("every action links inside the app and has a positive count", [mona, hossam, karim].every((h) => h.actions.every((a: { href: string; count: number }) => a.href.startsWith("/") && a.count > 0)));

  section("H3. FIGURES AGREE WITH THE DETAILED SCREENS");
  const today: string = karim.today;
  const ov = (await call("karim", "GET", `/api/management/overview?from=${today.slice(0, 7)}-01&to=${today}`)).body;
  check("month-to-date net sales = the overview for the same dates", near(n(karim.sales.monthToDate), n(ov.headline.current.sales)), [karim.sales.monthToDate, ov.headline.current.sales]);
  check("collected = the overview for the same dates", near(n(karim.sales.collected), n(ov.headline.current.collected)), [karim.sales.collected, ov.headline.current.collected]);
  const ar = (await call("karim", "GET", `/api/sales/reports/aging?as_of=${today}`)).body;
  check("receivables = the aging report", near(n(karim.receivables.total), n(ar.totals.total)), [karim.receivables.total, ar.totals?.total]);
  const sup = (await call("sara", "GET", "/api/supervisor/intelligence")).body;
  const open = (sup.orders as { status: string }[]).filter((o) => ["new", "preparing", "ready_for_loading", "loading", "loaded"].includes(o.status)).length;
  const sara = (await call("sara", "GET", "/api/home")).body;
  check("open orders = the open orders on the command center", sara.operations.open === open, [sara.operations.open, open]);

  finish("HOME DASHBOARD");
}

main().catch((e) => { console.error(e); process.exit(1); });
