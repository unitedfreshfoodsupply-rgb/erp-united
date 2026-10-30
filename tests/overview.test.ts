// Management overview (/api/management/overview): permission, validation, and agreement
// with the reports it summarises — the dashboard must never show a figure the detailed
// screens would contradict.
import { call, login, makeChecker } from "./_harness";

const { check, section, finish } = makeChecker();
const n = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

async function main() {
  for (const u of ["admin", "karim", "ahmed", "mostafa", "mona", "hossam"]) await login(u);

  section("O1. WHO MAY SEE IT (reports.finance)");
  check("anonymous -> 401", (await call(null, "GET", "/api/management/overview")).status === 401);
  for (const u of ["ahmed", "mostafa", "hossam"]) {
    check(`${u} (no reports.finance) -> 403`, (await call(u, "GET", "/api/management/overview")).status === 403);
  }
  const admin = await call("admin", "GET", "/api/management/overview");
  check("admin -> 200", admin.status === 200, admin.status);
  const r = await call("karim", "GET", "/api/management/overview");
  check("accountant -> 200", r.status === 200, r.status);

  section("O2. VALIDATION");
  check("from after to -> 400", (await call("karim", "GET", "/api/management/overview?from=2026-10-10&to=2026-10-01")).status === 400);
  check("bad date -> 400", (await call("karim", "GET", "/api/management/overview?from=2026-13-01&to=2026-12-31")).status === 400);
  check("over 400 days -> 400", (await call("karim", "GET", "/api/management/overview?from=2024-01-01&to=2026-01-01")).status === 400);

  section("O3. THE FIGURES AGREE WITH THE DETAILED REPORTS");
  const o = r.body;
  check("weekly series cover the period, Saturday-based weeks", o.weekly.length >= 12 && o.weekly.every((w: { week: string }) => new Date(`${w.week}T00:00:00Z`).getUTCDay() === 6), o.weekly.map((w: { week: string }) => w.week));
  const weeklySales = o.weekly.reduce((s: number, w: { sales: string }) => s + n(w.sales), 0);
  const weeklyPurchases = o.weekly.reduce((s: number, w: { purchases: string }) => s + n(w.purchases), 0);
  check("weekly net sales add up to the headline", near(weeklySales, n(o.headline.current.sales)), [weeklySales, o.headline.current.sales]);
  check("weekly net purchases add up to the headline", near(weeklyPurchases, n(o.headline.current.purchases)), [weeklyPurchases, o.headline.current.purchases]);
  const fin = await call("karim", "GET", `/api/management/finance?from=${o.from}&to=${o.to}`);
  check("net sales = the management report's revenue for the same period", fin.status === 200 && near(n(o.headline.current.sales), n(fin.body.report.sales.revenue)), [o.headline.current.sales, fin.body.report?.sales?.revenue]);
  const ar = await call("karim", "GET", `/api/sales/reports/aging?as_of=${o.to}`);
  check("receivables = the sales aging report", ar.status === 200 && near(n(o.receivables.total), n(ar.body.totals.total)), [o.receivables.total, ar.body.totals?.total]);
  const ap = await call("karim", "GET", `/api/purchasing/reports/ap-aging?as_of=${o.to}`);
  check("payables = the purchasing aging report", ap.status === 200 && near(n(o.payables.total), n(ap.body.aging.totals.total)), [o.payables.total, ap.body.aging?.totals?.total]);
  for (const side of ["receivables", "payables"] as const) {
    const a = o[side];
    const buckets = a.buckets.reduce((s: number, b: { amount: string }) => s + n(b.amount), 0);
    check(`${side}: buckets less money on account = the total`, near(buckets - n(a.onAccount), n(a.total)), [buckets, a.onAccount, a.total]);
  }
  check("top customers are sorted and at most 8", o.topCustomers.length <= 8 && o.topCustomers.every((c: { net: string }, i: number, a: { net: string }[]) => i === 0 || n(a[i - 1].net) >= n(c.net)));
  const prev = await call("karim", "GET", `/api/management/overview?from=${o.previous.from}&to=${o.previous.to}`);
  check("the comparison period's headline equals that period's own overview", prev.status === 200 && near(n(prev.body.headline.current.sales), n(o.headline.previous.sales)), [prev.body?.headline?.current?.sales, o.headline.previous.sales]);

  finish("MANAGEMENT OVERVIEW");
}

main().catch((e) => { console.error(e); process.exit(1); });
