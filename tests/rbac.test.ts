/* RBAC matrix: every role x every permission group, direct API + direct route access,
   disabled users, escalation attempts, last-super-admin protection, audit. */
import { call, page, login, makeChecker } from "./_harness";

const TAG = `zzrbac${Date.now().toString().slice(-8)}`;
const { check, section, finish } = makeChecker();
const ROLES_U = ["admin", "sara", "hossam", "ahmed", "mostafa"];
const isDenied = (p: { status: number; html: string }) => p.status === 200 && p.html.includes("مالكش صلاحية للصفحة دي");
const createdUserIds: string[] = [];

async function main() {
  section("0. SIGN IN AS EVERY ROLE");
  for (const [u, role] of [["admin","SUPER_ADMIN"],["sara","SUPERVISOR"],["hossam","STOCK_CONTROLLER"],["ahmed","PREPARER"],["mostafa","LOADER"],["mona","SALES"],["karim","ACCOUNTANT"],["omar","PURCHASER"]] as const) {
    const r = await login(u);
    check(`login ${u} -> ${role}`, r.status === 200 && r.body?.user?.role === role, r.body);
  }
  const me = await call("admin", "GET", "/api/auth/me");
  // 21 original + core.masterdata.view/manage (ERP Phase 1) + stock.transfer / reserve /
  // approve_adjustments / valuation.view (Phase 2) + sales.customers.view/manage,
  // sales.credit.manage, sales.pricing.view/manage, sales.price_override,
  // sales.quotations.view/manage, sales.invoices.view/manage (Phase 3),
  // sales.tax.manage (RBAC audit), 10 purchasing.* (Phase 4). Update deliberately
  // when the catalogue grows.
  check("session exposes all 84 permissions for SUPER_ADMIN", me.body?.user?.permissions?.length === 84, me.body?.user?.permissions?.length);
  check("PREPARER has exactly orders.view + orders.prepare",
    JSON.stringify((await call("ahmed","GET","/api/auth/me")).body.user.permissions.sort()) === JSON.stringify(["orders.prepare","orders.view"]));
  check("LOADER has exactly view/load/dispatch",
    JSON.stringify((await call("mostafa","GET","/api/auth/me")).body.user.permissions.sort()) === JSON.stringify(["orders.dispatch","orders.load","orders.view"]));
  const hossamPerms = (await call("hossam","GET","/api/auth/me")).body.user.permissions;
  // Still walled off from orders. Phase 2 adds stock.transfer and stock.reserve — but NOT
  // approving their own adjustments, nor seeing stock value.
  // stock.* plus reading purchase orders (quantities) to receive against them.
  check("STOCK_CONTROLLER holds only stock.* (+ reading POs)", hossamPerms.every((p: string) => p.startsWith("stock.") || p === "purchasing.orders.view") && hossamPerms.length === 9, hossamPerms);
  check("STOCK_CONTROLLER cannot approve adjustments or see valuation", !hossamPerms.includes("stock.approve_adjustments") && !hossamPerms.includes("stock.valuation.view"));
  const saraPerms = (await call("sara","GET","/api/auth/me")).body.user.permissions;
  // 19 + the customer master (view/manage), reading prices and quotations from
  // Phase 3, reading suppliers / POs / purchase prices from Phase 4, following ETA
  // e-invoice status (accounting.eta.view, not submission); never credit,
  // price changes, users or settings. HR phase 1: records attendance (hr.attendance.record).
  check("SUPERVISOR keeps its pre-RBAC scope, no users.*/settings.*",
    saraPerms.length === 30 && !saraPerms.some((p: string) => p.startsWith("users.") || p.startsWith("settings.")), saraPerms);
  check("SUPERVISOR cannot change customer credit or prices", !saraPerms.includes("sales.credit.manage") && !saraPerms.includes("sales.pricing.manage") && !saraPerms.includes("sales.price_override"));
  const monaPerms = (await call("mona","GET","/api/auth/me")).body.user.permissions.sort();
  check("SALES: orders view/create + customer master + pricing, nothing on the floor or in stock",
    JSON.stringify(monaPerms) === JSON.stringify(["orders.create","orders.view","sales.customers.manage","sales.customers.view","sales.invoices.view","sales.price_override","sales.pricing.manage","sales.pricing.view","sales.quotations.manage","sales.quotations.view"].sort()), monaPerms);
  const karimPerms = (await call("karim","GET","/api/auth/me")).body.user.permissions.sort();
  // HR: prepares payroll, keeps compensation and statutory rules, posts and pays approved runs;
  // never approves payroll or reads private data.
  check("ACCOUNTANT: reads orders, stock value, customers; owns credit; cannot move stock or orders",
    JSON.stringify(karimPerms) === JSON.stringify(["accounting.assets.manage","accounting.assets.view","accounting.eta.manage","accounting.eta.view","accounting.journals.approve","accounting.manage","accounting.payments.manage","accounting.periods.close","accounting.receipts.manage","accounting.view","audit.view","hr.advances.manage","hr.compensation.manage","hr.compensation.view","hr.employees.manage","hr.employees.view","hr.expenses.submit","hr.leave.request","hr.payroll.pay","hr.payroll.post","hr.payroll.prepare","hr.payroll.view","hr.statutory.manage","orders.view","purchasing.bills.manage","purchasing.bills.view","purchasing.orders.approve","purchasing.orders.view","purchasing.prices.view","purchasing.suppliers.manage","purchasing.suppliers.view","reports.finance","sales.credit.manage","sales.customers.view","sales.invoices.manage","sales.invoices.view","sales.pricing.view","sales.quotations.view","sales.tax.manage","stock.valuation.view","stock.view"]), karimPerms);

  section("1. DIRECT API ACCESS MATRIX");
  const probes: { label: string; method: string; path: string; body?: any; allowed: string[] }[] = [
    { label: "GET /api/orders", method: "GET", path: "/api/orders", allowed: ["admin","sara","ahmed","mostafa"] },
    { label: "GET /api/production/daily", method: "GET", path: "/api/production/daily", allowed: ["admin","sara","ahmed","mostafa"] },
    { label: "GET /api/reports/daily", method: "GET", path: "/api/reports/daily", allowed: ["admin","sara"] },
    { label: "GET /api/supervisor/intelligence", method: "GET", path: "/api/supervisor/intelligence", allowed: ["admin","sara"] },
    { label: "GET /api/audit (full)", method: "GET", path: "/api/audit", allowed: ["admin","sara"] },
    { label: "GET /api/stock/dashboard", method: "GET", path: "/api/stock/dashboard", allowed: ["admin","sara","hossam"] },
    { label: "GET /api/stock/ledger", method: "GET", path: "/api/stock/ledger", allowed: ["admin","sara","hossam"] },
    { label: "GET /api/stock/products", method: "GET", path: "/api/stock/products", allowed: ["admin","sara","hossam"] },
    { label: "GET /api/stock/products/coverage", method: "GET", path: "/api/stock/products/coverage", allowed: ["admin","sara","hossam"] },
    { label: "GET /api/admin/users", method: "GET", path: "/api/admin/users", allowed: ["admin"] },
    { label: "GET /api/admin/overview", method: "GET", path: "/api/admin/overview", allowed: ["admin"] },
    { label: "POST /api/orders", method: "POST", path: "/api/orders", body: {}, allowed: ["admin","sara"] },
    { label: "POST /api/stock/intakes", method: "POST", path: "/api/stock/intakes", body: {}, allowed: ["admin","sara","hossam"] },
    { label: "POST /api/stock/adjustments", method: "POST", path: "/api/stock/adjustments", body: {}, allowed: ["admin","sara","hossam"] },
    { label: "POST /api/stock/products", method: "POST", path: "/api/stock/products", body: {}, allowed: ["admin","sara","hossam"] },
    { label: "POST /api/stock/products/mapping", method: "POST", path: "/api/stock/products/mapping", body: {}, allowed: ["admin","sara","hossam"] },
    { label: "POST /api/admin/users", method: "POST", path: "/api/admin/users", body: {}, allowed: ["admin"] },
  ];
  for (const probe of probes) {
    for (const who of ROLES_U) {
      const r = await call(who, probe.method, probe.path, probe.body);
      if (probe.allowed.includes(who)) check(`${who} allowed: ${probe.label}`, r.status !== 401 && r.status !== 403, r.status);
      else check(`${who} denied 403: ${probe.label}`, r.status === 403, { status: r.status, body: r.body });
    }
    check(`anonymous 401: ${probe.label}`, (await call(null, probe.method, probe.path, probe.body)).status === 401);
  }

  section("2. DIRECT ROUTE ACCESS MATRIX");
  const routes: { path: string; allowed: string[] }[] = [
    { path: "/prep", allowed: ["admin","sara","ahmed"] },
    { path: "/load", allowed: ["admin","sara","mostafa"] },
    { path: "/production", allowed: ["admin","sara","ahmed","mostafa"] },
    { path: "/supervisor", allowed: ["admin","sara"] },
    { path: "/supervisor/audit", allowed: ["admin","sara"] },
    { path: "/stock", allowed: ["admin","sara","hossam"] },
    { path: "/stock/setup", allowed: ["admin","sara","hossam"] },
    { path: "/admin", allowed: ["admin"] },
  ];
  for (const rp of routes) {
    for (const who of ROLES_U) {
      const p = await page(who, rp.path);
      if (rp.allowed.includes(who)) check(`${who} can open ${rp.path}`, p.status === 200 && !isDenied(p), { status: p.status });
      else check(`${who} sees access-denied on ${rp.path}`, isDenied(p), { status: p.status, loc: p.location });
    }
    const anon = await page(null, rp.path);
    check(`anonymous -> /login from ${rp.path}`, [302,307].includes(anon.status) && (anon.location ?? "").includes("/login"), anon.status);
  }
  check("access-denied page names the missing permission", (await page("ahmed", "/admin")).html.includes("users.view"));

  section("3. OPERATIONAL GUARDS");
  // Create real master cards first: manual orders must reference stable customer and
  // product IDs, never free-text names that cannot post to receivables or stock.
  const customer = (await call("admin","POST","/api/sales/customers",{name:`${TAG} عميل اختبار`})).body.customer;
  const product = (await call("admin","POST","/api/stock/products",{name:`${TAG} ليمون`,sku:`${TAG.toUpperCase()}-LEMON`,unit:"KG"})).body.product;
  check("admin created stable customer and product master cards", !!customer?.id && !!product?.id, { customer: customer?.id, product: product?.id });
  const ord = (await call("sara","POST","/api/orders",{customer_account_id:customer?.id,customer_name:customer?.name,delivery_date:"2026-10-09",items:[{stock_product_id:product?.id,product_name:product?.name,quantity:5,unit:product?.unit}]})).body.order;
  check("supervisor created a test order", !!ord?.id, ord);
  check("STOCK_CONTROLLER cannot read that order", (await call("hossam","GET",`/api/orders/${ord.id}`)).status === 403);
  check("LOADER cannot start preparing", (await call("mostafa","POST",`/api/orders/${ord.id}/status`,{to:"preparing"})).status === 403);
  check("PREPARER cannot jump to loading", (await call("ahmed","POST",`/api/orders/${ord.id}/status`,{to:"loading"})).status === 403);
  check("PREPARER cannot edit the order", (await call("ahmed","PATCH",`/api/orders/${ord.id}`,{notes:"x",reason:"x"})).status === 403);
  check("PREPARER cannot approve", (await call("ahmed","POST",`/api/orders/${ord.id}/approve`,{reason:"x"})).status === 403);
  check("LOADER cannot clone", (await call("mostafa","POST",`/api/orders/${ord.id}/clone`,{})).status === 403);
  check("PREPARER can still start preparing", (await call("ahmed","POST",`/api/orders/${ord.id}/status`,{to:"preparing"})).status === 200);
  const itm = (await call("ahmed","GET",`/api/orders/${ord.id}`)).body.order.items[0];
  check("PREPARER can record prepared qty", (await call("ahmed","POST",`/api/orders/${ord.id}/items/${itm.id}/prepare`,{quantity:5,mark_done:true})).status === 200);
  check("LOADER cannot record prepared qty", (await call("mostafa","POST",`/api/orders/${ord.id}/items/${itm.id}/prepare`,{quantity:5})).status === 403);
  check("SUPER_ADMIN can drive the order", (await call("admin","POST",`/api/orders/${ord.id}/status`,{to:"ready_for_loading"})).status === 200);
  const ordV = (await call("admin","GET",`/api/orders/${ord.id}`)).body.order;
  check("SUPER_ADMIN override needs a reason", (await call("admin","POST",`/api/orders/${ord.id}/status`,{to:"preparing",expected_version:ordV.version})).status === 400);
  check("SUPER_ADMIN override works with a reason", (await call("admin","POST",`/api/orders/${ord.id}/status`,{to:"preparing",reason:"اختبار",expected_version:ordV.version})).status === 200);
  const ordV2 = (await call("admin","GET",`/api/orders/${ord.id}`)).body.order;
  check("SUPER_ADMIN can cancel", (await call("admin","POST",`/api/orders/${ord.id}/cancel`,{reason:"تنظيف",expected_version:ordV2.version})).status === 200);

  section("4. DISABLED USER CUT OFF IMMEDIATELY");
  const victim = (await call("admin","POST","/api/admin/users",{name:"حساب اختبار",username:`${TAG}dis`,password:"test1234",role:"PREPARER"})).body.user;
  createdUserIds.push(victim.id);
  check("new user can sign in", (await login(`${TAG}dis`,"test1234")).status === 200);
  check("new user can use its permission", (await call(`${TAG}dis`,"GET","/api/orders")).status === 200);
  const dis = await call("admin","PATCH",`/api/admin/users/${victim.id}`,{active:false,expected_version:victim.version});
  check("admin disabled the account", dis.status === 200 && dis.body.user.active === false);
  check("EXISTING session refused at once", (await call(`${TAG}dis`,"GET","/api/orders")).status === 401);
  const disPage = await page(`${TAG}dis`, "/prep");
  check("disabled user bounced to /login", [302,307].includes(disPage.status) && (disPage.location ?? "").includes("/login"));
  check("disabled user cannot sign in again", (await call(null,"POST","/api/auth/login",{username:`${TAG}dis`,password:"test1234"})).status === 401);
  const re = await call("admin","PATCH",`/api/admin/users/${victim.id}`,{active:true,expected_version:dis.body.user.version});
  check("re-enabled", re.status === 200 && re.body.user.active === true);
  check("can sign in again", (await login(`${TAG}dis`,"test1234")).status === 200);

  section("4b. PASSWORD CHANGE ENDS EXISTING SESSIONS");
  // A second device (or a stolen cookie) holding a session from before the change.
  const other = `${TAG}dis#device2`;
  check("second device signs in", (await call(other,"POST","/api/auth/login",{username:`${TAG}dis`,password:"test1234"})).status === 200);
  check("second device works", (await call(other,"GET","/api/orders")).status === 200);
  const ver = (await call("admin","GET","/api/admin/users")).body.users.find((u: any) => u.id === victim.id).version;
  check("admin resets the password", (await call("admin","PATCH",`/api/admin/users/${victim.id}`,{password:"newpass99",expected_version:ver})).status === 200);
  check("old session on device 1 refused -> 401", (await call(`${TAG}dis`,"GET","/api/orders")).status === 401);
  check("old session on device 2 refused -> 401", (await call(other,"GET","/api/orders")).status === 401);
  check("old password no longer signs in", (await call(null,"POST","/api/auth/login",{username:`${TAG}dis`,password:"test1234"})).status === 401);
  check("new password signs in", (await login(`${TAG}dis`,"newpass99")).status === 200);
  check("and the new session works", (await call(`${TAG}dis`,"GET","/api/orders")).status === 200);
  const verName = (await call("admin","GET","/api/admin/users")).body.users.find((u: any) => u.id === victim.id).version;
  check("a name change does NOT sign the user out", (await call("admin","PATCH",`/api/admin/users/${victim.id}`,{name:"حساب اختبار ٢",expected_version:verName})).status === 200
    && (await call(`${TAG}dis`,"GET","/api/orders")).status === 200);

  section("5. PRIVILEGE ESCALATION");
  check("role not taken from login payload", (await call(null,"POST","/api/auth/login",{username:"ahmed",password:"1234",role:"SUPER_ADMIN"})).body?.user?.role === "PREPARER");
  check("PREPARER cannot create a user", (await call("ahmed","POST","/api/admin/users",{name:"x",username:`${TAG}esc`,password:"test1234",role:"SUPER_ADMIN"})).status === 403);
  check("PREPARER cannot change a role", (await call("ahmed","PATCH",`/api/admin/users/${victim.id}`,{role:"SUPER_ADMIN"})).status === 403);
  check("SUPERVISOR cannot reach user admin", (await call("sara","PATCH",`/api/admin/users/${victim.id}`,{role:"SUPERVISOR"})).status === 403);
  check("STOCK_CONTROLLER cannot set overrides", (await call("hossam","POST",`/api/admin/users/${victim.id}/permissions`,{permission:"orders.view",effect:"grant"})).status === 403);
  check("unknown role rejected", (await call("admin","PATCH",`/api/admin/users/${victim.id}`,{role:"ROOT"})).status === 400);
  check("unknown permission key rejected", (await call("admin","POST",`/api/admin/users/${victim.id}/permissions`,{permission:"orders.everything",effect:"grant"})).status === 400);
  check("invalid override effect rejected", (await call("admin","POST",`/api/admin/users/${victim.id}/permissions`,{permission:"orders.view",effect:"maybe"})).status === 400);
  const adminUser = (await call("admin","GET","/api/admin/users")).body.users.find((u: any) => u.username === "admin");
  check("overrides refused on a SUPER_ADMIN", (await call("admin","POST",`/api/admin/users/${adminUser.id}/permissions`,{permission:"orders.view",effect:"revoke"})).status === 400);
  check("n8n key required for machine create", (await call(null,"POST","/api/orders",{customer_name:"x",delivery_date:"2026-10-01",items:[]})).status === 401);

  section("6. OVERRIDES CHANGE EFFECTIVE ACCESS");
  check("cannot view reports before grant", (await call(`${TAG}dis`,"GET","/api/reports/daily")).status === 403);
  const grant = await call("admin","POST",`/api/admin/users/${victim.id}/permissions`,{permission:"reports.view",effect:"grant",reason:"اختبار"});
  check("grant applied", grant.status === 200 && grant.body.permissions.find((p: any) => p.key === "reports.view")?.effective === true);
  check("takes effect on the SAME session", (await call(`${TAG}dis`,"GET","/api/reports/daily")).status === 200);
  const revoke = await call("admin","POST",`/api/admin/users/${victim.id}/permissions`,{permission:"orders.view",effect:"revoke",reason:"اختبار"});
  check("revoke applied", revoke.status === 200 && revoke.body.permissions.find((p: any) => p.key === "orders.view")?.effective === false);
  check("revoke beats the role bundle immediately", (await call(`${TAG}dis`,"GET","/api/orders")).status === 403);
  await call("admin","POST",`/api/admin/users/${victim.id}/permissions`,{permission:"orders.view",effect:null});
  check("clearing restores the bundle", (await call(`${TAG}dis`,"GET","/api/orders")).status === 200);
  await call("admin","POST",`/api/admin/users/${victim.id}/permissions`,{permission:"reports.view",effect:null});
  check("cleared grant withdrawn", (await call(`${TAG}dis`,"GET","/api/reports/daily")).status === 403);

  section("7. LAST SUPER_ADMIN PROTECTION");
  const users = (await call("admin","GET","/api/admin/users")).body.users;
  check("exactly one active SUPER_ADMIN", users.filter((u: any) => u.role === "SUPER_ADMIN" && u.active).length === 1);
  check("cannot disable the last SUPER_ADMIN", (await call("admin","PATCH",`/api/admin/users/${adminUser.id}`,{active:false,expected_version:adminUser.version})).status >= 400);
  check("cannot demote the last SUPER_ADMIN", (await call("admin","PATCH",`/api/admin/users/${adminUser.id}`,{role:"SUPERVISOR",expected_version:adminUser.version})).status >= 400);
  const stillAdmin = (await call("admin","GET","/api/admin/users")).body.users.find((x: any) => x.username === "admin");
  check("still active and still SUPER_ADMIN", stillAdmin.active === true && stillAdmin.role === "SUPER_ADMIN");
  const second = (await call("admin","POST","/api/admin/users",{name:"مدير ثاني",username:`${TAG}sa`,password:"test1234",role:"SUPER_ADMIN"})).body.user;
  createdUserIds.push(second.id);
  check("a second SUPER_ADMIN can be created", second?.role === "SUPER_ADMIN");
  check("with two, the second can be demoted", (await call("admin","PATCH",`/api/admin/users/${second.id}`,{role:"SUPERVISOR",expected_version:second.version})).status === 200);
  check("cannot disable your own account", (await call("admin","PATCH",`/api/admin/users/${adminUser.id}`,{active:false})).status >= 400);

  section("8. OPTIMISTIC CONCURRENCY ON USER EDITS");
  const target = (await call("admin","GET","/api/admin/users")).body.users.find((u: any) => u.id === victim.id);
  const dbl = await Promise.all([
    call("admin","PATCH",`/api/admin/users/${victim.id}`,{name:"اسم أ",expected_version:target.version}),
    call("admin","PATCH",`/api/admin/users/${victim.id}`,{name:"اسم ب",expected_version:target.version}),
  ]);
  check("double-submit: exactly one wins", dbl.filter((x) => x.status === 200).length === 1, dbl.map((x) => x.status));
  check("the loser gets 409", dbl.some((x) => x.status === 409), dbl.map((x) => x.status));
  check("stale version on role change -> 409", (await call("admin","PATCH",`/api/admin/users/${victim.id}`,{role:"LOADER",expected_version:1})).status === 409);

  section("9. SECURITY AUDIT + MATRIX");
  const ov = await call("admin","GET","/api/admin/overview");
  check("overview loads", ov.status === 200);
  const acts = new Set(ov.body.audit.map((l: any) => l.action));
  for (const a of ["user_created","user_disabled","user_enabled","user_role_changed","user_permission_granted","user_permission_revoked","user_permission_override_cleared","user_updated"]) {
    check(`audit records ${a}`, acts.has(a), [...acts]);
  }
  const roleLog = ov.body.audit.find((l: any) => l.action === "user_role_changed");
  check("role change audit has actor/target/old/new", !!roleLog?.userName && !!roleLog?.entityId && !!roleLog?.oldValue && !!roleLog?.newValue);
  check("passwords never written in clear", ov.body.audit.filter((l: any) => l.fieldChanged === "password").every((l: any) => l.oldValue === null && l.newValue === "(اتغيّرت)"));
  check("non-admin cannot read the security audit", (await call("sara","GET","/api/admin/overview")).status === 403);
  const m = ov.body.matrix;
  check("catalogue has 84 permissions (79 + 5 accounting: reopen, journal and opening approval, fixed assets)", m.permissions.length === 84, m.permissions.length);
  check("all 9 roles present (SALES, ACCOUNTANT in Phase 3; PURCHASER in Phase 4; ACCOUNTING_CLERK)", m.roles.length === 9);
  check("database bundles match the code", m.catalogueInSync === true, m.roles.filter((r: any) => !r.inSync));
  const byRole = Object.fromEntries(m.roles.map((r: any) => [r.role, r.permissions]));
  check("SUPER_ADMIN holds everything", byRole.SUPER_ADMIN.length === 84);
  check("only SUPER_ADMIN approves supplier-bill variances by default (the accountant books them)", m.roles.filter((r: any) => r.permissions.includes("purchasing.bills.approve")).map((r: any) => r.role).join() === "SUPER_ADMIN");
  check("only SUPER_ADMIN manages master data", m.roles.filter((r: any) => r.permissions.includes("core.masterdata.manage")).length === 1);
  check("only SUPER_ADMIN has settings.manage", m.roles.filter((r: any) => r.permissions.includes("settings.manage")).length === 1);

  section("10. LOGIN HARDENING");
  check("7-char password rejected on user creation", (await call("admin","POST","/api/admin/users",{name:"x",username:`${TAG}short`,password:"short12",role:"PREPARER"})).status === 400);
  const hardened = (await call("admin","POST","/api/admin/users",{name:"حساب اختبار",username:`${TAG}lock`,password:"test1234",role:"PREPARER"})).body.user;
  createdUserIds.push(hardened.id);
  for (let i = 0; i < 5; i++) {
    await call(null,"POST","/api/auth/login",{username:`${TAG}lock`,password:"wrong-password"});
  }
  const lockedOut = await call(null,"POST","/api/auth/login",{username:`${TAG}lock`,password:"test1234"});
  check("account locked after repeated failed logins, even with the RIGHT password", lockedOut.status === 429, lockedOut);

  section("11. CLEAN UP TEST ACCOUNTS");
  for (const id of createdUserIds) await call("admin","PATCH",`/api/admin/users/${id}`,{active:false});
  finish("RBAC MATRIX");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
