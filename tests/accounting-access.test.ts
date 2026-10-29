/* Least-privilege accounting (lib/permissions.ts): accounting.view is financial visibility —
   chart of accounts, balances, journals, ledgers, trial balance, P&L, balance sheet, VAT and
   withholding — and stays with the accounting manager (ACCOUNTANT). The ACCOUNTING_CLERK role
   records customer receipts and supplier payments and reads only what those need. Checked at
   the API (direct calls, exports, related-record endpoints), not just in the interface. */
import { call, login, makeChecker } from "./_harness";

const TAG = `zzacc${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();

async function main() {
  for (const u of ["admin", "mona", "omar", "karim"]) await login(u);
  const clerk = `${TAG}_clerk`;
  const created = await call("admin", "POST", "/api/admin/users", { name: `${TAG} Clerk`, username: clerk, password: "longenoughpw", role: "ACCOUNTING_CLERK" });
  check("an administrator can create an accounting clerk", created.status === 200 || created.status === 201, [created.status, created.body?.error]);
  check("the clerk signs in", (await call(clerk, "POST", "/api/auth/login", { username: clerk, password: "longenoughpw" })).status === 200);

  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const account = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts?.[0];
  check("fixtures ready", !!customer?.id && !!supplier?.id && !!account?.id, [customer?.id, supplier?.id, account?.id]);

  section("1. THE CLERK CANNOT SEE FINANCIAL POSITION OR REPORTS (403)");
  const denied: [string, string][] = [
    ["GET", "/api/accounting/accounts"],
    ["GET", `/api/accounting/accounts/${account.id}/ledger`],
    ["GET", "/api/accounting/cash"],
    ["GET", "/api/accounting/journals"],
    ["GET", "/api/accounting/trial-balance"],
    ["GET", "/api/accounting/pnl"],
    ["GET", "/api/accounting/balance-sheet"],
    ["GET", "/api/accounting/integrity"],
    ["GET", "/api/accounting/periods"],
    ["GET", "/api/accounting/opening-balances"],
    ["GET", "/api/accounting/vat-summary"],
    ["GET", "/api/accounting/vat-summary/export"],
    ["GET", "/api/accounting/withholding"],
    ["GET", "/api/accounting/withholding/export"],
    ["GET", "/api/management/finance"],
    ["GET", "/api/management/finance/export"],
    ["GET", "/api/management/cash-flow"],
    ["GET", "/api/inventory/reports/valuation"],
    ["GET", "/api/inventory/reports/valuation/export"],
    ["POST", "/api/accounting/journals"],
    ["POST", "/api/accounting/periods/2026-01/close"],
    ["POST", "/api/accounting/receipts/none/reverse"],
  ];
  for (const [method, path] of denied) {
    const r = await call(clerk, method, path, method === "POST" ? { reason: "x" } : undefined);
    check(`clerk ${method} ${path} → 403`, r.status === 403, r.status);
  }

  section("2. THE CLERK CAN DO THE ASSIGNED WORK (200)");
  for (const path of ["/api/accounting/receipts", "/api/accounting/payments", "/api/accounting/customer-refunds", "/api/accounting/supplier-refunds", `/api/accounting/customers/${customer.id}/open-invoices`, `/api/accounting/suppliers/${supplier.id}/open-bills`, "/api/sales/customers", "/api/purchasing/suppliers"]) {
    const r = await call(clerk, "GET", path);
    check(`clerk GET ${path} → 200`, r.status === 200, [r.status, r.body?.error]);
  }
  const receipt = await call(clerk, "POST", "/api/accounting/receipts", { party_id: customer.id, amount: "25", method: "cash", cash_account_id: "cash_main", idempotency_key: `${TAG}-r1` });
  check("clerk records a customer receipt", receipt.status === 200 || receipt.status === 201, [receipt.status, receipt.body?.error]);
  const payment = await call(clerk, "POST", "/api/accounting/payments", { party_id: supplier.id, amount: "15", method: "cash", cash_account_id: "cash_main", idempotency_key: `${TAG}-p1` });
  check("clerk records a supplier payment", payment.status === 200 || payment.status === 201, [payment.status, payment.body?.error]);
  const listed = (await call(clerk, "GET", "/api/accounting/receipts")).body.receipts ?? [];
  check("the clerk's receipt is in their list", listed.some((r: any) => r.id === receipt.body?.receipt?.id));

  section("3. THE ACCOUNTING MANAGER KEEPS FULL ACCESS");
  for (const path of ["/api/accounting/trial-balance", "/api/accounting/pnl", "/api/accounting/balance-sheet", "/api/accounting/cash", "/api/accounting/journals", "/api/management/finance", "/api/accounting/receipts"]) {
    const r = await call("karim", "GET", path);
    check(`manager GET ${path} → 200`, r.status === 200, [r.status, r.body?.error]);
  }
  if (receipt.body?.receipt?.id) {
    const rev = await call("karim", "POST", `/api/accounting/receipts/${receipt.body.receipt.id}/reverse`, { reason: `${TAG} cleanup` });
    check("the manager (not the clerk) reverses the clerk's receipt", rev.status === 200 || rev.status === 201, [rev.status, rev.body?.error]);
  }

  section("4. OTHER ROLES STILL HAVE NO FINANCIAL VISIBILITY");
  for (const who of ["mona", "omar"]) {
    for (const path of ["/api/accounting/trial-balance", "/api/accounting/cash", "/api/accounting/receipts"]) {
      check(`${who} GET ${path} → 403`, (await call(who, "GET", path)).status === 403);
    }
  }
  finish("ACCOUNTING ACCESS");
}

main().catch((e) => { console.error(e); process.exit(1); });
