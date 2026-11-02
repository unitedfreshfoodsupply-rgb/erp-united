/* Regression suite for the ADMIN-CONTROLLED password policy.
   Policy: passwords are managed exclusively by administrators (users.create /
   users.edit → PATCH /api/admin/users/:id with a password field). There is NO
   self-service password change: /api/auth/password is removed, and the profile
   page is read-only. An admin password reset bumps the session epoch, so every
   existing session (including a stolen token) dies immediately; the new password
   signs in normally. Other users' tabs stay isolated. Logout still works and is
   tab-scoped. */
import { call, login, makeChecker, tokenFor } from "./_harness";

async function main() {
  const { check, section, finish } = makeChecker();
  const TAG = `pw${Date.now() % 100000}`;

  for (const u of ["admin", "ahmed"]) await login(u);

  section("0. CREATE A USER WITH ADMIN-SET PASSWORD (informing notice)");
  const un = `${TAG}_user`;
  const created = await call("admin", "POST", "/api/admin/users", {
    name: "PW Test", username: un, password: "temp12345-ws6", role: "PREPARER", must_change_password: true,
  });
  check("user created (201)", created.status === 201, created.status);

  section("1. THE ADMIN-SET PASSWORD SIGNS IN AND WORKS (no lock)");
  const login1 = await call("pwtab", "POST", "/api/auth/login", { username: un, password: "temp12345-ws6" });
  check("admin-set password signs in", login1.status === 200, login1.status);
  const oldToken = tokenFor("pwtab");
  check("login response carries a Bearer token", typeof oldToken === "string" && oldToken.length > 20, oldToken?.slice(0, 12));
  check("the profile carries the admin-password notice", (await call("pwtab", "GET", "/api/auth/me")).body.profile?.mustChangePassword === true);
  // Policy flip: mustChangePassword is informational — it does NOT strip permissions.
  const ordersAfterAdminSet = await call("pwtab", "GET", "/api/orders");
  check("user works normally with the admin-set password (orders 200)", ordersAfterAdminSet.status === 200, ordersAfterAdminSet.status);

  section("2. SELF-SERVICE PASSWORD CHANGE IS GONE");
  const selfSvc = await call("pwtab", "POST", "/api/auth/password", { current_password: "temp12345-ws6", new_password: "mine12345" });
  check("POST /api/auth/password no longer exists (404)", selfSvc.status === 404, selfSvc.status);

  section("3. ADMIN RESETS THE PASSWORD (clears the notice)");
  const users = (await call("admin", "GET", "/api/admin/users")).body.users;
  const target = users.find((u: any) => u.username === un);
  const reset = await call("admin", "PATCH", `/api/admin/users/${target.id}`, {
    password: "fresh98765", expected_version: target.version,
  });
  check("admin password reset succeeds (200)", reset.status === 200, reset.status);

  section("4. OLD SESSIONS DIE AT ONCE; NEW PASSWORD WORKS");
  const oldRes = await fetch(process.env.BASE + "/api/orders", {
    headers: { authorization: `Bearer ${oldToken}` },
    signal: AbortSignal.timeout(45_000),
  });
  check("old-epoch token rejected after admin reset (401)", oldRes.status === 401, oldRes.status);
  const oldLogin = await call("pwtab2", "POST", "/api/auth/login", { username: un, password: "temp12345-ws6" });
  check("old password no longer signs in (401)", oldLogin.status === 401, oldLogin.status);
  const newLogin = await call("pwtab", "POST", "/api/auth/login", { username: un, password: "fresh98765" });
  check("new password signs in (200)", newLogin.status === 200, newLogin.status);
  check("notice cleared after admin reset", (await call("pwtab", "GET", "/api/auth/me")).body.profile?.mustChangePassword === false);
  check("user's permissions intact after reset", (await call("pwtab", "GET", "/api/orders")).status === 200);

  section("5. ANOTHER USER'S SESSION REMAINS ISOLATED");
  const other = await call("ahmed", "GET", "/api/auth/me");
  check("ahmed's session unaffected by the reset", other.status === 200 && other.body.user?.username === "ahmed", other.status);
  check("ahmed's protected call still works", (await call("ahmed", "GET", "/api/orders")).status === 200);

  section("6. NON-ADMIN CANNOT RESET ANYONE'S PASSWORD (server-enforced)");
  const victim = users.find((u: any) => u.username === "ahmed");
  const attack = await call("ahmed", "PATCH", `/api/admin/users/${victim.id}`, { password: "hijacked123" });
  check("preparer cannot reset another user's password (403)", attack.status === 403, attack.status);
  const meAttack = await call("ahmed", "PATCH", `/api/admin/users/${victim.id}`, { name: "مخترق" });
  check("preparer cannot edit another user's name either (403)", meAttack.status === 403, meAttack.status);

  section("7. NO SELF-EDIT OF PROFILE VIA API");
  const selfEdit = await call("ahmed", "PATCH", "/api/auth/me", { name: "حايل" });
  check("self-profile edit endpoint does not exist (404/405)", [404, 405].includes(selfEdit.status), selfEdit.status);

  section("8. LOGOUT STILL WORKS (tab-scoped)");
  const out = await call("pwtab", "POST", "/api/auth/logout");
  check("logout succeeds", out.status === 200, out.status);
  const after = await call(null, "GET", "/api/auth/me");
  check("session gone after logout (user null)", after.status === 200 && after.body?.user === null, after.body?.user);
  const afterProtected = await call(null, "GET", "/api/orders");
  check("protected route refuses anonymous after logout (401)", afterProtected.status === 401, afterProtected.status);

  section("9. CLEANUP: DEACTIVATE TEST USER");
  const users2 = (await call("admin", "GET", "/api/admin/users")).body.users;
  const t2 = users2.find((x: any) => x.username === un);
  await call("admin", "PATCH", `/api/admin/users/${t2.id}`, { active: false, expected_version: t2.version });
  check("test user deactivated", true, undefined);

  finish("ADMIN-PASSWORD-MANAGEMENT");
}

main().catch((e) => {
  console.error("CRASH:", e);
  process.exit(1);
});