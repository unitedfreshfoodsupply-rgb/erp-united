/* ZERO-500: a wrong request is the client's fault and must get a 4xx with a message,
   never a "server error". Generated from app/api like the security suite: every handler
   is called with malformed and hostile input (wrong JSON, wrong field types, NUL bytes,
   huge numbers, impossible dates, unknown ids) and every page with hostile query
   strings, by every role. Any 5xx fails — except 503 from an ETA endpoint, which is the
   designed answer while ETA is not configured.

   Bodies here are invalid by construction, so the suite changes no business data. */
import { call, login, page, makeChecker, BASE, cookieFor } from "./_harness";
import { setSetting } from "./_stock";
import { scanRoutes } from "../scripts/rbac/route-scan";

const { check, section, finish } = makeChecker();
const USERS = ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"];
const FIELDS =
  "id name code reason note notes comment status action decision quantity qty quantity_kg received_kg rejected_kg amount unit_cost unit_price price date business_date due_date expiry_date from to lines items customer_id supplier_id product_id location_id warehouse_id account_id idempotency_key expected_version username password role permissions vehicle driver_name customer_name product_name delivery_date delivery_time phone".split(" ");
const every = (v: unknown) => Object.fromEntries(FIELDS.map((k) => [k, v]));
const BODIES: [string, string | undefined][] = [
  ["no body", undefined],
  ["malformed JSON", "{not json"],
  ["JSON array", "[]"],
  ["JSON null", "null"],
  ["numbers for text", JSON.stringify(every(123))],
  ["objects everywhere", JSON.stringify(every({}))],
  ["arrays of junk", JSON.stringify(every([{ a: 1 }, null]))],
  ["NUL byte in text", JSON.stringify(every("a\u0000b"))],
  ["huge numbers", JSON.stringify(every(1e308))],
  ["impossible dates", JSON.stringify(every("2026-02-30"))],
];
const QUERIES = ["", "?q=a%00b&status=%00&from=%00&to=%00", "?from=abc&to=zzz&date=2026-10-08T99&limit=-1&offset=abc", "?customer_id=%00&supplier_id=%00&product_id=%00"];
const fill = (path: string) => path.replace(/\[[^\]]+\]/g, "does-not-exist");
const designed = (path: string, status: number, body: unknown) =>
  status === 503 && path.startsWith("/api/eta/") && /منظومة الفاتورة|ETA/.test(JSON.stringify(body));

async function raw(who: string, method: string, path: string, body?: string) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", cookie: cookieFor(who) ?? "" }, body, redirect: "manual", signal: AbortSignal.timeout(45_000) });
  const t = await r.text();
  let parsed: unknown = t;
  try { parsed = JSON.parse(t); } catch {}
  return { status: r.status, body: parsed };
}

async function main() {
  for (const u of USERS) await login(u);
  const routes = scanRoutes().filter((r) => !r.path.startsWith("/api/auth/"));
  check("the scanner found the API", routes.length > 100, routes.length);

  section("1. EVERY MUTATION × HOSTILE BODIES (super admin: past every permission gate)");
  let n = 0;
  for (const r of routes.filter((x) => x.method !== "GET")) {
    for (const [label, body] of BODIES) {
      const res = await raw("admin", r.method, fill(r.path), body);
      n++;
      const ok = res.status < 500 || designed(r.path, res.status, res.body);
      check(`${r.method} ${r.path} [${label}] → ${res.status}`, ok, res.body);
      if (ok && res.status >= 400) check(`${r.method} ${r.path} [${label}] explains the refusal`, typeof (res.body as any)?.error === "string" && (res.body as any).error.length > 0, res.body);
    }
  }
  console.log(`  ${n} hostile mutations`);

  section("2. EVERY READ × HOSTILE QUERY STRINGS");
  n = 0;
  for (const r of routes.filter((x) => x.method === "GET")) {
    for (const q of QUERIES) {
      const res = await raw("admin", "GET", fill(r.path) + q);
      n++;
      check(`GET ${r.path}${q.slice(0, 40)} → ${res.status}`, res.status < 500 || designed(r.path, res.status, res.body), res.body);
    }
  }
  console.log(`  ${n} hostile reads`);

  section("3. EVERY ROLE × HOSTILE BODY (the refusal path of each role is also clean)");
  for (const u of USERS.slice(1)) {
    for (const r of routes.filter((x) => x.method !== "GET")) {
      const res = await raw(u, r.method, fill(r.path), JSON.stringify(every(123)));
      check(`${u} ${r.method} ${r.path} → ${res.status}`, res.status < 500 || designed(r.path, res.status, res.body), res.body);
    }
  }

  section("4. EVERY PAGE × EVERY ROLE × HOSTILE QUERY / UNKNOWN ID");
  const pages = ["/profile", "/accounting", "/admin", "/approvals", "/eta", "/hr", "/load", "/management", "/management/operations", "/operations", "/prep", "/production", "/purchasing", "/sales", "/stock", "/stock/entries", "/stock/inventory", "/stock/ledger", "/stock/setup", "/supervisor", "/supervisor/audit", "/supervisor/exceptions", "/supervisor/report", "/supervisor/report/print", "/orders/does-not-exist", "/orders/does-not-exist/print/delivery", "/orders/does-not-exist/print/dispatch", "/orders/does-not-exist/print/picking", "/sales/invoices/does-not-exist/print"];
  for (const u of USERS) for (const p of pages) for (const q of ["", "?date=garbage&from=x&to=y&tab=%00&status=%00&q=%00&lang=xx"]) {
    const res = await page(u, p + q);
    check(`${u} page ${p}${q ? " (hostile query)" : ""} → ${res.status}`, res.status < 500, res.status);
  }
  const missing = await page("karim", "/sales/invoices/does-not-exist/print");
  check("an unknown invoice's print page is a 404, not a server error", missing.status === 404, missing.status);

  section("5. NAMED REGRESSIONS (each was a 500 before the ZERO-500 pass)");
  let r = await call("admin", "POST", "/api/stock/products", { name: 7 });
  check("product with a numeric name → 400 naming the field", r.status === 400 && /name/.test(r.body.error), r);
  r = await call("admin", "POST", "/api/stock/suppliers", { name: { x: 1 } });
  check("supplier with an object name → 400", r.status === 400, r);
  r = await call("admin", "POST", "/api/orders/does-not-exist/cancel", { reason: 5 });
  check("cancel with a numeric reason → 400 (not a TypeError)", r.status === 400, r);
  r = await call("admin", "POST", "/api/sales/customers/map", { customer_name: "a\u0000b" });
  check("NUL byte in a text field → 400", r.status === 400 && /NUL/.test(r.body.error), r);
  r = await call("admin", "GET", "/api/sales/customers?q=a%00b");
  check("NUL byte in a search → 400", r.status === 400, r);
  // CTL-01: direct opening stock is closed by default (409 before any input is read); the
  // input-robustness check needs the direct path open, so it is switched on for this call.
  r = await call("admin", "POST", "/api/accounting/opening-stock", { warehouse_id: [{ a: 1 }], lines: [{ product_id: "x", quantity: 1, unit_cost: "1" }] });
  check("opening stock while direct opening is OFF (default) → 409 direct_opening_disabled, not a 500", r.status === 409 && r.body?.code === "direct_opening_disabled", r);
  await setSetting("accounting.direct_opening_entries", true, "robustness: opening-stock input check");
  r = await call("admin", "POST", "/api/accounting/opening-stock", { warehouse_id: [{ a: 1 }], lines: [{ product_id: "x", quantity: 1, unit_cost: "1" }] });
  await setSetting("accounting.direct_opening_entries", null, "robustness: opening-stock input check done");
  check("opening stock with an object as warehouse → 400", r.status === 400, r);
  r = await call("admin", "GET", "/api/stock/dashboard?date=2026-10-08T99");
  check("dashboard with an impossible date → 400", r.status === 400, r);

  finish("ZERO-500 ROBUSTNESS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
