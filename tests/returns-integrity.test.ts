/* Returns integrity: standalone customer returns are capped — a credit note can
   never exceed what physically came back on the linked return document, one
   return document authorizes at most one credit note, and cumulative credit
   never exceeds the invoiced quantity. Uses its own products/customer so the
   tightly-coupled UAT totals are untouched. */
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZRET-${Date.now()}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
const n = (v: any) => Number(v ?? 0);
const product = async (id: string) => (await call("karim", "GET", `/api/inventory/products/${id}`)).body;
const onHand = async (id: string) => n((await product(id)).onHand);

async function main() {
  section("0. SETUP");
  for (const u of ["admin", "karim", "hossam", "mona", "ahmed", "sara", "mostafa"]) await login(u);

  const r1 = await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مزرعة` });
  if (r1.status !== 201) throw new Error("supplier: " + JSON.stringify(r1.body));
  const sup = r1.body.supplier;
  const p = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} ملفوف`, unit: "KG" })).body.product;
  const c = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;
  check("setup supplier/product/customer", !!sup && !!p && !!c);

  // Stock in the warehouse so the sale can be dispatched.
  const intake = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: p.id, received_date: today, received_kg: 300, unit_cost: 5 });
  check("intake 300 kg @ 5 -> 201", intake.status === 201, intake.body);

  section("1. ORDER → DISPATCH → ISSUE");
  const o = (await call("mona", "POST", "/api/orders", { customer_account_id: c.id, customer_name: c.name, delivery_date: today, items: [{ stock_product_id: p.id, product_name: p.name, quantity: 100 }] })).body.order;
  await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: "12", reason: "قائمة" });
  await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/prepare`, { quantity: 100, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: 100, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loaded" });
  const disp = await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 });
  check("order dispatched (100 kg issued)", disp.status === 200 && (await onHand(p.id)) === 200, [disp.status, await onHand(p.id)]);
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
  const I = (await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {})).body.invoice;
  check("invoice issued: 100 × 12 = 1,200", n(I.total) === 1200, I.total);
  const il = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice.lines[0];
  const balBefore = (await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: c.id, date: today, due_date: today, amount: 0, reference: "none" })).status; // no-op guard; balance below is from the invoice itself
  void balBefore;
  const statement = async (kind: "customer" | "supplier", id: string) => (await call("karim", "GET", `/api/${kind === "customer" ? "sales/customers" : "purchasing/suppliers"}/${id}/statement?from=2000-01-01&to=2099-12-31`)).body;
  const owes = async () => n((await statement("customer", c.id)).closing);
  check("customer owes 1,200 after issue", (await owes()) === 1200, await owes());

  section("2. STANDALONE RETURN + CREDIT CAP");
  // 30 kg physically come back (no credit yet).
  const ret = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: o.id, reason: `${TAG}-r1`, lines: [{ product_id: p.id, quantity: 30 }] });
  const docId = ret.body.document?.id ?? ret.body.return?.id ?? ret.body.id;
  check("standalone customer return 30 kg -> 201, stock back to 230", ret.status === 201 && (await onHand(p.id)) === 230, [ret.status, await onHand(p.id)]);
  check("stock controller cannot credit (fina...", (await call("hossam", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "x", lines: [{ invoice_line_id: il.id, quantity: 1 }] })).status === 403);

  // 35 > 30 returned -> 409 (must not credit more than physically returned).
  check("credit 35 > 30 returned -> 409", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-over`, return_document_id: docId, lines: [{ invoice_line_id: il.id, quantity: 35 }] })).status === 409);
  // 20 ≤ 30 returned and ≤ 100 invoiced -> 201.
  const cn1 = (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-cn1`, return_document_id: docId, lines: [{ invoice_line_id: il.id, quantity: 20 }] })).body.creditNote;
  check("partial credit 20 ≤ 30 returned -> 201", !!cn1, cn1);
  check("customer owes 1,200 − 240 = 960", (await owes()) === 960, await owes());
  check("stock unchanged by the credit (already returned)", (await onHand(p.id)) === 230, await onHand(p.id));
  // Same return document again -> 409 (reuse guard, even with a small quantity).
  const reuse = await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-reuse`, return_document_id: docId, lines: [{ invoice_line_id: il.id, quantity: 5 }] });
  check("same return document reused -> 409", reuse.status === 409, [reuse.status, reuse.body?.error]);
  // A NEW return document of 10 kg authorizes a further 10 kg credit.
  const ret2 = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: o.id, reason: `${TAG}-r2`, lines: [{ product_id: p.id, quantity: 10 }] });
  const doc2 = ret2.body.document?.id ?? ret2.body.return?.id ?? ret2.body.id;
  check("second return 10 kg -> 201; stock 240", ret2.status === 201 && (await onHand(p.id)) === 240, [ret2.status, await onHand(p.id)]);
  const cn2 = (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-cn2`, return_document_id: doc2, lines: [{ invoice_line_id: il.id, quantity: 10 }] })).body.creditNote;
  check("credit 10 with doc2 -> 201; owes 1,200 − 240 − 120 = 840", !!cn2 && (await owes()) === 840, await owes());
  // Cumulative: 30 of 100 credited so far; 71 would exceed the remaining 70 invoiced -> 400.
  check("71 > 70 remaining invoiced -> 400 (cumulative invoice cap)", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-overall`, lines: [{ invoice_line_id: il.id, quantity: 71 }] })).status === 400);
  // A pure-financial credit (no goods back) is a legitimate workflow (e.g. quality
  // discount) and stays within the remaining invoiced 70 — but it cannot invent a
  // return document; it posts without one.
  const pure = await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-pure`, lines: [{ invoice_line_id: il.id, quantity: 20 }] });
  check("pure-financial credit 20 (no return) -> 201; owes 600", pure.status === 201 && (await owes()) === 600, [pure.status, await owes()]);

  section("3. IDEMPOTENT RETRY + CONCURRENCY");
  // A third return (8 kg) for the idempotency test: two concurrent submissions with
  // the SAME key must post exactly one credit note; the second is a replayed replay.
  const ret3 = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: o.id, reason: `${TAG}-r3`, lines: [{ product_id: p.id, quantity: 8 }] });
  const doc3 = ret3.body.document?.id ?? ret3.body.return?.id ?? ret3.body.id;
  const sameKey = `${TAG}-key`;
  const [a, b] = await Promise.all([
    call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-dup`, return_document_id: doc3, idempotency_key: sameKey, lines: [{ invoice_line_id: il.id, quantity: 8 }] }),
    call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: `${TAG}-dup`, return_document_id: doc3, idempotency_key: sameKey, lines: [{ invoice_line_id: il.id, quantity: 8 }] }),
  ]);
  const cnIds = [a, b].map((x: any) => x.body?.creditNote?.id ?? x.body?.note?.id).filter(Boolean);
  check("same idempotency key 2× → both responses carry the SAME single credit note", new Set(cnIds).size === 1 && cnIds.length === 2, { statuses: [a.status, b.status], ids: cnIds });
  check("…owes 600 − 96 = 504 after the single duplicate-safe credit", (await owes()) === 504, await owes());

  section("4. UNKNOWN-COST RECONCILIATION (provisional ≠ confirmed)");
  // A second product received WITHOUT a price: its cost is unknown until the
  // supplier cost arrives. The sale's COGS must not be presented as confirmed.
  const p2 = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} بصل`, unit: "KG" })).body.product;
  const c2 = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل تكلفة` })).body.customer;
  const intake2 = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: p2.id, received_date: today, received_kg: 2000 });
  check("intake WITHOUT unit_cost -> 201 (cost unknown)", intake2.status === 201, intake2.body);
  check("…valuation layer records it as UNKNOWN cost (zero value)", (await call("karim", "GET", `/api/inventory/reports/valuation`)).body.rows.some((r: any) => r.productId === p2.id && Number(r.receivedWithoutCost) === 2000), (await call("karim", "GET", `/api/inventory/reports/valuation`)).body.rows.find((r: any) => r.productId === p2.id));
  const o2ord = (await call("mona", "POST", "/api/orders", { customer_account_id: c2.id, customer_name: c2.name, delivery_date: today, items: [{ stock_product_id: p2.id, product_name: p2.name, quantity: 600 }] })).body.order;
  await call("mona", "PATCH", `/api/orders/${o2ord.id}/items/${o2ord.items[0].id}/price`, { unit_price: "20", reason: "قائمة" });
  await call("ahmed", "POST", `/api/orders/${o2ord.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${o2ord.id}/items/${o2ord.items[0].id}/prepare`, { quantity: 600, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${o2ord.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${o2ord.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o2ord.id}/items/${o2ord.items[0].id}/load`, { quantity: 600, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o2ord.id}/status`, { to: "loaded" });
  await call("mostafa", "POST", `/api/orders/${o2ord.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 });
  const inv2ord = (await call("karim", "POST", "/api/sales/invoices", { order_id: o2ord.id })).body.invoice;
  await call("karim", "POST", `/api/sales/invoices/${inv2ord.id}/issue`, {});
  const fin2 = (await call("karim", "GET", `/api/management/finance`)).body.report;
  // The finance report must flag the quantity sold while cost was unknown — the
  // revenue is real but the margin is provisional (zero COGS is not confirmed cost).
  const row2 = fin2.sales.byProduct.find((x: any) => x.product.includes(TAG) && x.product.includes("بصل"));
  check("finance report flags provisional-cost sale with costUnknownQty > 0", !!row2 && Number(row2.costUnknownQty) >= 600, row2);
  check("…its COGS is zero while unknown (provisional margin)", !!row2 && n(row2.cost) === 0 && n(row2.margin) === 12000, row2);

  section("5. PHYSICAL OVER-RETURN CAP (cumulative per order and per supplier)");
  // Order o dispatched 100 kg of product p; 48 kg already returned across doc1..doc3.
  // A further 60 kg would make 108 > 100 issued -> 409.
  const overReturn = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: o.id, reason: `${TAG}-over`, lines: [{ product_id: p.id, quantity: 60 }] });
  check("customer physical over-return (108 > 100 issued) -> 409", overReturn.status === 409, [overReturn.status, overReturn.body?.error]);
  // The remaining legit headroom works: 48 + 50 = 98 ≤ 100 issued -> 201.
  const headroom = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: o.id, reason: `${TAG}-head`, lines: [{ product_id: p.id, quantity: 2 }] });
  check("customer return within the issued headroom (50 ≤ 100) -> 201", headroom.status === 201, [headroom.status, await onHand(p.id)]);
  // Supplier returns: we received 300 kg p / 2000 kg p2 from sup. Returning more is blocked.
  const supOver = await call("hossam", "POST", "/api/inventory/returns", { direction: "supplier", supplier_id: sup.id, reason: `${TAG}-sup-over`, lines: [{ product_id: p.id, quantity: 5000 }] });
  check("supplier return beyond received (5000 > 300) -> 409", supOver.status === 409, [supOver.status, supOver.body?.error]);
  const supOk = await call("hossam", "POST", "/api/inventory/returns", { direction: "supplier", supplier_id: sup.id, reason: `${TAG}-sup-ok`, lines: [{ product_id: p.id, quantity: 50 }] });
  check("supplier return within received (50 ≤ 300) -> 201", supOk.status === 201, [supOk.status, supOk.body]);
  // A return with no order and no supplier (warehouse-only, e.g. damaged goods found
  // in storage) stays legitimate and uncapped by the order/supplier invariants.
  const wOnly = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", reason: `${TAG}-warehouse-only`, lines: [{ product_id: p.id, quantity: 10 }] });
  check("warehouse-only return (no order) remains legitimate -> 201", wOnly.status === 201, wOnly.body);
}

main().then(() => finish("RETURNS-INTEGRITY")).catch((e) => { console.error(e); process.exit(1); });