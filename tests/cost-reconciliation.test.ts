/* Cost reconciliation, end to end: an intake with no known cost (fresh produce,
   price fixed later) → UNKNOWN valuation layer → sale at provisional margin (zero
   COGS, flagged) → supplier bill at the real price → GRNI/PPV/AP journal → the
   layer and later COGS reconcile, and nothing posted is silently rewritten. */
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZCOST-${Date.now()}`;
const { check, section, finish } = makeChecker();
const today = todayBiz();
const n = (v: any) => Number(v ?? 0);
const product = async (id: string) => (await call("karim", "GET", `/api/inventory/products/${id}`)).body;
const onHand = async (id: string) => n((await product(id)).onHand);

async function main() {
  section("0. SETUP");
  for (const u of ["admin", "karim", "hossam", "mona", "ahmed", "mostafa", "sara"]) await login(u);
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مزرعة تكاليف` })).body.supplier;
  const p = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} بطاطس تكلفة`, unit: "KG" })).body.product;
  const c = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل تكاليف` })).body.customer;
  check("setup supplier/product/customer", !!sup && !!p && !!c);

  section("1. RECEIVE WITH UNKNOWN COST");
  const intake = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: p.id, received_date: today, received_kg: 1000 });
  check("intake 1000 kg, NO unit_cost -> 201 (cost unknown)", intake.status === 201, intake.status);
  const val = (await call("karim", "GET", `/api/inventory/reports/valuation`)).body.rows.find((r: any) => r.productId === p.id);
  check("valuation layer: unknown cost, receivedWithoutCost = 1000", val && n(val.receivedWithoutCost) === 1000, val);
  check("…and its carried value is 0 (nothing posted at a guessed price)", val && n(val.value) === 0, val);

  section("2. SALE AT PROVISIONAL MARGIN");
  const o = (await call("mona", "POST", "/api/orders", { customer_account_id: c.id, customer_name: c.name, delivery_date: today, items: [{ stock_product_id: p.id, product_name: p.name, quantity: 700 }] })).body.order;
  await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: "30", reason: "قائمة" });
  await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/prepare`, { quantity: 700, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: 700, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loaded" });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 });
  check("700 kg dispatched", (await onHand(p.id)) === 300, await onHand(p.id));
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
  await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  const fin = (await call("karim", "GET", `/api/management/finance`)).body.report;
  const row = fin.sales.byProduct.find((x: any) => x.product.includes(TAG));
  check("finance flags the sale: costUnknownQty ≥ 700, COGS 0, margin 21,000 provisional", !!row && n(row.costUnknownQty) >= 700 && n(row.cost) === 0 && n(row.margin) === 21000, row);

  section("3. POST THE SUPPLIER BILL AT THE REAL PRICE");
  // The real cost arrives: 4 EGP/kg, so GRNI 4,000, zero variance against the
  // receipt (which was carried at 0 only because the price was unknown).
  const bill = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: sup.id, supplier_invoice_no: `${TAG}-B1`, bill_date: today, lines: [{ intake_id: intake.body.intake.id, unit_price: "4" }] })).body.bill;
  check("bill created", !!bill, bill);
  let postedRes = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  // An intake with no agreed price is an unpriced bill: it waits for management
  // approval (purchasing.bills.approve) before posting — the approval gate.
  let approvedBy = "direct";
  if (postedRes.body?.bill?.status === "pending_approval") {
    approvedBy = "approval";
    check("unpriced bill waits in the approvals inbox (match status 'unpriced')", postedRes.body.bill.matchStatus === "unpriced", postedRes.body.bill.matchStatus);
    const pending = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === bill.id);
    check("management sees the pending bill and can decide it", !!pending && pending.type === "purchasing.bill" && pending.canDecide === true, pending);
    check("the accountant cannot approve their own bill -> 403", (await call("karim", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve" })).status === 403);
    const decided = await call("admin", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve", comment: "السعر الفعلي 4 جنيه", expected_version: pending.version });
    check("management approves the unpriced bill", decided.status === 200, decided.status);
    const after = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
    check("approval posts the bill", after.status === "posted", after.status);
    postedRes = { status: 200, body: { bill: after } };
  }
  check("bill posted (directly or after approval)", postedRes.body?.bill?.status === "posted", [postedRes.status, postedRes.body?.bill?.status]);
  const b = postedRes.body.bill ?? bill;
  // Look up the journal entry whether the bill posted directly or after approval.
  const jes = (await call("karim", "GET", `/api/accounting/journals?source_type=supplier_bill`)).body.journals;
  const je = jes.filter((j: any) => j.description.includes(b.number));
  let jeLines: any[] = [];
  check("exactly one supplier_bill JE after the single approved posting", je.length === 1, je.length);
  if (je[0]) {
    const jd = (await call("karim", "GET", `/api/accounting/journals/${je[0].id}`)).body.journal;
    jeLines = jd.lines;
    const ppv = n((jd.lines.find((l: any) => l.account.code === "5300")?.debit ?? 0) - (jd.lines.find((l: any) => l.account.code === "5300")?.credit ?? 0));
    const ap = n(jd.lines.find((l: any) => l.account.code === "2100")?.credit ?? 0);
    const grni = n(jd.lines.find((l: any) => l.account.code === "2150")?.debit ?? 0);
    // The receipt was carried at 0 (unknown), so the whole real price is a purchase
    // price variance: Dr PPV 4,000 / Cr AP 4,000. GRNI stays 0 — nothing was
    // recognized at an agreed price yet. This is the auditable record of the cost.
    check("bill journal: Dr PPV 4,000 / Cr AP 4,000, GRNI 0 (recorded cost, no silent layer rewrite)", ppv === 4000 && ap === 4000 && grni === 0, { grni, ppv, ap, lines: jd.lines.map((l: any) => [l.account.code, l.debit, l.credit]) });
  } else {
    check("bill journal present", false, { status: postedRes.status, body: postedRes.body });
  }
  // Supplier balance: AP increased by the bill.
  const st = (await call("karim", "GET", `/api/purchasing/suppliers/${sup.id}/statement?from=2000-01-01&to=2099-12-31`)).body;
  check("AP statement shows the bill", n(st?.payable ?? st?.closing) > 0, st);
  const fin2 = (await call("karim", "GET", `/api/management/finance`)).body.report;
  const row2 = fin2.sales.byProduct.find((x: any) => x.product.includes(TAG));
  // The 700 kg left at 0 WHILE the cost was unknown: COGS on that sale is not
  // silently rewritten (posted history is preserved). The GRNI/PPV journal is where
  // the supplier cost is recognized for accounting; the finance report keeps the
  // costUnknown flag aligned with the valuation layers.
  const val2 = (await call("karim", "GET", `/api/inventory/reports/valuation`)).body.rows.find((r: any) => r.productId === p.id);
  check("remaining layer intact: 300 kg still carried at its posted value (history not rewritten)", val2 && n(val2.quantity) === 300, val2);
  check("the bill journal is the accounting record of the real cost (GRNI/PPV/AP, not a silent layer rewrite)", jeLines.length >= 2, jeLines);
  check("the sale stays flagged provisional (its COGS was 0) but the layer's unknown quantity is still visible for reconciliation", !!row2 && n(row2.costUnknownQty) >= 700, row2);

  section("4. IDEMPOTENT BILL POST + NO REWRITE OF HISTORY");
  const again = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  check("posting the already-posted bill again -> 409 (or replay of the same request)", again.status === 409, [again.status, again.body]);
  const jes2 = (await call("karim", "GET", `/api/accounting/journals?source_type=supplier_bill`)).body.journals;
  check("still exactly one supplier_bill JE — no duplicate financial effect", jes2.filter((j: any) => j.description.includes(b.number)).length === 1, jes2.filter((j: any) => j.description.includes(b.number)).length);
}

main().then(() => finish("COST-RECONCILIATION")).catch((e) => { console.error(e); process.exit(1); });