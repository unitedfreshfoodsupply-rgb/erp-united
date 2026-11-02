/* Accounting end to end: every document posts its own balanced entry; receipts and
   payments settle invoices and bills and move the customer/supplier balances; stock
   valuation reaches the GL from the stock ledger; manual journals, reversals, closed
   periods and bank reconciliation behave. */
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";
import { taxNo, fundCash } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `ZZACC${Date.now() % 1_000_000_000}`;
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"]) await login(u);
  const today = todayBiz();
  const journalOf = async (sourceType: string, needle: string) => {
    const list = (await call("karim", "GET", `/api/accounting/journals?source_type=${sourceType}`)).body.journals;
    const hit = list.find((j: any) => j.description.includes(needle));
    return hit ? (await call("karim", "GET", `/api/accounting/journals/${hit.id}`)).body.journal : null;
  };
  const side = (j: any, code: string) => {
    const ls = j.lines.filter((l: any) => l.account.code === code);
    return ls.reduce((s: number, l: any) => s + Number(l.debit) - Number(l.credit), 0);
  };

  section("1. ACCESS");
  check("sales cannot read the ledger -> 403", (await call("mona", "GET", "/api/accounting/trial-balance")).status === 403);
  check("the floor cannot record receipts -> 403", (await call("mostafa", "POST", "/api/accounting/receipts", {})).status === 403);
  check("the accountant reads the chart of accounts", (await call("karim", "GET", "/api/accounting/accounts")).body.accounts?.some((a: any) => a.systemKey === "ar"));

  section("2. SALE → INVOICE → GL");
  const supplier = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const okra = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Okra`, unit: "KG" })).body.product;
  await call("admin", "POST", "/api/stock/intakes", { supplier_id: supplier.id, product_id: okra.id, received_kg: 100, unit_cost: "10" });
  // MIG-01: an invoice needs the buyer's 9-digit tax number (on the card here).
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} سوبر ماركت`, tax_registration_no: taxNo() })).body.customer;
  let o = (await call("sara", "POST", "/api/orders", { customer_account_id: customer.id, customer_name: customer.name, delivery_date: today, items: [{ stock_product_id: okra.id, product_name: okra.name, quantity: 40 }] })).body.order;
  await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: "25", reason: "عقد" });
  await call("sara", "POST", `/api/orders/${o.id}/status`, { to: "loading", reason: "مباشر" });
  await call("sara", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: 40, mark_done: true });
  check("dispatched (issues 40 kg at 10)", (await call("sara", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", reason: "خرج", vehicle: "x", driver_name: "y", crate_count: 2 })).status === 200);
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  const issued = r.body.invoice;
  check("invoice issued: 40 × 25 = 1000", r.status === 200 && issued.total === "1000", r.body);
  let je = await journalOf("sales_invoice", issued.number);
  check("…posted: Dr AR 1000 / Cr Sales 1000", je && side(je, "1300") === 1000 && side(je, "4100") === -1000 && je.lines.find((l: any) => l.account.code === "1300").partyId === customer.id, je?.lines);

  section("3. RECEIPT → ALLOCATION → CUSTOMER BALANCE");
  check("over-allocating an invoice -> 400", (await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, cash_account_id: "cash_main", amount: 1200, method: "cash", allocations: [{ document_id: inv.id, amount: 1100 }] })).status === 400);
  r = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, cash_account_id: "cash_main", amount: 400, method: "cash", allocations: [{ document_id: inv.id, amount: 400 }] });
  check("400 cash received against the invoice -> 201", r.status === 201 && /^RCT-\d{4}-\d{5}$/.test(r.body.receipt.number), r.body);
  let invNow = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
  check("…invoice open 600", invNow.open === "600.00" && invNow.paid === "400.00", [invNow.open, invNow.paid]);
  je = await journalOf("customer_receipt", r.body.receipt.number);
  check("…posted: Dr Cash 400 / Cr AR 400 (customer)", je && side(je, "1100") === 400 && side(je, "1300") === -400);
  r = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, cash_account_id: "bank_main", amount: 700, method: "bank_transfer", reference: "TRX-1", auto: true });
  check("700 by bank, auto-allocated: 600 settles the invoice, 100 on account", r.status === 201, r.body);
  invNow = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
  check("…invoice fully paid", invNow.open === "0.00");
  const receipts = (await call("karim", "GET", `/api/accounting/receipts?customer_id=${customer.id}`)).body.receipts;
  check("…the second receipt has 100 unallocated", receipts.find((x: any) => x.amount === "700.00")?.unallocated === "100.00", receipts);
  const st = (await call("karim", "GET", `/api/sales/customers/${customer.id}/statement?from=2026-01-01&to=2099-12-31`)).body;
  check("customer statement: invoice, two receipts, balance −100 (we owe them)", st.closing === "-100.00" && st.rows.filter((x: any) => x.kind === "receipt").length === 2, st);
  const aging = (await call("karim", "GET", "/api/sales/reports/aging")).body.rows.find((x: any) => x.customer.id === customer.id);
  check("AR aging shows the 100 unapplied", aging?.unapplied === "100.00" && aging.total === "-100.00", aging);

  section("4. PURCHASE → RECEIPT → STOCK VALUATION → BILL → PAYMENT");
  const po = (await call("omar", "POST", "/api/purchasing/orders", { supplier_id: supplier.id, lines: [{ product_id: okra.id, quantity: 200, unit_price: "9" }] })).body.order;
  await call("omar", "POST", `/api/purchasing/orders/${po.id}/submit`, {});
  await call("omar", "POST", `/api/purchasing/orders/${po.id}/send`, {});
  const rc = (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: po.lines[0].id, received_kg: 200 })).body.intake;
  // Stock value reaches the GL in the stock transaction itself — no run needed.
  const svJournals = (await call("karim", "GET", "/api/accounting/journals?source_type=stock_valuation")).body.journals;
  const receiptJe = (await call("karim", "GET", `/api/accounting/journals/${svJournals.find((j: any) => j.description.includes(rc.receiptNumber))?.id}`)).body.journal;
  check("the PO receipt posted its own value at once: Dr Inventory 1800 / Cr GRNI 1800", side(receiptJe, "1400") === 1800 && side(receiptJe, "2150") === -1800, receiptJe?.lines?.map((l: any) => [l.account.code, l.debit, l.credit]));
  const issueJe = svJournals.find((j: any) => j.description.includes("صرف لعميل"));
  check("…and the dispatch posted Dr COGS / Cr Inventory", !!issueJe);
  check("the catch-up run finds nothing left to post", (await call("karim", "POST", "/api/accounting/stock-valuation", {})).body.result.entries.length === 0);
  const bill = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: supplier.id, supplier_invoice_no: `${TAG}-1`, bill_date: today, lines: [{ intake_id: rc.id, unit_price: "9" }] })).body.bill;
  check("bill posted (matched)", (await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {})).body.bill?.status === "posted");
  je = await journalOf("supplier_bill", bill.number);
  check("…posted: Dr GRNI 1800 / Cr AP 1800 (supplier)", je && side(je, "2150") === 1800 && side(je, "2100") === -1800 && je.lines.find((l: any) => l.account.code === "2100").partyId === supplier.id, je?.lines);
  // L2: the bank never goes negative — the owner puts money in first (approved journal).
  await fundCash("bank_main", 2000);
  r = await call("karim", "POST", "/api/accounting/payments", { party_id: supplier.id, cash_account_id: "bank_main", amount: 1800, method: "bank_transfer", auto: true });
  check("paid in full by bank -> 201", r.status === 201 && /^PAY-\d{4}-\d{5}$/.test(r.body.payment.number), r.body);
  check("…bill open 0", (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill.open === "0.00");
  check("…supplier owed nothing", (await call("karim", "GET", `/api/purchasing/suppliers/${supplier.id}/statement`)).body.payable === "0.00");
  je = await journalOf("supplier_payment", r.body.payment.number);
  check("…posted: Dr AP 1800 / Cr Bank 1800", je && side(je, "2100") === 1800 && side(je, "1200") === -1800);
  check("the buyer cannot pay suppliers -> 403", (await call("omar", "POST", "/api/accounting/payments", { party_id: supplier.id, cash_account_id: "cash_main", amount: 1, method: "cash" })).status === 403);

  section("5. LEDGER INTEGRITY, MANUAL JOURNALS, PERIODS");
  // Brief pause under heavy load (the canonical chain runs 24 suites before reaching
  // this point — the Prisma pool may be temporarily drained. The pause lets it recover
  // so subsequent heavy queries don't get a transient 500).
  await new Promise((r) => setTimeout(r, 2_000));
  const tb = (await call("karim", "GET", `/api/accounting/trial-balance?from=2026-01-01&to=${today}`)).body.trialBalance;
  check("trial balance balances", tb.balanced === true && tb.totals.debit === tb.totals.credit, tb.totals);
  const accounts = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts;
  const acc = (key: string) => accounts.find((a: any) => a.systemKey === key).id;
  const header = accounts.find((a: any) => a.code === "6000").id;
  check("unbalanced manual journal -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: acc("general_expenses"), debit: 50 }, { account_id: acc("cash"), credit: 40 }] })).status === 400);
  check("posting to a header account -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: header, debit: 50 }, { account_id: acc("cash"), credit: 50 }] })).status === 400);
  // CTL-01 (replaces "a balanced manual journal -> 201"): manual journals wait for a
  // second person (accounting.manual_journal_approval on, threshold 0).
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} مصروف نثرية`, lines: [{ account_id: acc("general_expenses"), debit: 50 }, { account_id: acc("cash"), credit: 50 }] });
  check("a balanced manual journal -> 202, waiting for approval (nothing posted)", r.status === 202 && r.body.journalRequest?.status === "pending_approval" && r.body.journalRequest?.total === "50.00", r.body);
  const jReq = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.type === "accounting.manual_journal" && a.entityId === r.body.journalRequest?.id);
  check("…the accountant cannot approve their own journal -> 403", (await call("karim", "POST", `/api/approvals/${jReq?.id}/decide`, { decision: "approve", comment: "x" })).status === 403);
  r = await call("admin", "POST", `/api/approvals/${jReq?.id}/decide`, { decision: "approve", comment: "معتمد" });
  check("…someone else approves it", r.status === 200, r.body);
  const jPosted = (await call("karim", "GET", "/api/accounting/journal-requests")).body.requests.find((x: any) => x.id === jReq?.entityId);
  check("…and it posts: 50.00", jPosted?.status === "posted" && !!jPosted?.entry?.id, jPosted);
  const manual = (await call("karim", "GET", `/api/accounting/journals/${jPosted?.entry?.id}`)).body.journal;
  check("the posted manual journal totals 50.00", manual?.total === "50.00", manual);
  r = await call("karim", "POST", `/api/accounting/journals/${manual.id}/reverse`, { reason: "اتسجل مرتين" });
  check("reversed by a new entry", r.status === 201 && r.body.journal.reversalOfId === manual.id, r.body);
  check("reversing twice -> 409", (await call("karim", "POST", `/api/accounting/journals/${manual.id}/reverse`, { reason: "x" })).status === 409);
  const invJe = await journalOf("sales_invoice", issued.number);
  check("a document's entry is not reversed by hand -> 409 (credit note instead)", (await call("karim", "POST", `/api/accounting/journals/${invJe.id}/reverse`, { reason: "x" })).status === 409);
  // A historical month of its own per run (the suite must be re-runnable on one database).
  // Guaranteed before today's real transactions (2026+) so it never triggers the
  // "close earlier open periods first" rule.
  const n = Math.floor(Date.now() / 1000);
  const period = `${2000 + (n % 10)}-${String(1 + (Math.floor(n / 30) % 12)).padStart(2, "0")}`;
  check("sales cannot close periods -> 403", (await call("mona", "POST", `/api/accounting/periods/${period}/close`, {})).status === 403);
  r = await call("karim", "POST", `/api/accounting/periods/${period}/close`, {});
  check(`close ${period}`, r.body.period?.status === "closed", r.body);
  check("closing it again -> 409", (await call("karim", "POST", `/api/accounting/periods/${period}/close`, {})).status === 409);
  r = await call("karim", "POST", "/api/accounting/journals", { date: `${period}-15`, description: "x", lines: [{ account_id: acc("general_expenses"), debit: 1 }, { account_id: acc("cash"), credit: 1 }] });
  check("posting into a closed period -> 409", r.status === 409, [period, r.status, r.body]);
  r = await call("karim", "POST", "/api/accounting/sync", {});
  check("sync of unposted documents is idempotent (runs; posts only what is missing)", r.status === 200 && (await call("karim", "POST", "/api/accounting/sync", {})).body.result.invoices === 0, r.body);

  section("6. CASH POSITION AND BANK RECONCILIATION");
  const cash = (await call("karim", "GET", "/api/accounting/cash")).body.cash;
  const bank = cash.rows.find((x: any) => x.id === "bank_main");
  check("cash position from the GL", !!bank && cash.rows.some((x: any) => x.id === "cash_main"), cash);
  r = await call("karim", "POST", "/api/accounting/reconciliations", { cash_account_id: "bank_main", statement_date: today, statement_balance: bank.balance });
  check("start a reconciliation at the book balance", r.status === 201, r.body);
  const recId = r.body.reconciliation.id;
  check("a second open one for the same account -> 409", (await call("karim", "POST", "/api/accounting/reconciliations", { cash_account_id: "bank_main", statement_date: today, statement_balance: 0 })).status === 409);
  let rec = (await call("karim", "GET", `/api/accounting/reconciliations/${recId}`)).body.reconciliation;
  const ids = rec.lines.map((l: any) => l.id);
  if (Number(rec.difference) !== 0) check("completing with a difference -> 409", (await call("karim", "POST", `/api/accounting/reconciliations/${recId}/complete`, {})).status === 409);
  await call("karim", "POST", `/api/accounting/reconciliations/${recId}/mark`, { line_ids: ids, cleared: true });
  rec = (await call("karim", "GET", `/api/accounting/reconciliations/${recId}`)).body.reconciliation;
  check("every statement line ticked: no difference", rec.difference === "0.00", rec);
  check("completed", (await call("karim", "POST", `/api/accounting/reconciliations/${recId}/complete`, {})).body.reconciliation?.status === "completed");
  const auditRows = async (u: string) => (await call(u, "GET", "/api/audit")).body.logs?.filter((l: any) => ["journal_entry", "customer_receipt", "supplier_payment"].includes(l.entityType)) ?? [];
  check("ledger events are audited…", (await auditRows("admin")).length > 0);
  check("…and hidden from an auditor without accounting access", (await auditRows("sara")).length === 0);

  section("7. MANAGEMENT REPORTS");
  check("sales sees neither report -> 403", (await call("mona", "GET", "/api/management/finance")).status === 403 && (await call("mona", "GET", "/api/management/operations")).status === 403);
  check("the supervisor sees operations, not finance", (await call("sara", "GET", "/api/management/operations")).status === 200 && (await call("sara", "GET", "/api/management/finance")).status === 403);
  const fin = (await call("karim", "GET", `/api/management/finance?from=${today}&to=${today}`)).body.report;
  const okraRow = fin.sales.byProduct.find((p: any) => p.product.includes(`${TAG} Okra`));
  check("margin on okra: 1000 revenue − 400 cost (40 kg issued at 10) = 600", okraRow?.revenue === "1000.00" && okraRow?.cost === "400.00" && okraRow?.margin === "600.00", okraRow);
  check("customer sales and cash position come from the documents and the GL", fin.sales.byCustomer.some((c: any) => c.customerId === customer.id && c.net === "1000.00") && typeof fin.cash.total === "string");
  const ops = (await call("sara", "GET", `/api/management/operations?from=${today}&to=${today}`)).body.report;
  check("operations report: fulfilment and stock age, no money in it", ops.fulfilment.orders >= 1 && Array.isArray(ops.inventoryAging) && !/"(revenue|cost|margin|total|amount|value)":/.test(JSON.stringify(ops)), Object.keys(ops));
  finish("ACCOUNTING");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
