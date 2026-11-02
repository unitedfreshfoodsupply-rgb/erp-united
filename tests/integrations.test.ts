/* Integrations: per-channel keys (created once, hashed, scoped, revocable), idempotent
   order intake from n8n/Hermes, validation, status read-back across the chain, and an
   append-only log of every call — accepted or refused. */
import { BASE, call, login, makeChecker } from "./_harness";
import { stockedProduct } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `zzint${Date.now() % 1_000_000_000}`;
let r: any;

const withKey = async (key: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function main() {
  for (const u of ["admin", "sara", "karim"]) await login(u);

  section("1. KEYS");
  check("only the system administrator manages integrations -> 403", (await call("sara", "GET", "/api/admin/integrations")).status === 403 && (await call("karim", "POST", "/api/admin/integrations", { code: "x", name: "x", scopes: ["orders.create"] })).status === 403);
  r = await call("admin", "POST", "/api/admin/integrations", { code: `${TAG}a`, name: "n8n WhatsApp", scopes: ["orders.create", "orders.status"] });
  check("a key is issued once", r.status === 201 && /^uk_/.test(r.body.key) && r.body.integration.keyPrefix === r.body.key.slice(0, 8), r.body);
  const key = r.body.key;
  const statusOnly = (await call("admin", "POST", "/api/admin/integrations", { code: `${TAG}b`, name: "dashboard", scopes: ["orders.status"] })).body;
  check("the key is never shown again (only its prefix)", !JSON.stringify((await call("admin", "GET", "/api/admin/integrations")).body).includes(key));
  check("an unknown scope -> 400", (await call("admin", "POST", "/api/admin/integrations", { code: `${TAG}c`, name: "x", scopes: ["stock.adjust"] })).status === 400);

  section("2. ORDER INTAKE");
  // WF-01: the channel's lines must name a catalog product with sellable stock (the
  // seed's free-text "طماطم" is not a catalog card). A run-unique stocked card is used.
  const tomato = await stockedProduct(`${TAG} طماطم`, 100);
  const order = { external_id: `${TAG}-msg-1`, customer_name: `${TAG} مطعم البحر`, delivery_date: "2026-12-20", items: [{ product_name: tomato.name, quantity: 12, unit: "KG" }] };
  check("a wrong key -> 401", (await withKey("uk_wrong", "POST", "/api/orders", order)).status === 401);
  check("a status-only key cannot create orders -> 403", (await withKey(statusOnly.key, "POST", "/api/orders", order)).status === 403);
  check("invalid payload -> 400 (validated like any order)", (await withKey(key, "POST", "/api/orders", { ...order, external_id: `${TAG}-bad`, delivery_date: "tomorrow" })).status === 400);
  r = await withKey(key, "POST", "/api/orders", { ...order, external_id: `${TAG}-unmapped`, items: [{ product_name: "طماطم", quantity: 12, unit: "KG" }] });
  check("a product the catalog does not know -> 409 (unmapped), not created", r.status === 409 && r.body?.details?.shortfalls?.[0]?.reason === "unmapped", r.body);
  r = await withKey(key, "POST", "/api/orders", order);
  check("the channel creates an order -> 201", r.status === 201 && r.body.order.externalId === order.external_id, r.body);
  const created = r.body.order;
  r = await withKey(key, "POST", "/api/orders", order);
  check("the same message again returns the same order (idempotent)", [200, 201].includes(r.status) && r.body.order.id === created.id);
  const both = await Promise.all([1, 2, 3].map(() => withKey(key, "POST", "/api/orders", { ...order, external_id: `${TAG}-race` })));
  check("three simultaneous retries make one order", new Set(both.map((x) => x.body?.order?.id)).size === 1, both.map((x) => x.status));
  const legacy = process.env.N8N_API_KEY;
  if (legacy) check("the shared legacy key still works (n8n flows keep running)", (await withKey(legacy, "POST", "/api/orders", { ...order, external_id: `${TAG}-legacy` })).status === 201);

  section("3. STATUS READ-BACK");
  check("a signed-in user cannot use the channel endpoint -> 401", (await call("admin", "GET", `/api/integrations/orders/${order.external_id}`)).status === 401);
  r = await withKey(statusOnly.key, "GET", `/api/integrations/orders/${order.external_id}`);
  check("status: order number and state, nothing commercial", r.status === 200 && r.body.order.orderNumber === created.orderNumber && r.body.order.status === "new" && !/"(total|unitPrice|net|amount)":/.test(JSON.stringify(r.body)), r.body);
  check("an unknown external id -> 404", (await withKey(key, "GET", `/api/integrations/orders/${TAG}-nope`)).status === 404);

  section("4. REVOCATION AND LOG");
  check("revoke the status key", (await call("admin", "POST", `/api/admin/integrations/${statusOnly.integration.id}/revoke`, {})).body.integration?.active === false);
  check("…it stops working at once -> 401", (await withKey(statusOnly.key, "GET", `/api/integrations/orders/${order.external_id}`)).status === 401);
  const logs = (await call("admin", "GET", "/api/admin/integrations")).body.logs;
  const mine = logs.filter((l: any) => (l.externalId ?? "").startsWith(TAG) || l.caller.startsWith(TAG) || l.caller === "unknown");
  check("every call is logged with its outcome", mine.some((l: any) => l.status === 201 && l.result === created.orderNumber) && mine.some((l: any) => l.status === 401) && mine.some((l: any) => l.status === 403) && mine.some((l: any) => l.status === 400), mine.map((l: any) => [l.caller, l.status]).slice(0, 12));
  check("…and the key itself never appears in the log", !JSON.stringify(logs).includes(key));
  finish("INTEGRATIONS");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
