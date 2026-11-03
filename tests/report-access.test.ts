/* REPORT ACCESS OVER HTTP — every report and export, as every role (the 8 seeded users and an
   ACCOUNTING_CLERK created here), checked against the report's own permission list and the
   user's effective permissions (/api/auth/me): the catalogue lists exactly what the user may
   run (a report that opens another screen, only when they can open that screen), a run or
   export they may not is a 403, cost columns appear only with stock.valuation.view, and every
   screen the catalogue or a report row links to opens for the user. Management routes, the
   report pages and the Command Center too. */
import { call, login, makeChecker, page } from "./_harness";
import { taxNo } from "./_stock";
import { todayBiz } from "./_days";
import { REPORTS } from "@/lib/reports/definitions";
import { REPORT_PAGE_PERMISSIONS } from "@/lib/nav";
import { mayOpenLink, pageOf } from "@/lib/reports/page-access";

const { check, section, finish } = makeChecker();
const TAG = `ZZRA${Date.now() % 1_000_000_000}`;
const DENIED_PAGE = "مالكش صلاحية للصفحة دي";
const SEEDED = ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"];
const PERIOD = "from=2000-01-01&to=2099-12-31";
const BASE = process.env.BASE ?? "http://localhost:3111";
/** The reports each role's default permissions open, pinned: widening a report's permissions must fail here first.
 *  ACCOUNTING_CLERK 16 → 14 (UI/UX findings 20, 34): "ap-aging" and "supplier-statement" open /purchasing, whose page
 *  needs purchasing.orders.view, which the clerk does not hold — they were listed and opened "access denied".
 *  No other role's list changes: "balance-sheet" now opens /accounting?tab=analysis under accounting.view instead of
 *  /management under reports.finance, and every default role holds both of those or neither. */
const PINNED: Record<string, string[] | "ALL"> = {
  SUPER_ADMIN: "ALL",
  SUPERVISOR: ["cogs-by-product","po-outstanding","supplier-performance","stock-by-product","stock-by-category","stock-by-lot","stock-movements","inventory-valuation","stock-aging","goods-received","waste-trend","adjustments","expiry","low-stock","reservations","order-lifecycle","delayed-orders","shortages","floor-activity","dispatch-activity","exceptions"],
  STOCK_CONTROLLER: ["po-outstanding","supplier-performance","stock-by-product","stock-by-lot","stock-movements","stock-aging","goods-received","waste-trend","expiry","low-stock","reservations","exceptions"],
  PREPARER: [],
  LOADER: [],
  SALES: ["ar-aging","customer-statement","sales-by-period","sales-by-customer","sales-by-product","sales-by-category","sales-by-salesperson","price-exceptions","credit-notes","outstanding-invoices"],
  ACCOUNTANT: ["trial-balance","profit-loss","balance-sheet","cash-flow","general-ledger","journal-entries","cash-movements","cogs-by-product","ppv","ar-aging","ap-aging","customer-statement","supplier-statement","bank-reconciliation","tax-summary","integrity","sales-by-period","sales-by-customer","sales-by-product","sales-by-category","sales-by-salesperson","price-exceptions","credit-notes","outstanding-invoices","purchases-by-supplier","purchases-by-product","purchase-price-trend","po-outstanding","supplier-performance","stock-by-product","stock-by-category","stock-by-lot","stock-movements","inventory-valuation","stock-aging","goods-received","waste-trend","adjustments","expiry","low-stock","reservations","inventory-reconciliation","floor-activity","exceptions"],
  PURCHASER: ["ap-aging","supplier-statement","purchases-by-supplier","purchases-by-product","purchase-price-trend","po-outstanding","supplier-performance","stock-by-product","stock-by-lot","stock-movements","stock-aging","goods-received","waste-trend","expiry","low-stock","reservations","exceptions"],
  ACCOUNTING_CLERK: ["ar-aging","customer-statement","sales-by-period","sales-by-customer","sales-by-product","sales-by-category","sales-by-salesperson","price-exceptions","credit-notes","outstanding-invoices","purchases-by-supplier","purchases-by-product","purchase-price-trend","supplier-performance"],
};

async function main() {
  for (const u of SEEDED) await login(u);
  const clerk = `${TAG.toLowerCase()}_clerk`; // usernames are stored in lower case
  const created = await call("admin", "POST", "/api/admin/users", { name: `${TAG} Clerk`, username: clerk, password: "longenoughpw", role: "ACCOUNTING_CLERK" });
  check("an accounting clerk is created for the run", created.status === 200 || created.status === 201, [created.status, created.body?.error]);
  check("the clerk signs in", (await login(clerk, "longenoughpw")).status === 200);
  const users = [...SEEDED, clerk];

  const perms: Record<string, Set<string>> = {};
  const roles: Record<string, string> = {};
  for (const u of users) {
    const me = (await call(u, "GET", "/api/auth/me")).body?.user;
    perms[u] = new Set<string>(me?.permissions ?? []);
    roles[u] = me?.role ?? "?";
  }
  check("every user has a role and permissions", users.every((u) => perms[u].size > 0), users.map((u) => `${u}:${roles[u]}:${perms[u].size}`));
  check("the clerk is an ACCOUNTING_CLERK", roles[clerk] === "ACCOUNTING_CLERK", roles[clerk]);
  const may = (u: string, list: readonly string[]) => list.some((p) => perms[u].has(p));

  section("0. DATA: a receipt and an invoiced sale of the run's own, so the cost checks never pass on empty reports");
  const today = todayBiz();
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const prod = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} طماطم`, unit: "KG" })).body.product;
  const cust = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل`, tax_registration_no: taxNo() })).body.customer;
  const rc = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup?.id, product_id: prod?.id, received_date: today, received_kg: 200, unit_cost: "5" });
  check("a receipt of the run: 200 kg at 5", rc.status === 201, [rc.status, rc.body?.error]);
  const ord = (await call("mona", "POST", "/api/orders", { customer_account_id: cust?.id, customer_name: cust?.name, delivery_date: today, items: [{ stock_product_id: prod?.id, product_name: prod?.name, quantity: 50 }] })).body.order;
  const item = ord?.items?.[0]?.id;
  await call("mona", "PATCH", `/api/orders/${ord?.id}/items/${item}/price`, { unit_price: "9", reason: "قائمة" });
  await call("ahmed", "POST", `/api/orders/${ord?.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${ord?.id}/items/${item}/prepare`, { quantity: 50, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${ord?.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/items/${item}/load`, { quantity: 50, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/status`, { to: "loaded" });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 });
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: ord?.id })).body.invoice;
  const issued = await call("karim", "POST", `/api/sales/invoices/${inv?.id}/issue`, {});
  check("an invoiced sale of the run: 50 kg at 9", issued.status === 200 && issued.body?.invoice?.status === "issued", [issued.status, issued.body?.error]);

  section("1. ANONYMOUS: every report endpoint is 401");
  for (const path of ["/api/reports", "/api/reports/sales-by-customer", "/api/reports/sales-by-customer/export?format=csv", "/api/management/command-center"]) {
    const r = await fetch(BASE + path);
    check(`anonymous ${path} → 401`, r.status === 401, r.status);
  }

  section("2. CATALOGUE: exactly the reports each role may open");
  for (const u of users) {
    const listed = new Set<string>(((await call(u, "GET", "/api/reports")).body?.reports ?? []).map((r: { key: string }) => r.key));
    const expected = REPORTS.filter((r) => may(u, r.permissions) && (!r.href || mayOpenLink(r.href, (p) => perms[u].has(p)))).map((r) => r.key);
    const extra = [...listed].filter((k) => !expected.includes(k));
    const missing = expected.filter((k) => !listed.has(k));
    check(`${roles[u]} (${u}): catalogue = permitted reports (${expected.length})`, extra.length === 0 && missing.length === 0, { extra, missing });
    const pin = PINNED[roles[u]];
    const pinned = pin === "ALL" ? REPORTS.map((r) => r.key) : pin ?? [];
    check(`${roles[u]} (${u}): catalogue = the pinned list for the role`, pinned.length === listed.size && pinned.every((k) => listed.has(k)), { notPinned: [...listed].filter((k) => !pinned.includes(k)), notListed: pinned.filter((k) => !listed.has(k)) });
  }

  section("3. RUN AND EXPORT: 200 for permitted reports, 403 otherwise (CSV and Excel)");
  const runnable = REPORTS.filter((r) => r.run);
  // One drill-down link per target (a page, or another report) found in each user's rows — opened in section 7.
  const linkKey = (href: string) => { const path = new URL(href, BASE).pathname; return path.startsWith("/reports/") ? path : pageOf(path) ?? path; };
  const drill: Record<string, Map<string, string>> = {};
  for (const u of users) {
    const wrong: string[] = [];
    drill[u] = new Map();
    for (const r of runnable) {
      const allowed = may(u, r.permissions);
      const run = await call(u, "GET", `/api/reports/${r.key}?${PERIOD}`);
      if (run.status !== (allowed ? 200 : 403)) wrong.push(`${r.key} run ${run.status}`);
      if (allowed && !Array.isArray(run.body?.rows)) wrong.push(`${r.key} run has no rows array`);
      if (allowed) for (const row of run.body?.rows ?? []) if (typeof row._href === "string" && !drill[u].has(linkKey(row._href))) drill[u].set(linkKey(row._href), row._href);
      for (const format of ["csv", "xls"]) {
        const ex = await call(u, "GET", `/api/reports/${r.key}/export?${PERIOD}&format=${format}&lang=en`);
        if (ex.status !== (allowed ? 200 : 403)) wrong.push(`${r.key} ${format} ${ex.status}`);
      }
    }
    check(`${roles[u]} (${u}): every run and export answers as its permission says`, wrong.length === 0, wrong.slice(0, 10));
  }
  for (const r of REPORTS.filter((x) => !x.run)) {
    const res = await call("admin", "GET", `/api/reports/${r.key}`);
    check(`linked report ${r.key}: no data through the report API (404), its screen applies its own gate`, res.status === 404, res.status);
  }

  section("4. COST COLUMNS: only with stock.valuation.view (screen data and exports)");
  const costCols: Record<string, string[]> = {};
  for (const r of runnable) {
    const cols = typeof r.columns === "function" ? r.columns({ groupBy: "month" } as never) : r.columns;
    const c = cols.filter((x) => x.cost).map((x) => x.key);
    if (c.length) costCols[r.key] = c;
  }
  check("cost columns are declared on the stock and sales reports", Object.keys(costCols).length >= 7, Object.keys(costCols));
  // Not vacuous: the cost reports have rows to leak from (section 0 received, sold and invoiced).
  for (const key of ["stock-by-product", "goods-received", "waste-trend", "sales-by-customer", "sales-by-product", "sales-by-category"]) {
    const rows = (await call("admin", "GET", `/api/reports/${key}?${PERIOD}`)).body?.rows ?? [];
    check(`${key} has rows to check (${rows.length})`, rows.length > 0);
  }
  for (const u of users) {
    const leaks: string[] = [];
    for (const [key, cols] of Object.entries(costCols)) {
      const def = REPORTS.find((r) => r.key === key)!;
      if (!may(u, def.permissions)) continue;
      const seesCost = perms[u].has("stock.valuation.view");
      const body = (await call(u, "GET", `/api/reports/${key}?${PERIOD}`)).body;
      const keys = new Set<string>((body?.columns ?? []).map((c: { key: string }) => c.key));
      for (const c of cols) {
        if (keys.has(c) !== seesCost) leaks.push(`${key}.${c} column ${keys.has(c) ? "shown" : "hidden"}`);
        if (!seesCost && (body?.rows ?? []).some((row: Record<string, unknown>) => c in row)) leaks.push(`${key}.${c} in rows`);
        if (!seesCost && body?.totals && c in body.totals) leaks.push(`${key}.${c} in totals`);
      }
      if (!seesCost) {
        const ex = await call(u, "GET", `/api/reports/${key}/export?${PERIOD}&format=csv&lang=en`);
        const header = String(ex.body ?? "").replace(/^﻿/, "").split("\r\n")[0] ?? "";
        const labels = (typeof def.columns === "function" ? def.columns({ groupBy: "month" } as never) : def.columns).filter((c) => c.cost).map((c) => c.label.en);
        for (const l of labels) if (header.split(",").includes(l)) leaks.push(`${key} export header has ${l}`);
      }
    }
    check(`${roles[u]} (${u}): cost columns ${perms[u].has("stock.valuation.view") ? "shown" : "absent"} as the permission says`, leaks.length === 0, leaks.slice(0, 10));
  }

  section("5. MANAGEMENT AND OTHER REPORT-LIKE ROUTES");
  const gated: [string, readonly string[]][] = [
    ["/api/management/command-center", ["reports.finance", "reports.view"]],
    [`/api/management/finance?${PERIOD}`, ["reports.finance"]],
    [`/api/management/finance/export?${PERIOD}`, ["reports.finance"]],
    [`/api/management/cash-flow?${PERIOD}`, ["reports.finance"]],
    [`/api/management/overview`, ["reports.finance"]],
    [`/api/management/operations?${PERIOD}`, ["reports.view"]],
    ["/api/inventory/reports/valuation", ["stock.valuation.view"]],
    ["/api/inventory/reports/valuation/export", ["stock.valuation.view"]],
    ["/api/inventory/reports/expiring", ["stock.view"]],
    [`/api/accounting/vat-summary?${PERIOD}`, ["accounting.view"]],
    [`/api/accounting/vat-summary/export?${PERIOD}`, ["accounting.view"]],
    [`/api/accounting/withholding?side=receivable&${PERIOD}`, ["accounting.view"]],
    [`/api/accounting/withholding/export?side=receivable&${PERIOD}`, ["accounting.view"]],
  ];
  for (const u of users) {
    const wrong: string[] = [];
    for (const [path, need] of gated) {
      const r = await call(u, "GET", path);
      const want = may(u, need) ? 200 : 403;
      if (r.status !== want) wrong.push(`${path.split("?")[0]} ${r.status}≠${want}`);
    }
    check(`${roles[u]} (${u}): management and report-like routes answer as their gate says`, wrong.length === 0, wrong);
  }
  // The Command Center computes and returns only the sections a viewer may see.
  for (const u of users.filter((x) => may(x, ["reports.finance", "reports.view"]))) {
    const cc = (await call(u, "GET", "/api/management/command-center")).body ?? {};
    const finance = perms[u].has("reports.finance");
    const leaks = ["profit", "purchases", "receivables", "payables", "cash", "upcomingPayments"].filter((k) => (k in cc) !== finance);
    if (cc.inventory && !perms[u].has("stock.valuation.view") && cc.inventory.value !== null) leaks.push("inventory.value");
    check(`${roles[u]} (${u}): Command Center sections match the permissions`, leaks.length === 0, leaks);
  }

  section("6. PAGES: /reports, a report page and the Command Center open exactly for the permitted roles");
  const pages: [string, readonly string[]][] = [
    ["/reports", REPORT_PAGE_PERMISSIONS],
    ["/reports/sales-by-customer", REPORT_PAGE_PERMISSIONS],
    ["/management/command-center", ["reports.finance", "reports.view"]],
  ];
  for (const u of users) {
    const wrong: string[] = [];
    for (const [path, need] of pages) {
      const p = await page(u, path);
      const denied = p.status === 200 && p.html.includes(DENIED_PAGE);
      const opened = p.status === 200 && !denied;
      if (opened !== may(u, need)) wrong.push(`${path}: ${opened ? "opened" : `refused (${p.status})`}`);
    }
    check(`${roles[u]} (${u}): report pages open only with a report permission`, wrong.length === 0, wrong);
  }

  section("7. LINKS: every screen the catalogue and the report rows link to opens for the user (no access-denied dead ends)");
  check("some drill-down links were collected", Object.values(drill).some((m) => m.size > 0), Object.fromEntries(Object.entries(drill).map(([u, m]) => [u, m.size])));
  for (const u of users) {
    const wrong: string[] = [];
    const catalogue = ((await call(u, "GET", "/api/reports")).body?.reports ?? []) as { key: string; href: string | null }[];
    const targets = new Map<string, string>(catalogue.filter((r) => r.href).map((r) => [linkKey(r.href!), r.href!]));
    for (const [k, href] of drill[u]) targets.set(k, href);
    for (const href of targets.values()) {
      const url = new URL(href, BASE);
      if (url.pathname.startsWith("/reports/")) {
        const r = await call(u, "GET", `/api/reports/${url.pathname.split("/")[2]}${url.search}`);
        if (r.status !== 200) wrong.push(`${href} → ${r.status}`);
      } else {
        const p = await page(u, href);
        if (p.status !== 200 || p.html.includes(DENIED_PAGE)) wrong.push(`${href} → ${p.status === 200 ? "access denied" : p.status}`);
      }
    }
    check(`${roles[u]} (${u}): every linked screen opens (${targets.size})`, wrong.length === 0, wrong);
  }

  finish("REPORT ACCESS");
}

main().catch((e) => { console.error(e); process.exit(1); });
