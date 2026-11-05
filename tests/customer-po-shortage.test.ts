// Customer PO intake / orders waiting for stock (Nov 2026), through the API as the screens and
// the integration call it: the PO reference is stored and searchable; a short order is still
// refused by default (manual and n8n alike) and saved "awaiting stock" only on request; the
// order is off the floor boards and cannot start; purchasing sees the line suggestion; a
// receipt tells the order's people; only orders.edit may re-check and release it; then the
// order continues the normal workflow. Gates are checked per role server-side.
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZCPOE${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz();

async function main() {
  for (const u of ["admin", "sara", "hossam", "mona", "ahmed", "omar"]) await login(u);
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد`, category: "vegetable" })).body.supplier;
  const kg = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} طماطم`, unit: "KG" })).body.product;
  const cust = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} فندق` })).body.customer;
  const intake = (qty: number) => call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: kg.id, received_kg: qty, unit_cost: "10", received_date: today });
  await intake(4);
  const body = (extra: Record<string, unknown> = {}) => ({ customer_account_id: cust.id, customer_name: cust.name, delivery_date: today, items: [{ stock_product_id: kg.id, quantity: 10, unit: "KG" }], ...extra });

  section("1. Default unchanged: a short order is refused (manual and integration)");
  let r = await call("mona", "POST", "/api/orders", body({ customer_po_ref: `${TAG}-PO` }));
  check("manual short order without the flag -> 409 stock_unavailable", r.status === 409 && r.body.code === "stock_unavailable", r.body);
  check("…its shortfall carries the shortage", r.body.details?.shortfalls?.[0]?.shortage === "6", r.body.details);
  r = await call(null, "POST", "/api/orders", { external_id: `${TAG}-n8n-1`, source: "n8n", customer_name: cust.name, delivery_date: today, items: [{ product_name: kg.name, stock_product_id: kg.id, quantity: 10, unit: "KG" }] }, { "x-api-key": process.env.N8N_API_KEY! });
  check("n8n short order without the flag -> 409", r.status === 409, [r.status, r.body?.code]);

  section("2. Saved awaiting stock on request");
  r = await call("mona", "POST", "/api/orders", body({ customer_po_ref: `${TAG}-PO`, allow_shortage: true }));
  check("sales saves it awaiting stock -> 201", r.status === 201 && r.body.order.stockStatus === "awaiting_stock" && r.body.order.customerPoRef === `${TAG}-PO`, r.body);
  const o = r.body.order;
  r = await call(null, "POST", "/api/orders", { external_id: `${TAG}-n8n-2`, source: "n8n", customer_name: cust.name, customer_po_ref: `${TAG}-PO-N8N`, allow_shortage: true, delivery_date: today, items: [{ product_name: kg.name, stock_product_id: kg.id, quantity: 10, unit: "KG" }] }, { "x-api-key": process.env.N8N_API_KEY! });
  check("n8n with allow_shortage -> 201 awaiting stock", r.status === 201 && r.body.order?.stockStatus === "awaiting_stock", [r.status, r.body?.order?.stockStatus, r.body?.error]);
  r = await call("mona", "GET", `/api/orders?q=${encodeURIComponent(`${TAG}-PO`)}`);
  check("searchable by the customer PO reference", r.status === 200 && r.body.orders.some((x: { id: string }) => x.id === o.id), r.body);
  r = await call("ahmed", "GET", "/api/orders?status=new,preparing&stock=ok");
  check("not on the preparation board", r.status === 200 && !r.body.orders.some((x: { id: string }) => x.id === o.id));
  check("bad stock filter -> 400", (await call("ahmed", "GET", "/api/orders?stock=maybe")).status === 400);
  r = await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
  check("preparer cannot start it -> 409 stock_awaiting", r.status === 409 && r.body.code === "stock_awaiting", r.body);

  section("3. Per-line stock and suggestions (role-gated)");
  r = await call("mona", "GET", `/api/orders/${o.id}/stock`);
  check("stock view: requested 10 / available 4 / short 6", r.status === 200 && r.body.lines?.[0]?.shortage === "6" && r.body.lines[0].available === "4" && r.body.releasable === false, r.body);
  check("…sales sees the linked suggestion", r.body.suggestions?.length === 1 && r.body.suggestions[0].quantity === "6", r.body.suggestions);
  const pr = r.body.suggestions?.[0];
  r = await call("ahmed", "GET", `/api/orders/${o.id}/stock`);
  check("preparer sees the lines but not the purchase requests", r.status === 200 && r.body.suggestions === null, r.body);
  r = await call("omar", "GET", `/api/purchasing/requests?q=${encodeURIComponent(`${TAG}-PO`)}`);
  check("purchasing sees the suggestion with its order", r.status === 200 && r.body.items.some((x: { id: string; order: { id: string } | null }) => x.id === pr?.id && x.order?.id === o.id), r.body);
  check("stock controller cannot list purchase requests -> 403", (await call("hossam", "GET", "/api/purchasing/requests")).status === 403);

  section("4. Release: orders.edit only, everything or nothing");
  for (const who of ["mona", "omar", "hossam", "ahmed"]) {
    r = await call(who, "POST", `/api/orders/${o.id}/release-stock`, {});
    check(`${who} cannot release -> 403`, r.status === 403, r.status);
  }
  r = await call("sara", "POST", `/api/orders/${o.id}/release-stock`, {});
  check("supervisor release while short -> 409 with the shortfalls", r.status === 409 && r.body.code === "stock_unavailable" && r.body.details?.shortfalls?.length === 1, r.body);
  r = await intake(6);
  check("stock arrives", r.status === 201 || r.status === 200, r.body);
  r = await call("mona", "GET", "/api/notifications");
  const note = (r.body.items ?? r.body.notifications ?? []).find((n: { entityId: string; type: string }) => n.entityId === o.id && n.type === "order.stock_ready");
  check("the order's creator is notified", !!note, r.body);
  r = await call("mona", "GET", `/api/orders/${o.id}`);
  check("…the order is still waiting, in new (nothing automatic)", r.body.order?.stockStatus === "awaiting_stock" && r.body.order.status === "new", r.body.order);
  r = await call("sara", "POST", `/api/orders/${o.id}/release-stock`, { expected_version: 999 });
  check("stale version -> 409", r.status === 409, r.body);
  r = await call("sara", "POST", `/api/orders/${o.id}/release-stock`, {});
  check("supervisor release -> 200, stock ok", r.status === 200 && r.body.order.stockStatus === "ok" && r.body.order.customerPoRef === `${TAG}-PO`, r.body);
  r = await call("ahmed", "GET", "/api/orders?status=new,preparing&stock=ok");
  check("now on the preparation board", r.body.orders.some((x: { id: string }) => x.id === o.id));
  r = await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
  check("preparation starts -> 200", r.status === 200, r.body);
  r = await call("omar", "GET", `/api/purchasing/requests/${pr?.id}`);
  check("the suggestion was closed as covered", r.status === 200 && r.body.request.status === "cancelled", r.body.request?.status);

  finish("CUSTOMER-PO-SHORTAGE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
