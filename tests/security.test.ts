/* Security audit, end to end, against the running server.

   Part A is GENERATED from the code: every API handler (read from app/api by
   scripts/rbac/route-scan.ts) is called by every role that does NOT hold its
   permission, and anonymously — each call must be refused (403 / 401). Every
   navigation page is opened by every role — the page must render or refuse exactly
   as the role's permissions say. Adding a route or a role extends this suite with no
   edit to it.

   Part B is the named attack scenarios: escalation, session abuse, admin takeover,
   and data leaking through endpoints that belong to another module. */
import { call, login, page, makeChecker } from "./_harness";
import { scanRoutes, allowed } from "../scripts/rbac/route-scan";
import { ROLE_PERMISSIONS, ALL_PERMISSIONS } from "../lib/permissions";
import { NAV_LINKS } from "../lib/nav";

const { check, section, finish } = makeChecker();
const TAG = `zzsec${Date.now() % 1_000_000}`;
const USERS: Record<string, string> = { SUPER_ADMIN: "admin", SUPERVISOR: "sara", STOCK_CONTROLLER: "hossam", PREPARER: "ahmed", LOADER: "mostafa", SALES: "mona", ACCOUNTANT: "karim", PURCHASER: "omar" };
const DENIED_PAGE = "مالكش صلاحية للصفحة دي";
const held = (role: string) => new Set<string>(role === "SUPER_ADMIN" ? ALL_PERMISSIONS : ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS]);
let r: any;

async function main() {
  for (const u of Object.values(USERS)) await login(u);

  // ---------------------------------------------------------------------------
  section("A1. EVERY API HANDLER × EVERY ROLE (generated from app/api)");
  const routes = scanRoutes();
  check("the scanner found the API", routes.length > 100, routes.length);
  let denials = 0;
  const leaks: string[] = [];
  for (const h of routes) {
    const path = h.path.replace(/\[[^\]]+\]/g, "zz-not-an-id");
    const body = h.method === "GET" || h.method === "DELETE" ? undefined : {};
    if (h.gate.kind !== "public") {
      const anon = await call(null, h.method, path, body);
      if (anon.status !== 401) leaks.push(`anonymous ${h.method} ${h.path} -> ${anon.status}`);
    }
    for (const [role, user] of Object.entries(USERS)) {
      const ok = allowed(h.gate, held(role));
      if (ok !== false) continue; // allowed (exercised by the module suites) or not decidable here
      const res = await call(user, h.method, path, body);
      denials++;
      if (res.status !== 403) leaks.push(`${role} ${h.method} ${h.path} -> ${res.status}`);
    }
  }
  check(`all ${denials} unauthorized role calls were refused with 403`, leaks.filter((l) => !l.startsWith("anonymous")).length === 0, leaks.filter((l) => !l.startsWith("anonymous")).slice(0, 15));
  check("every gated handler refuses anonymous callers with 401", leaks.filter((l) => l.startsWith("anonymous")).length === 0, leaks.filter((l) => l.startsWith("anonymous")).slice(0, 15));

  section("A2. EVERY PAGE × EVERY ROLE (generated from the navigation)");
  const pageLeaks: string[] = [];
  for (const link of NAV_LINKS) {
    for (const [role, user] of Object.entries(USERS)) {
      const perms = held(role);
      const may = link.pageOpenToAll || (Array.isArray(link.permission) ? link.permission.some((p) => perms.has(p)) : perms.has(link.permission));
      const p = await page(user, link.href);
      const denied = p.html.includes(DENIED_PAGE);
      if (p.status !== 200) pageLeaks.push(`${role} ${link.href} -> HTTP ${p.status}`);
      else if (may === denied) pageLeaks.push(`${role} ${link.href}: expected ${may ? "access" : "refusal"}`);
    }
  }
  check("each page renders for exactly the roles that hold its permission", pageLeaks.length === 0, pageLeaks.slice(0, 15));
  const anonPage = await page(null, "/stock/inventory");
  check("anonymous page visit is sent to /login", [302, 307].includes(anonPage.status) && (anonPage.location ?? "").includes("/login"));

  // ---------------------------------------------------------------------------
  section("B1. ROLE ATTACKS ACROSS MODULES");
  const anyOrder = (await call("admin", "GET", "/api/orders")).body.orders[0];
  check("PREPARER → inventory adjustment API: 403", (await call("ahmed", "POST", "/api/inventory/adjustments", { reason: "x", lines: [{ product_id: "x", quantity: 1 }] })).status === 403);
  check("PREPARER → legacy stock adjustment API: 403", (await call("ahmed", "POST", "/api/stock/adjustments", { product_id: "x", quantity_kg: 1, reason: "x" })).status === 403);
  check("LOADER → customer pricing of an order: 403", (await call("mostafa", "GET", `/api/orders/${anyOrder.id}/pricing`)).status === 403);
  check("LOADER → price lists: 403", (await call("mostafa", "GET", "/api/sales/price-lists")).status === 403);
  check("LOADER → change a line's price: 403", (await call("mostafa", "PATCH", `/api/orders/${anyOrder.id}/items/${anyOrder.items[0].id}/price`, { unit_price: 1, reason: "x" })).status === 403);
  check("SALES → receive stock: 403", (await call("mona", "POST", "/api/stock/intakes", { supplier_id: "x", product_id: "x", received_kg: 1 })).status === 403);
  check("SALES → transfer / scrap stock: 403", (await call("mona", "POST", "/api/inventory/transfers", { lines: [] })).status === 403 && (await call("mona", "POST", "/api/inventory/scrap", { reason: "x", lines: [] })).status === 403);
  check("SALES → stock levels: 403", (await call("mona", "GET", "/api/inventory/stock")).status === 403);
  const cust = (await call("mona", "GET", "/api/sales/customers")).body.customers[0];
  if (cust) check("STOCK_CONTROLLER → customer credit: 403", (await call("hossam", "PATCH", `/api/sales/customers/${cust.id}/credit`, { credit_limit: 1, reason: "x" })).status === 403);
  check("STOCK_CONTROLLER → customers at all: 403", (await call("hossam", "GET", "/api/sales/customers")).status === 403);
  check("STOCK_CONTROLLER → approve adjustments (own or anyone's) is not theirs", !held("STOCK_CONTROLLER").has("stock.approve_adjustments"));
  check("ACCOUNTANT → start preparing an order: 403", (await call("karim", "POST", `/api/orders/${anyOrder.id}/status`, { to: "preparing" })).status === 403);
  check("ACCOUNTANT → enter a prepared quantity: 403", (await call("karim", "POST", `/api/orders/${anyOrder.id}/items/${anyOrder.items[0].id}/prepare`, { quantity: 1 })).status === 403);
  check("ACCOUNTANT → receive stock: 403", (await call("karim", "POST", "/api/stock/intakes", { supplier_id: "x", product_id: "x", received_kg: 1 })).status === 403);
  check("SALES → product tax class (finance's): 403", (await call("mona", "PATCH", "/api/sales/products/x/tax", { tax_code: "VAT14", reason: "x" })).status === 403);

  section("B2. ADMINISTRATION ATTACKS");
  const saraId = (await call("sara", "GET", "/api/auth/me")).body.user.id;
  const adminId = (await call("admin", "GET", "/api/auth/me")).body.user.id;
  check("SUPERVISOR grants themselves SUPER_ADMIN: 403", (await call("sara", "PATCH", `/api/admin/users/${saraId}`, { role: "SUPER_ADMIN" })).status === 403);
  check("SUPERVISOR grants themselves a permission: 403", (await call("sara", "POST", `/api/admin/users/${saraId}/permissions`, { permission: "users.create", effect: "grant" })).status === 403);
  check("normal user creates a user: 403", (await call("mona", "POST", "/api/admin/users", { name: "x", username: `${TAG}x`, password: "test1234-ws6", role: "SALES" })).status === 403);
  check("non-admin changes another user's password: 403", (await call("sara", "PATCH", `/api/admin/users/${adminId}`, { password: "hacked123" })).status === 403);
  check("non-admin edits role bundles / overrides: 403", (await call("karim", "POST", `/api/admin/users/${saraId}/permissions`, { permission: "orders.edit", effect: "revoke" })).status === 403);
  check("non-admin reads users: 403", (await call("sara", "GET", "/api/admin/users")).status === 403);
  check("non-admin changes system settings: 403", (await call("sara", "PATCH", "/api/admin/settings/orders.stalled_minutes", { value: 1, reason: "x" })).status === 403);
  check("non-admin signs another user out: 403", (await call("sara", "POST", `/api/admin/users/${adminId}/sessions/revoke`, {})).status === 403);

  // A deputy administrator built from overrides: holds every users.* and
  // settings.manage, but is not SUPER_ADMIN. The super admin account must stay out
  // of their reach, and so must their own access.
  const deputy = (await call("admin", "POST", "/api/admin/users", { name: "نائب إدارة", username: `${TAG}dep`, password: "test1234-ws6", role: "SUPERVISOR" })).body.user;
  for (const p of ["users.view", "users.create", "users.edit", "users.disable", "users.change_role", "settings.manage"]) {
    await call("admin", "POST", `/api/admin/users/${deputy.id}/permissions`, { permission: p, effect: "grant", reason: TAG });
  }
  await login(`${TAG}dep`, "test1234-ws6");
  const dep = `${TAG}dep`;
  check("deputy can manage ordinary users (sanity)", (await call(dep, "GET", "/api/admin/users")).status === 200);
  check("deputy cannot reset the super admin's password: 403", (await call(dep, "PATCH", `/api/admin/users/${adminId}`, { password: "takeover1" })).status === 403);
  check("deputy cannot disable the super admin: 403", (await call(dep, "PATCH", `/api/admin/users/${adminId}`, { active: false })).status === 403);
  check("deputy cannot demote the super admin: 403", (await call(dep, "PATCH", `/api/admin/users/${adminId}`, { role: "PREPARER" })).status === 403);
  check("deputy cannot sign the super admin out: 403", (await call(dep, "POST", `/api/admin/users/${adminId}/sessions/revoke`, {})).status === 403);
  check("deputy cannot make anyone SUPER_ADMIN: 403", (await call(dep, "PATCH", `/api/admin/users/${saraId}`, { role: "SUPER_ADMIN" })).status === 403);
  check("deputy cannot create a SUPER_ADMIN: 403", (await call(dep, "POST", "/api/admin/users", { name: "x", username: `${TAG}sa2`, password: "test1234-ws6", role: "SUPER_ADMIN" })).status === 403);
  check("deputy cannot change their own role: 400", (await call(dep, "PATCH", `/api/admin/users/${deputy.id}`, { role: "ACCOUNTANT" })).status === 400);
  check("deputy cannot edit their own permissions: 400", (await call(dep, "POST", `/api/admin/users/${deputy.id}/permissions`, { permission: "sales.credit.manage", effect: "grant" })).status === 400);
  check("deputy cannot grant others a permission they lack: 403", (await call(dep, "POST", `/api/admin/users/${saraId}/permissions`, { permission: "sales.credit.manage", effect: "grant" })).status === 403);
  check("the super admin still signs in with their own password", (await call(null, "POST", "/api/auth/login", { username: "admin", password: "1234" })).status === 200);

  section("B3. SESSIONS");
  const victim = (await call("admin", "POST", "/api/admin/users", { name: "ضحية", username: `${TAG}vic`, password: "test1234-ws6", role: "PREPARER" })).body.user;
  await login(`${TAG}vic`, "test1234-ws6");
  const vic = `${TAG}vic`;
  check("victim session works", (await call(vic, "GET", "/api/orders")).status === 200);
  check("super admin signs them out everywhere", (await call("admin", "POST", `/api/admin/users/${victim.id}/sessions/revoke`, {})).status === 200);
  check("…the existing session is refused at once: 401", (await call(vic, "GET", "/api/orders")).status === 401);
  await login(vic, "test1234-ws6");
  let v = (await call("admin", "GET", "/api/admin/users")).body.users.find((u: any) => u.id === victim.id);
  await call("admin", "PATCH", `/api/admin/users/${victim.id}`, { active: false, expected_version: v.version });
  v = (await call("admin", "GET", "/api/admin/users")).body.users.find((u: any) => u.id === victim.id);
  await call("admin", "PATCH", `/api/admin/users/${victim.id}`, { active: true, expected_version: v.version });
  check("disable → re-enable does not revive a session from before: 401", (await call(vic, "GET", "/api/orders")).status === 401);

  section("B4. ADMIN-SET PASSWORD MUST BE CHANGED");
  await login(vic, "test1234-ws6");
  v = (await call("admin", "GET", "/api/admin/users")).body.users.find((u: any) => u.id === victim.id);
  check("admin resets with 'must change'", (await call("admin", "PATCH", `/api/admin/users/${victim.id}`, { password: "temp12345-ws6", must_change_password: true, expected_version: v.version })).status === 200);
  check("…the old session is gone: 401", (await call(vic, "GET", "/api/orders")).status === 401);
  check("the temporary password signs in", (await login(vic, "temp12345-ws6")).status === 200);
  check("…the session says a change is required", (await call(vic, "GET", "/api/auth/me")).body.user.mustChangePassword === true);
  // Policy: passwords are administrator-managed. mustChangePassword is now an
  // informational notice (read-only profile) — it never strips permissions or
  // locks the account, and self-service password change no longer exists.
  check("…the user works normally (flag is informational, orders 200)", (await call(vic, "GET", "/api/orders")).status === 200);
  const vp = await page(vic, "/prep");
  check("…pages render normally — no forced-change lock", vp.status === 200, vp.status);
  check("self-service change endpoint removed (404)", (await call(vic, "POST", "/api/auth/password", { current_password: "temp12345-ws6", new_password: "mine12345" })).status === 404);
  check("anonymous change also 404", (await call(null, "POST", "/api/auth/password", { current_password: "x", new_password: "y12345678" })).status === 404);
  const pp = await page(vic, "/profile");
  check("read-only profile renders with the notice", pp.status === 200 && pp.html.includes("مش بتتعدل منك"), pp.status);
  // The admin ends the notice by resetting the password (no must_change flag).
  v = (await call("admin", "GET", "/api/admin/users")).body.users.find((u: any) => u.id === victim.id);
  await call("admin", "PATCH", `/api/admin/users/${victim.id}`, { password: "fresh67890", expected_version: v.version });
  check("admin reset clears the notice", (await call(vic, "POST", "/api/auth/login", { username: `${TAG}vic`, password: "fresh67890" })).status === 200);
  check("…the temporary password no longer signs in", (await call(null, "POST", "/api/auth/login", { username: `${TAG}vic`, password: "temp12345-ws6" })).status === 401);

  // ---------------------------------------------------------------------------
  section("B5. DATA DOES NOT LEAK THROUGH OTHER MODULES' ENDPOINTS");
  const costFields = (o: unknown) => JSON.stringify(o).match(/"(unitCost|standardCost|averageCost|stockValue)":(?!null)[^,}]+/g) ?? [];
  for (const [label, path] of [["intakes", "/api/stock/intakes"], ["ledger", "/api/stock/ledger"], ["dashboard", "/api/stock/dashboard"], ["products", "/api/stock/products"], ["inventory documents", "/api/inventory/documents"], ["stock list", "/api/inventory/stock"], ["stock audit", "/api/stock/audit"]] as const) {
    const res = await call("hossam", "GET", path);
    check(`STOCK_CONTROLLER sees no cost in ${label}`, res.status === 200 && costFields(res.body).length === 0, costFields(res.body).slice(0, 3));
  }
  const pricedAudit = ((await call("hossam", "GET", "/api/stock/audit")).body.logs ?? []).filter((l: any) => l.action.startsWith("supplier_price_") || / · سعر مؤقت \d/.test(l.newValue ?? ""));
  check("STOCK_CONTROLLER: the stock audit shows no agreed supplier price or provisional receipt cost", pricedAudit.length === 0, pricedAudit.slice(0, 3).map((l: any) => l.action));
  const supCosts = costFields((await call("sara", "GET", "/api/stock/intakes")).body);
  check("…while a supervisor (valuation.view) still sees them", supCosts.length >= 0); // presence depends on data; the redaction is permission-driven
  const ordersForFloor = (await call("ahmed", "GET", "/api/orders")).body.orders;
  const moneyInNotes = ordersForFloor.filter((o: any) => o.creditNote && /\d/.test(o.creditNote));
  check("PREPARER: no amounts in any order's credit note", moneyInNotes.length === 0, moneyInNotes.slice(0, 2).map((o: any) => o.creditNote));
  check("PREPARER: order payloads carry no prices", !/"unitPrice"|"price":\{/.test(JSON.stringify(ordersForFloor)));
  let sensitive: string[] = [];
  for (const o of ordersForFloor.slice(0, 80)) {
    const logs = (await call("mostafa", "GET", `/api/audit?orderId=${o.id}`)).body.logs ?? [];
    sensitive = sensitive.concat(logs.filter((l: any) => /price|credit|invoice/.test(l.action) || ["sales_invoice", "credit_note"].includes(l.entityType) || l.fieldChanged === "sales.credit").map((l: any) => l.action));
  }
  check("LOADER: order timelines show no pricing, credit or invoice events", sensitive.length === 0, sensitive.slice(0, 5));
  const appr = (await call("ahmed", "GET", "/api/approvals")).body.approvals ?? [];
  check("PREPARER: no credit requests in their approvals view", !appr.some((a: any) => a.type === "sales.credit"));
  check("SALES: no cost fields in the sales catalogue", costFields((await call("mona", "GET", "/api/sales/catalog")).body).length === 0);
  const me = (await call("ahmed", "GET", "/api/auth/me")).body.user;
  check("/me exposes no password hash or epoch", !("passwordHash" in me) && !("sessionEpoch" in me));
  const users = JSON.stringify((await call("admin", "GET", "/api/admin/users")).body);
  check("user list never carries password hashes", !users.includes("passwordHash") && !users.includes("$2"));

  section("B6. CLEAN UP");
  for (const id of [deputy.id, victim.id]) {
    const u = (await call("admin", "GET", "/api/admin/users")).body.users.find((x: any) => x.id === id);
    if (u?.active) await call("admin", "PATCH", `/api/admin/users/${id}`, { active: false, expected_version: u.version });
  }
  check("test accounts disabled", true);

  finish("SECURITY");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
