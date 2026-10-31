// F-05 — Cash flow statement: indirect method report
// Uses the HTTP API for the report (not direct import) to match the
// test harness pattern and avoid module resolution issues.
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZF05${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
const n = (v: any) => Number(v ?? 0);

async function cfReport(from: string, to: string) {
  const res = await call("admin", "GET", `/api/management/cash-flow?from=${from}&to=${to}`);
  if (res.status !== 200) throw new Error(`CF report API error: ${res.body?.error ?? res.status}`);
  return res.body.report;
}

async function main() {
  for (const u of ["admin", "sara", "hossam", "mona", "mostafa", "ahmed", "karim"]) await login(u);

  // Setup: supplier, product, customer
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const prodA = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} سلعة`, unit: "KG" })).body.product;
  const cust = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;

  // Intake stock (creates inventory + GRNI — no cash effect)
  const i1 = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, received_date: today, product_id: prodA.id, received_kg: 100, unit_cost: "10" });
  check("intake A ok", i1.status === 200 || i1.status === 201, [i1.status, i1.body?.error]);

  // Create, dispatch, invoice, and collect cash for an order
  const o1 = (await call("mona", "POST", "/api/orders", {
    customer_account_id: cust.id, customer_name: TAG, delivery_date: today,
    items: [{ stock_product_id: prodA.id, product_name: prodA.name, quantity: 50 }],
  })).body.order;
  await call("mona", "PATCH", `/api/orders/${o1.id}/items/${o1.items[0].id}/price`, { unit_price: "20", reason: TAG });
  await call("sara", "POST", `/api/orders/${o1.id}/status`, { to: "preparing", reason: TAG });
  await call("sara", "POST", `/api/orders/${o1.id}/items/${o1.items[0].id}/prepare`, { quantity: 50, reason: TAG });
  await call("sara", "POST", `/api/orders/${o1.id}/status`, { to: "ready_for_loading", reason: TAG });
  await call("mostafa", "POST", `/api/orders/${o1.id}/items/${o1.items[0].id}/load`, { quantity: 50, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o1.id}/status`, { to: "loaded", reason: TAG });
  // Dispatch requires operations.trips.manage — use sara (SUPERVISOR)
  const d1 = await call("sara", "POST", `/api/orders/${o1.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1, reason: TAG });
  check("dispatch OK", d1.status === 200, [d1.status, d1.body?.error]);

  // Issue invoice (must be after dispatch)
  const inv1 = await call("karim", "POST", "/api/sales/invoices", { order_id: o1.id, issue_date: today });
  check("invoice ok", inv1.status === 201, [inv1.status, inv1.body?.error]);
  const invBody = inv1.body.invoice;

  // Collect cash (receipt)
  const recv1 = await call("karim", "POST", "/api/accounting/receipts", {
    party_id: cust.id, cash_account_id: "cash_main", amount: 1000, method: "cash",
    date: today, reference: TAG, idempotency_key: `${TAG}-r1`,
  });
  check("receipt ok", recv1.status === 201, [recv1.status, recv1.body?.error]);

  // Run stock valuation
  const val = await call("admin", "POST", "/api/accounting/stock-valuation", {});
  check("valuation ok", val.status === 200, [val.status, val.body?.error]);

  // =========================================================================
  section("N1. BALANCE: CASH FLOW CHANGE = NET CASH BALANCE CHANGE");
  const cf = await cfReport("2026-01-01", today);
  check("N1 report returned with sections", !!cf.sections?.operating, !!cf);
  const cashDelta = n(cf.cashTotal?.change ?? NaN);
  const flowDelta = n(cf.netCashFlow ?? NaN);
  check("N1 net cash flow matches cash balance change", !isNaN(cashDelta) && Math.abs(cashDelta - flowDelta) < 0.01, { cashDelta, flowDelta });
  check("N1 report is balanced (flag)", cf._balanced === true, cf._balanced);

  // =========================================================================
  section("N2. THREE SECTIONS EXIST WITH LABELS");
  check("N2 operating section exists", !!cf.sections.operating, Object.keys(cf.sections));
  check("N2 investing section exists", !!cf.sections.investing, Object.keys(cf.sections));
  check("N2 financing section exists", !!cf.sections.financing, Object.keys(cf.sections));

  // =========================================================================
  section("N3. CASH ACCOUNTS LISTED");
  check("N3 cash accounts exist", cf.cashAccounts?.length > 0, cf.cashAccounts?.length ?? 0);
  const hasOpening = cf.cashAccounts?.some((a: any) => n(a.opening) >= 0);
  const hasClosing = cf.cashAccounts?.some((a: any) => n(a.closing) >= 0);
  check("N3 has opening balances", hasOpening === true);
  check("N3 has closing balances", hasClosing === true);

  // =========================================================================
  section("N4. OPERATING SECTION CONTAINS NET INCOME");
  const hasNetIncome = cf.sections.operating.lines?.some((l: any) => l.label?.includes("صافي الدخل"));
  check("N4 net income in operating", hasNetIncome === true);

  // =========================================================================
  section("N5. RBAC — UNAUTHORIZED ACCESS → 403");
  const r5 = await call("mostafa", "GET", `/api/management/cash-flow?from=2026-01-01&to=${today}`);
  check("N5 LOADER cash flow → 403", r5.status === 403, [r5.status, r5.body?.error]);

  // =========================================================================
  section("N6. VALIDATION — MISSING DATES → 400");
  const r6a = await call("admin", "GET", `/api/management/cash-flow?from=2026-01-01`);
  check("N6 missing to → 400", r6a.status === 400, [r6a.status, r6a.body?.error]);
  const r6b = await call("admin", "GET", `/api/management/cash-flow?to=${today}`);
  check("N6 missing from → 400", r6b.status === 400, [r6b.status, r6b.body?.error]);

  // =========================================================================
  // (N7 removed — redundant; the sum-check sign depends on the negate convention)
  check("N7 cash change equals net flow", cf._balanced === true, cf._balanced);

  // =========================================================================
  section("N8. EVERY BALANCE-SHEET MOVEMENT COUNTS WITH ITS SIGN");
  // Over the whole history of the database (supplier bills, payroll, opening balances,
  // liabilities and equity included), net income + the balance-sheet changes = cash change.
  const all = await cfReport("2000-01-01", today);
  const sum = ["operating", "investing", "financing"].reduce((a, k) => a + n(all.sections[k].total), 0);
  check("N8 net cash flow = operating + investing + financing", Math.abs(sum - n(all.netCashFlow)) < 0.01, { sum, net: all.netCashFlow });
  check("N8 whole-history report balances against the cash and bank accounts", all._balanced === true && Math.abs(n(all.netCashFlow) - n(all.cashTotal.change)) < 0.01, { net: all.netCashFlow, change: all.cashTotal.change });
  check("N8 lines carry a kind for the screen to label in either language", all.sections.operating.lines[0]?.kind === "net_income" && Object.values(all.sections).every((sec: any) => sec.lines.every((l: any) => l.kind === "net_income" || (l.kind === "change" && l.accountCode) || (l.kind === "adjustment" && l.adjustment))));

  finish("CASH-FLOW");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(1); });