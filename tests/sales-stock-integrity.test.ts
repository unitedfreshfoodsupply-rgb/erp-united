// Sales ↔ stock integrity (remediation 2026-11, WF-01 / CTL-01 / MIG-01 / L2).
// A confirmed order line is stock that is sellable now, held in full; nothing leaves
// or is invoiced without its stock and its cost; unavailable demand becomes a purchase
// request; prices outside policy and grading losses wait for someone else.
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZSSI${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz();
const ship = { vehicle: "x", driver_name: "y", crate_count: 1 };

async function main() {
  for (const u of ["admin", "sara", "hossam", "mona", "mostafa", "ahmed", "karim", "omar"]) await login(u);

  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const kg = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} مانجو`, unit: "KG" })).body.product;
  const pc = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} أناناس`, unit: "PIECE" })).body.product;
  const none = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} صنف من غير رصيد`, unit: "KG" })).body.product;
  const cust = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} فندق` })).body.customer;
  const intake = (body: Record<string, unknown>) => call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, received_date: today, ...body });
  await intake({ product_id: kg.id, received_kg: 100, unit_cost: "10" });
  await intake({ product_id: pc.id, received_kg: 20, unit_cost: "30" });
  const order = (items: Record<string, unknown>[], who = "mona") =>
    call(who, "POST", "/api/orders", { customer_account_id: cust.id, customer_name: cust.name, delivery_date: today, items });
  const avail = async (id: string) => {
    const r = await call("mona", "GET", "/api/orders/entry/catalog");
    return Number(r.body.products.find((p: { id: string }) => p.id === id)?.available ?? NaN);
  };

  section("1. Availability on the order screen");
  check("entry catalog shows 100 kg available to sell", (await avail(kg.id)) === 100);

  section("2. Sufficient stock: confirmed and fully reserved");
  let r = await order([{ stock_product_id: kg.id, quantity: 30, unit: "KG" }]);
  check("order for 30 kg -> 201", r.status === 201 || r.status === 200, [r.status, r.body?.error]);
  const o1 = r.body.order;
  check("…and 30 kg are now held (70 available)", (await avail(kg.id)) === 70);

  section("3. Zero stock / more than available: refused, nothing created");
  r = await order([{ stock_product_id: none.id, quantity: 5, unit: "KG" }]);
  check("zero stock -> 409 stock_unavailable", r.status === 409 && r.body.code === "stock_unavailable", r.body);
  check("…with the line's shortfall in details", r.body.details?.shortfalls?.[0]?.reason === "insufficient" && r.body.details.shortfalls[0].available === "0", r.body.details);
  r = await order([{ stock_product_id: kg.id, quantity: 71, unit: "KG" }]);
  check("71 kg against 70 available -> 409", r.status === 409 && r.body.details?.shortfalls?.[0]?.available === "70", r.body);
  r = await order([{ stock_product_id: kg.id, quantity: 40, unit: "KG" }, { stock_product_id: kg.id, quantity: 40, unit: "KG" }]);
  check("two lines of the same product are judged together (80 > 70) -> 409", r.status === 409 && r.body.details?.shortfalls?.[0]?.line === 2, r.body);

  section("4. Two concurrent orders cannot take the same stock");
  const [a, b] = await Promise.all([order([{ stock_product_id: kg.id, quantity: 50, unit: "KG" }]), order([{ stock_product_id: kg.id, quantity: 50, unit: "KG" }])]);
  const ok = [a, b].filter((x) => x.status === 201 || x.status === 200);
  check("exactly one of two 50 kg orders (70 available) succeeds", ok.length === 1 && [a, b].some((x) => x.status === 409), [a.status, b.status]);
  check("…and 20 kg remain available", (await avail(kg.id)) === 20);
  const o2 = ok[0].body.order;

  section("5. Units: KG decimals, PIECE whole");
  r = await order([{ stock_product_id: kg.id, quantity: 2.5, unit: "KG" }]);
  check("2.5 kg accepted", r.status === 201 || r.status === 200, r.body);
  const o3 = r.body.order;
  r = await order([{ stock_product_id: kg.id, quantity: 1.2345, unit: "KG" }]);
  check("4 decimals on KG -> 400", r.status === 400, r.body);
  r = await order([{ stock_product_id: pc.id, quantity: 1.5, unit: "PIECE" }]);
  check("1.5 PIECE -> 400 (whole units only)", r.status === 400 && /كسور|whole/.test(r.body.error), r.body);
  r = await order([{ stock_product_id: pc.id, quantity: 3, unit: "PIECE" }]);
  check("3 PIECE accepted", r.status === 201 || r.status === 200, r.body);
  r = await order([{ stock_product_id: pc.id, quantity: 3, unit: "KG" }]);
  check("a unit the product does not carry -> 400", r.status === 400, r.body);

  section("6. Integration intake cannot bypass the rule");
  r = await call(null, "POST", "/api/orders", { external_id: `${TAG}-n8n`, source: "n8n", customer_name: cust.name, delivery_date: today, items: [{ product_name: `${TAG} مش في الدليل`, quantity: 5 }] }, { "x-api-key": process.env.N8N_API_KEY! });
  check("n8n order for an unmapped product -> 409, not created", r.status === 409 && r.body.details?.shortfalls?.[0]?.reason === "unmapped", r.body);

  section("7. Settings: no lenient dispatch, no optional reservation");
  const settings = (await call("admin", "GET", "/api/admin/settings")).body.settings as { key: string; value: unknown; version: number }[];
  const pol = settings.find((x) => x.key === "inventory.dispatch_issue_policy")!;
  check("dispatch policy is strict by default", pol.value === "strict");
  check("lenient can no longer be set -> 400", (await call("admin", "PATCH", "/api/admin/settings/inventory.dispatch_issue_policy", { value: "lenient", reason: TAG, expected_version: pol.version })).status === 400);
  const ar = settings.find((x) => x.key === "sales.auto_reserve")!;
  check("reservation cannot be switched off -> 400", (await call("admin", "PATCH", "/api/admin/settings/sales.auto_reserve", { value: false, reason: TAG, expected_version: ar.version })).status === 400);
  check("different approver is on by default", settings.find((x) => x.key === "approvals.require_different_approver")?.value === true);

  section("8. Cancel releases the stock");
  const before = await avail(kg.id);
  r = await call("sara", "POST", `/api/orders/${o3.id}/cancel`, { reason: TAG });
  check("cancel -> 200", r.status === 200, r.body);
  check("…2.5 kg back in available", (await avail(kg.id)) === before + 2.5, [before, await avail(kg.id)]);
  check("status route cannot cancel (it would skip releasing stock)", (await call("sara", "POST", `/api/orders/${o2.id}/status`, { to: "cancelled", reason: TAG })).status === 400);

  section("9. Quantity edit must be reservable");
  r = await call("sara", "PATCH", `/api/orders/${o1.id}/items/${o1.items[0].id}/required`, { quantity: 30 + (await avail(kg.id)) + 1, reason: TAG });
  check("raising a line above what is free -> 409", r.status === 409, r.body);
  r = await call("sara", "PATCH", `/api/orders/${o1.id}/items/${o1.items[0].id}/required`, { quantity: 25, reason: TAG });
  check("lowering it -> 200 and frees 5 kg", r.status === 200, r.body);

  section("10. Prices: typed per line, audited, exceptions held for someone else");
  r = await call("mostafa", "POST", "/api/orders", { customer_account_id: cust.id, customer_name: cust.name, delivery_date: today, items: [{ stock_product_id: pc.id, quantity: 1, unit: "PIECE", unit_price: "50" }] });
  check("a typed price without sales.price_override -> 403 (or no create rights)", r.status === 403, r.status);
  r = await order([{ stock_product_id: pc.id, quantity: 2, unit: "PIECE", unit_price: "50" }]);
  check("typed price 50 per piece (cost 30) -> created, pricing ok", (r.status === 201 || r.status === 200) && r.body.order.pricingStatus === "ok", r.body);
  const pOk = r.body.order;
  const priced = (await call("mona", "GET", `/api/orders/${pOk.id}/pricing`)).body;
  check("…the line holds 50 as a manual price", JSON.stringify(priced).includes("50"), priced);
  r = await order([{ stock_product_id: pc.id, quantity: 1, unit: "PIECE", unit_price: "20" }]);
  check("price 20 below cost 30 -> order held for price approval", (r.status === 201 || r.status === 200) && r.body.order.pricingStatus === "pending_approval", r.body);
  const pLow = r.body.order;
  r = await call("sara", "POST", `/api/orders/${pLow.id}/status`, { to: "preparing", reason: TAG });
  check("…preparation refused while the price waits", r.status === 409, r.body);
  const pending = (await call("karim", "GET", "/api/approvals?status=pending")).body;
  const req = (pending.requests ?? pending.items ?? []).find((x: { type: string; entityId: string }) => x.type === "sales.price_exception" && x.entityId === pLow.id);
  check("…a sales.price_exception request exists", !!req, pending);
  if (req) {
    r = await call("karim", "POST", `/api/approvals/${req.id}/decide`, { decision: "approve", comment: TAG });
    check("someone else (accountant) approves -> 200", r.status === 200, r.body);
    r = await call("sara", "POST", `/api/orders/${pLow.id}/status`, { to: "preparing", reason: TAG });
    check("…now preparation can start", r.status === 200, r.body);
  }
  r = await order([{ stock_product_id: pc.id, quantity: 1, unit: "PIECE", unit_price: "100", discount_pct: "25" }]);
  check("discount 25% above the 10% limit -> held", r.body.order?.pricingStatus === "pending_approval", r.body);

  section("11. Purchase request: approved by someone else, ordered, received, fulfilled");
  r = await call("mona", "POST", "/api/purchasing/requests", { product_id: none.id, quantity: 12, uom: "KG", customer_id: cust.id, needed_by: today });
  check("sales raises a purchase request -> 201", r.status === 201, r.body);
  const pr = r.body.request;
  const prReq = ((await call("omar", "GET", "/api/approvals?status=pending")).body.requests ?? []).find((x: { type: string; entityId: string }) => x.type === "purchasing.request" && x.entityId === pr.id);
  check("…its approval request exists", !!prReq);
  r = await call("omar", "POST", `/api/purchasing/requests/${pr.id}/convert`, { supplier_id: sup.id, expected_version: pr.version });
  check("cannot be ordered before approval -> 409", r.status === 409, r.body);
  if (prReq) {
    r = await call("omar", "POST", `/api/approvals/${prReq.id}/decide`, { decision: "approve", comment: TAG });
    check("purchaser approves -> 200", r.status === 200, r.body);
  }
  let cur = (await call("omar", "GET", `/api/purchasing/requests/${pr.id}`)).body.request;
  check("…status approved, decided by someone else", cur.status === "approved" && cur.decidedBy && cur.decidedBy !== cur.requestedBy, cur);
  r = await call("omar", "POST", `/api/purchasing/requests/${pr.id}/convert`, { supplier_id: sup.id, unit_price: "11", expected_version: cur.version });
  check("converted to a purchase order", r.status === 200 && r.body.request.status === "ordered" && !!r.body.request.purchaseOrder, r.body);
  cur = r.body.request;
  r = await call("mona", "POST", `/api/purchasing/requests/${pr.id}/fulfil`, { delivery_date: today, expected_version: cur.version });
  check("fulfil before the goods are sellable -> 409 (no promise)", r.status === 409, r.body);
  await intake({ product_id: none.id, received_kg: 12, unit_cost: "11" });
  r = await call("mona", "POST", `/api/purchasing/requests/${pr.id}/fulfil`, { delivery_date: today, expected_version: cur.version });
  check("after receiving: fulfil creates the customer's order", (r.status === 201 || r.status === 200) && !!r.body.order?.id && r.body.request.status === "fulfilled", r.body);
  check("…and that order holds the 12 kg", (await avail(none.id)) === 0);

  section("12. Grading loss: held in quarantine, unsellable, released by someone else");
  const g = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} فراولة`, unit: "KG" })).body.product;
  r = await intake({ product_id: g.id, received_kg: 50, waste_qty: 5, unit_cost: "20" });
  check("intake with 5 kg waste -> recorded", r.status === 201 || r.status === 200, r.body);
  check("…but nothing is sellable yet (held for loss approval)", (await avail(g.id)) === 0);
  r = await order([{ stock_product_id: g.id, quantity: 10, unit: "KG" }]);
  check("…so an order is refused", r.status === 409, r.body);
  const gl = ((await call("sara", "GET", "/api/approvals?status=pending")).body.requests ?? []).find((x: { type: string; entityId: string }) => x.type === "inventory.grading_loss" && x.entityId === r?.body?.dummy) ?? ((await call("sara", "GET", "/api/approvals?status=pending")).body.requests ?? []).find((x: { type: string; title: string }) => x.type === "inventory.grading_loss" && x.title.includes(g.name));
  check("…a grading-loss approval request exists", !!gl);
  if (gl) {
    r = await call("hossam", "POST", `/api/approvals/${gl.id}/decide`, { decision: "approve", comment: TAG });
    check("the receiver cannot approve their own loss -> 403", r.status === 403, r.body);
    r = await call("sara", "POST", `/api/approvals/${gl.id}/decide`, { decision: "approve", comment: TAG });
    check("the supervisor approves -> 200", r.status === 200, r.body);
    check("…45 kg become sellable", (await avail(g.id)) === 45);
  }

  section("13. Dispatch is strict; invoice needs a buyer tax identity");
  const q = (await order([{ stock_product_id: pc.id, quantity: 2, unit: "PIECE", unit_price: "60" }])).body.order;
  await call("sara", "POST", `/api/orders/${q.id}/status`, { to: "preparing", reason: TAG });
  await call("sara", "POST", `/api/orders/${q.id}/items/${q.items[0].id}/prepare`, { quantity: 2, reason: TAG, user: "sara", mark_done: true });
  await call("sara", "POST", `/api/orders/${q.id}/status`, { to: "ready_for_loading", reason: TAG });
  await call("mostafa", "POST", `/api/orders/${q.id}/status`, { to: "loading", reason: TAG });
  await call("mostafa", "POST", `/api/orders/${q.id}/items/${q.items[0].id}/load`, { quantity: 30, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${q.id}/status`, { to: "loaded", reason: TAG });
  const qq = (await call("sara", "GET", `/api/orders/${q.id}`)).body.order;
  if (qq.needsReview) await call("sara", "POST", `/api/orders/${q.id}/approve`, { reason: TAG });
  r = await call("mostafa", "POST", `/api/orders/${q.id}/status`, { to: "dispatched", reason: TAG, ...ship });
  check("loading 30 pieces when the books hold fewer -> dispatch refused 409", r.status === 409 && r.body.code === "dispatch_stock_shortfall", r.body);
  check("…the order did not leave", (await call("sara", "GET", `/api/orders/${q.id}`)).body.order.status === "loaded");
  await call("mostafa", "POST", `/api/orders/${q.id}/items/${q.items[0].id}/load`, { quantity: 2, mark_done: true });
  const qq2 = (await call("sara", "GET", `/api/orders/${q.id}`)).body.order;
  if (qq2.needsReview) await call("sara", "POST", `/api/orders/${q.id}/approve`, { reason: TAG });
  r = await call("mostafa", "POST", `/api/orders/${q.id}/status`, { to: "dispatched", reason: TAG, ...ship });
  check("with the real 2 pieces it leaves", r.status === 200, r.body);
  const inv = (await call("karim", "POST", `/api/sales/invoices`, { order_id: q.id })).body.invoice;
  r = await call("karim", "POST", `/api/sales/invoices/${inv?.id}/issue`, {});
  check("customer with no tax number anywhere -> issue refused 409", r.status === 409 && r.body.code === "buyer_tax_id_missing", r.body);
  const le = await call("mona", "POST", "/api/sales/legal-entities", { code: `${TAG.slice(-6)}LE`, name: `${TAG} شركة الفنادق`, tax_registration_no: String(100000000 + (Date.now() % 899999999)) });
  if (le.status === 201 || le.status === 200) {
    await call("mona", "PATCH", `/api/sales/customers/${cust.id}`, { legal_entity_id: le.body.legalEntity?.id ?? le.body.entity?.id });
    r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
    check("linked legal entity with a tax number -> issued, buyer tax id from the entity", r.status === 200 && /^\d{9}$/.test(r.body.invoice?.buyerTaxId ?? ""), r.body);
  } else {
    check("legal entity created for the tax test", false, le.body);
  }

  section("14. Cash never goes negative, whatever the path");
  const cash = ((await call("karim", "GET", "/api/accounting/cash-accounts")).body.accounts ?? []).find((c: { type: string }) => c.type === "cash");
  r = await call("karim", "POST", "/api/accounting/payments", { supplier_id: sup.id, cash_account_id: cash?.id, amount: "999999999", date: today, method: "cash" });
  check("a payment larger than the box -> 409, nothing posted", r.status === 409 && /بالسالب|below zero|Not enough/.test(r.body.error), r.body);

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
