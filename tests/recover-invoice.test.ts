/* Invoice draft recover: void a draft, recover it, issue it.
   Tests state guards, authorization, version protection, and audit. */
import { call, login, makeChecker } from "./_harness";
import { taxNo } from "./_stock";
import { todayBiz } from "./_days";

const { check, section, finish } = makeChecker();
const TAG = `ZZREC${Date.now() % 1_000_000_000}`;
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim"]) await login(u);

  // SETUP: a product, customer, stock, and a dispatched order to invoice
  const prod = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Prod`, unit: "KG" })).body.product;
  const sup = (await call("admin", "POST", "/api/stock/suppliers", { name: `${TAG} Sup` })).body.supplier;
  await call("admin", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: prod.id, received_kg: 50, unit_cost: "3" });
  // MIG-01: invoices issued below need the buyer's 9-digit tax number (on the card).
  const cust = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Cust`, tax_registration_no: taxNo() })).body.customer;

  const today = todayBiz();

  const o = (await call("mona", "POST", "/api/orders", {
    customer_account_id: cust.id, customer_name: cust.name, delivery_date: today,
    items: [{ stock_product_id: prod.id, product_name: prod.name, quantity: 20 }],
  })).body.order;
  const item = o.items[0];
  await call("mona", "PATCH", `/api/orders/${o.id}/items/${item.id}/price`, { unit_price: "15", reason: "سعر" });
  await call("sara", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${o.id}/items/${item.id}/prepare`, { quantity: 20, mark_done: true });
  await call("sara", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o.id}/items/${item.id}/load`, { quantity: 20, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loaded" });
  r = await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", vehicle: "ت", driver_name: "د", crate_count: 2 });
  check("order dispatched", r.status === 200, r.status);

  // -----------------------------------------------------------------------
  section("1. CREATE & ISSUE INVOICE (baseline)");
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
  check("draft created", inv.status === "draft" && Number(inv.total) === 300, inv.total);

  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  check("issued", r.status === 200 && r.body.invoice.status === "issued", r.body.invoice?.status);
  const issued = r.body.invoice;

  // -----------------------------------------------------------------------
  section("2. ISSUED -> RECOVER REJECTED");
  r = await call("karim", "POST", `/api/sales/invoices/${issued.id}/recover`, { reason: "محاولة", expected_version: issued.version });
  check("issued rejected 409", r.status === 409, `${r.status}: ${JSON.stringify(r.body).slice(0,100)}`);
  check("correct error", /صدرت/.test(r.body?.error ?? ""), r.body?.error);

  // -----------------------------------------------------------------------
  section("3. DRAFT -> RECOVER REJECTED (already a draft)");
  // Create a second order + draft just to test
  const o2 = (await call("mona", "POST", "/api/orders", {
    customer_account_id: cust.id, customer_name: cust.name, delivery_date: today,
    items: [{ stock_product_id: prod.id, product_name: prod.name, quantity: 5 }],
  })).body.order;
  await call("mona", "PATCH", `/api/orders/${o2.id}/items/${o2.items[0].id}/price`, { unit_price: "10", reason: "س" });
  await call("sara", "POST", `/api/orders/${o2.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${o2.id}/items/${o2.items[0].id}/prepare`, { quantity: 5, mark_done: true });
  await call("sara", "POST", `/api/orders/${o2.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o2.id}/items/${o2.items[0].id}/load`, { quantity: 5, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "loaded" });
  await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "dispatched", vehicle: "ت", driver_name: "د", crate_count: 1 });

  const dInv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o2.id })).body.invoice;
  check("draft created for o2", dInv.status === "draft");

  r = await call("karim", "POST", `/api/sales/invoices/${dInv.id}/recover`, { reason: "محاولة", expected_version: dInv.version });
  check("draft rejected 409", r.status === 409, `${r.status}: ${JSON.stringify(r.body).slice(0,100)}`);
  check("correct error", /المسودة/.test(r.body?.error ?? ""), r.body?.error);

  // -----------------------------------------------------------------------
  section("4. VOID DRAFT -> RECOVER -> ISSUE (happy path)");
  // Create 3rd order, void its draft, then recover
  const o3 = (await call("mona", "POST", "/api/orders", {
    customer_account_id: cust.id, customer_name: cust.name, delivery_date: today,
    items: [{ stock_product_id: prod.id, product_name: prod.name, quantity: 10 }],
  })).body.order;
  await call("mona", "PATCH", `/api/orders/${o3.id}/items/${o3.items[0].id}/price`, { unit_price: "12", reason: "س" });
  await call("sara", "POST", `/api/orders/${o3.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${o3.id}/items/${o3.items[0].id}/prepare`, { quantity: 10, mark_done: true });
  await call("sara", "POST", `/api/orders/${o3.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${o3.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o3.id}/items/${o3.items[0].id}/load`, { quantity: 10, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o3.id}/status`, { to: "loaded" });
  await call("mostafa", "POST", `/api/orders/${o3.id}/status`, { to: "dispatched", vehicle: "ت", driver_name: "د", crate_count: 1 });

  const vInv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o3.id })).body.invoice;
  const vVersion = vInv.version;
  check("draft ready for o3", vInv.status === "draft");

  // Void it
  r = await call("karim", "POST", `/api/sales/invoices/${vInv.id}/void`, { reason: "غلط في الكمية", expected_version: vVersion });
  check("voided", r.status === 200, r.status);
  r = await call("karim", "GET", `/api/sales/invoices/${vInv.id}`);
  check("status = void", r.body.invoice?.status === "void" || r.body.status === "void", r.body);

  // Recover it
  const recVer = r.body.invoice?.version ?? r.body.version;
  r = await call("karim", "POST", `/api/sales/invoices/${vInv.id}/recover`, { reason: "الكمية كانت صح", expected_version: recVer });
  check("recovered", r.status === 200, r.status);
  const rec = r.body.invoice ?? r.body;
  check("status = draft", rec.status === "draft", rec.status);
  check("version incremented", rec.version === (recVer + 1), `was ${recVer} now ${rec.version}`);

  // Issue it
  r = await call("karim", "POST", `/api/sales/invoices/${vInv.id}/issue`, {});
  check("issued after recovery", r.status === 200, r.status);

  // -----------------------------------------------------------------------
  section("5. AUTHORIZATION & VALIDATION");
  // Wrong version
  r = await call("karim", "POST", `/api/sales/invoices/${dInv.id}/void`, { reason: "اختبار", expected_version: dInv.version });
  check("voided dInv", r.status === 200, r.status);
  r = await call("karim", "POST", `/api/sales/invoices/${dInv.id}/recover`, { reason: "اختبار", expected_version: 9999 });
  check("stale version -> 409", r.status === 409, r.status);

  // Missing reason
  r = await call("karim", "POST", `/api/sales/invoices/${dInv.id}/recover`, { expected_version: dInv.version + 1 });
  check("missing reason -> 400", r.status === 400, r.status);
  // Recover it properly first
  r = await call("karim", "GET", `/api/sales/invoices/${dInv.id}`);
  const dv2 = (r.body.invoice ?? r.body).version;
  r = await call("karim", "POST", `/api/sales/invoices/${dInv.id}/recover`, { reason: "اتفقنا مع العميل", expected_version: dv2 });
  check("recovered ok", r.status === 200, r.status);

  // Unauthorized (mona is SALES — has invoices.view but not invoices.manage)
  r = await call("mona", "POST", `/api/sales/invoices/${vInv.id}/recover`, { reason: "اختبار", expected_version: 1 });
  check("sales cannot recover -> 403", r.status === 403, r.status);

  // -----------------------------------------------------------------------
  section("6. AUDIT TRAIL");
  r = await call("karim", "GET", "/api/audit?limit=200");
  const logs = r.body.logs ?? r.body;
  const recoveryLogs = (Array.isArray(logs) ? logs : []).filter(
    (l: any) => l.action === "invoice_draft_recovered" && l.entityId === dInv.id
  );
  check("recovery audit entry exists", recoveryLogs.length >= 1, recoveryLogs.length);
  const ev = recoveryLogs[0];
  check("recovery has reason", ev?.reason?.length > 0, ev?.reason);
  check("recovery has actor", ev?.userName?.length > 0, ev?.userName);

  // -----------------------------------------------------------------------
  section("7. REGRESSION: existing invoice flow unchanged");
  const invs = (await call("karim", "GET", "/api/sales/invoices")).body.invoices ?? [];
  const numInvs = invs.length;
  check("invoices readable", numInvs >= 3, numInvs);

  finish("RECOVER-INVOICE");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });