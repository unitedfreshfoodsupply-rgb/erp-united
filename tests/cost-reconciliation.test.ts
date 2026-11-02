/* Cost reconciliation, end to end. WS3 (remediation 2026-11, ACC-E1) superseded the old
   rule — "an intake with no known cost enters stock at an UNKNOWN cost (zero), the bill's
   whole amount becomes a purchase price variance" — with the provisional-cost rule:
     an intake with no price at all is refused → it is received at a PROVISIONAL cost →
     sale at a provisional margin (flagged) → supplier bill at the real price → the bill
     revalues the receipt (on hand → Inventory, sold → COGS; no PPV, there was no agreed
     price) → COGS and the layers reconcile, and nothing posted is silently rewritten
     (the receipt's own layer stays as posted; the revaluation is new movements).
   The whole scenario is in tests/provisional-cost.test.ts; this suite keeps the original
   1000 kg / 700 kg sold story with the new rule. */
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

  section("1. RECEIVE WITHOUT AN AGREED PRICE");
  const refused = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: p.id, received_date: today, received_kg: 1000 });
  check("intake 1000 kg with NO cost at all -> 400 (no more unknown-cost receipts)", refused.status === 400, [refused.status, refused.body]);
  const intake = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: p.id, received_date: today, received_kg: 1000, provisional_unit_cost: "3" });
  check("intake 1000 kg at a provisional 3 -> 201 (cost provisional)", intake.status === 201 && intake.body.intake.costProvisional === true, [intake.status, intake.body?.intake?.costProvisional]);
  const val = (await call("karim", "GET", `/api/inventory/reports/valuation`)).body.rows.find((r: any) => r.productId === p.id);
  check("valuation: 1000 kg at 3000, all of it provisional, nothing without a cost", val && n(val.value) === 3000 && n(val.provisionalQty) === 1000 && n(val.receivedWithoutCost) === 0, val);

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
  check("finance flags the sale: costProvisionalQty ≥ 700, COGS 2,100 (700 × 3), margin 18,900 provisional", !!row && n(row.costProvisionalQty) >= 700 && n(row.cost) === 2100 && n(row.margin) === 18900 && n(row.costUnknownQty) === 0, row);

  section("3. POST THE SUPPLIER BILL AT THE REAL PRICE");
  // The real cost arrives: 4 EGP/kg. The receipt carried 3,000 in GRNI; the bill clears it
  // at 3,000 + the 300 the 300 kg still on hand are revalued by; the 700 kg already sold
  // take their 700 into COGS. No price variance: there was no agreed price.
  const bill = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: sup.id, supplier_invoice_no: `${TAG}-B1`, bill_date: today, lines: [{ intake_id: intake.body.intake.id, unit_price: "4" }] })).body.bill;
  check("bill created", !!bill, bill);
  let postedRes = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  // A receipt with no agreed price is an unpriced bill: it waits for management approval
  // (purchasing.bills.approve) before posting — the approval gate.
  if (postedRes.body?.bill?.status === "pending_approval") {
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
  const jes = (await call("karim", "GET", `/api/accounting/journals?source_type=supplier_bill`)).body.journals;
  const je = jes.filter((j: any) => j.description.includes(b.number));
  check("exactly one supplier_bill JE after the single approved posting", je.length === 1, je.length);
  let jeLines: any[] = [];
  if (je[0]) {
    const jd = (await call("karim", "GET", `/api/accounting/journals/${je[0].id}`)).body.journal;
    jeLines = jd.lines;
    const net = (code: string) => jd.lines.filter((l: any) => l.account.code === code).reduce((s: number, l: any) => s + n(l.debit) - n(l.credit), 0);
    check("bill journal: Dr GRNI 3,300 (3,000 + 300 revalued), Dr COGS 700, PPV 0, Cr AP 4,000", Math.abs(net("2150") - 3300) < 0.005 && Math.abs(net("5100") - 700) < 0.005 && net("5300") === 0 && Math.abs(net("2100") + 4000) < 0.005, jd.lines.map((l: any) => [l.account.code, l.debit, l.credit]));
  } else {
    check("bill journal present", false, { status: postedRes.status, body: postedRes.body });
  }
  const st = (await call("karim", "GET", `/api/purchasing/suppliers/${sup.id}/statement?from=2000-01-01&to=2099-12-31`)).body;
  check("AP statement shows the bill", n(st?.payable ?? st?.closing) > 0, st);
  const val2 = (await call("karim", "GET", `/api/inventory/reports/valuation`)).body.rows.find((r: any) => r.productId === p.id);
  check("remaining 300 kg carried at the billed cost: 1,200, nothing provisional any more", val2 && n(val2.quantity) === 300 && n(val2.value) === 1200 && n(val2.provisionalQty) === 0, val2);
  const fin2 = (await call("karim", "GET", `/api/management/finance`)).body.report;
  const row2 = fin2.sales.byProduct.find((x: any) => x.product.includes(TAG));
  check("the sale's cost is now the real one: COGS 2,800 (700 × 4), margin 18,200, no longer provisional", !!row2 && n(row2.cost) === 2800 && n(row2.margin) === 18200 && n(row2.costProvisionalQty) === 0, row2);
  check("the bill journal is the accounting record of the real cost", jeLines.length >= 2, jeLines);

  section("4. IDEMPOTENT BILL POST + NO REWRITE OF HISTORY");
  const again = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  check("posting the already-posted bill again -> 409 (or replay of the same request)", again.status === 409, [again.status, again.body]);
  const jes2 = (await call("karim", "GET", `/api/accounting/journals?source_type=supplier_bill`)).body.journals;
  check("still exactly one supplier_bill JE — no duplicate financial effect", jes2.filter((j: any) => j.description.includes(b.number)).length === 1, jes2.filter((j: any) => j.description.includes(b.number)).length);
  const led = (await call("karim", "GET", `/api/stock/ledger?product_id=${p.id}&limit=500`)).body.movements;
  const receipt = led.filter((m: any) => m.kind === "intake");
  const reval = led.filter((m: any) => m.kind === "revaluation_out" || m.kind === "revaluation_in");
  check("the receipt's own movement is untouched (1000 kg at 3); the revaluation is a new out/in pair", receipt.length === 1 && n(receipt[0].unitCost) === 3 && reval.length === 2, [receipt.map((m: any) => [m.kind, m.quantityKg ?? m.quantity, m.unitCost]), reval.map((m: any) => [m.kind, m.quantityKg ?? m.quantity, m.unitCost])]);
  check("the bill shows its revaluation: Δ 1,000 = inventory 300 + COGS 700", (b.revaluations ?? []).length === 1 && n(b.revaluations[0].inventory) === 300 && n(b.revaluations[0].cogs) === 700, b.revaluations);
}

main().then(() => finish("COST-RECONCILIATION")).catch((e) => { console.error(e); process.exit(1); });
