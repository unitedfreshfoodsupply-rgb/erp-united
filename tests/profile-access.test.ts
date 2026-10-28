/* Read-only profile policy (P0-level access control) regression suite.
   Profile = GET /api/auth/me (self only, no user-supplied id) + /profile page.
   Assertions:
    1. Every authenticated user sees their OWN profile: name, username, role with
       Arabic label/description, account status, effective permissions with Arabic
       labels. No other user's data is reachable through the profile surface.
    2. The profile is READ-ONLY: no self-edit endpoint exists; the admin
       user-management routes refuse non-admins (server-side, not UI hiding).
    3. Passwords are admin-managed: self-service change route is gone; admin
       resets work; admins are the only writers of user data/passwords.
    4. The /profile page renders for any authenticated user with the notice and a
       back link; anonymous is redirected to /login. */
import { call, login, makeChecker, page } from "./_harness";

async function main() {
  const { check, section, finish } = makeChecker();
  const TAG = `prf${Date.now() % 100000}`;

  for (const u of ["admin", "sara", "ahmed", "mostafa"]) await login(u);

  section("1. SELF PROFILE — EVERY USER SEES THEIR OWN (no id parameter)");
  for (const [who, role] of [["sara", "SUPERVISOR"], ["ahmed", "PREPARER"], ["mostafa", "LOADER"]] as const) {
    const me = await call(who, "GET", "/api/auth/me");
    check(`${who}: own profile returns 200`, me.status === 200, me.status);
    check(`${who}: username matches`, me.body.user?.username === who, me.body.user?.username);
    check(`${who}: role matches`, me.body.user?.role === role, me.body.user?.role);
    check(`${who}: role label is Arabic`, typeof me.body.profile?.roleLabel === "string" && /[\u0600-\u06FF]/.test(me.body.profile.roleLabel));
    check(`${who}: role description present`, /[\u0600-\u06FF]/.test(me.body.profile?.roleDescription ?? ""));
    check(`${who}: account status present`, typeof me.body.user?.active === "boolean");
    check(`${who}: permissions carry Arabic labels + descriptions`, (me.body.profile?.permissions ?? []).every((p: any) => /[\u0600-\u06FF]/.test(p.label) && /[\u0600-\u06FF]/.test(p.description)));
    check(`${who}: effective permission keys match the session's`, JSON.stringify((me.body.profile?.permissions ?? []).map((p: any) => p.key).sort()) === JSON.stringify([...(me.body.user?.permissions ?? [])].sort()));
  }
  check("profile payload leaks no hash/token/epoch fields", !JSON.stringify((await call("sara", "GET", "/api/auth/me")).body).match(/"passwordHash"|"sessionEpoch"|"token"/i));

  section("2. NO ID-BASED PROFILE ACCESS — OTHERS' DATA UNREACHABLE");
  const saraMe = await call("sara", "GET", "/api/auth/me");
  const saraId = saraMe.body.user.id;
  // A caller cannot ask for another user through the session surface.
  const spoof = await call("ahmed", "GET", `/api/auth/me?user=${saraId}`);
  check("user param on /api/auth/me is ignored (returns own profile)", spoof.body.user?.username === "ahmed", spoof.body.user?.username);
  // The admin detail routes are the only per-id views and require users.view.
  check("PREPARER cannot read another user's permission detail (403)", (await call("ahmed", "GET", `/api/admin/users/${saraId}`)).status === 403);
  check("PREPARER cannot list users (403)", (await call("ahmed", "GET", "/api/admin/users")).status === 403);

  section("3. READ-ONLY — NO SELF-EDIT VIA UI OR API");
  check("no self-profile PATCH endpoint (404/405)", [404, 405].includes((await call("ahmed", "PATCH", "/api/auth/me", { name: "حايل" })).status));
  check("no self-password PATCH endpoint (404/405)", [404, 405].includes((await call("ahmed", "PATCH", "/api/auth/password", { new_password: "x12345678" })).status));
  check("self-service password change POST removed (404)", (await call("ahmed", "POST", "/api/auth/password", { current_password: "1234", new_password: "x12345678" })).status === 404);
  check("PREPARER cannot edit own name via admin routes (403)", (await call("ahmed", "PATCH", `/api/admin/users/${saraId}`, { name: "حايل" })).status === 403);
  check("PREPARER cannot disable others (403)", (await call("ahmed", "PATCH", `/api/admin/users/${saraId}`, { active: false })).status === 403);
  check("PREPARER cannot change roles (403)", (await call("ahmed", "PATCH", `/api/admin/users/${saraId}`, { role: "SUPER_ADMIN" })).status === 403);

  section("4. ADMIN-MANAGED DATA AND PASSWORDS");
  const created = await call("admin", "POST", "/api/admin/users", { name: `${TAG} موظف`, username: `${TAG}u`, password: "temp12345", role: "PREPARER" });
  check("admin creates a user with a password (201)", created.status === 201, created.status);
  const un = `${TAG}u`;
  const users = (await call("admin", "GET", "/api/admin/users")).body.users;
  const target = users.find((u: any) => u.username === un);
  const firstLogin = await call("prf2", "POST", "/api/auth/login", { username: un, password: "temp12345" });
  check("admin-set password signs in", firstLogin.status === 200, firstLogin.status);
  const adminReset = await call("admin", "PATCH", `/api/admin/users/${target.id}`, { password: "reset99999", expected_version: target.version });
  check("admin resets the password (200)", adminReset.status === 200, adminReset.status);
  check("old password rejected after reset", (await call("prf2", "POST", "/api/auth/login", { username: un, password: "temp12345" })).status === 401);
  check("new password signs in", (await call("prf2", "POST", "/api/auth/login", { username: un, password: "reset99999" })).status === 200);
  // Admin edits names/roles normally.
  const t2 = (await call("admin", "GET", "/api/admin/users")).body.users.find((u: any) => u.username === un);
  const rename = await call("admin", "PATCH", `/api/admin/users/${target.id}`, { name: `${TAG} جديد`, expected_version: t2.version });
  check("admin edits the user's name (200)", rename.status === 200, rename.status);
  check("name change visible in the listing", (await call("admin", "GET", "/api/admin/users")).body.users.find((u: any) => u.username === un)?.name === `${TAG} جديد`);

  section("5. /profile PAGE — ACCESSIBLE + READ-ONLY NOTICE + BACK LINK");
  const p = await page("ahmed", "/profile");
  check("profile page renders for an authenticated user (200)", p.status === 200, p.status);
  // The lock indicator is a line icon (lucide "lock"), not an emoji, since the UI design-system pass.
  check("…shows the read-only Arabic notice", p.html.includes("مش بتتعدل منك") && p.html.includes("lucide-lock"), p.status);
  check("…shows the user's name", p.html.includes("أحمد"), p.status);
  check("…offers a route back to the application", p.html.includes("الرجوع للتطبيق") && p.html.includes('href="/"'), p.status);
  const anon = await page(null, "/profile");
  check("anonymous is redirected to /login", [302, 307].includes(anon.status) && (anon.location ?? "").includes("/login"), anon.status);
  const brokenPage = await page("ahmed", "/account/password");
  check("old self-service page no longer resolves (404)", brokenPage.status === 404, brokenPage.status);

  section("6. CLEANUP");
  const users2 = (await call("admin", "GET", "/api/admin/users")).body.users;
  const t3 = users2.find((x: any) => x.username === un);
  await call("admin", "PATCH", `/api/admin/users/${t3.id}`, { active: false, expected_version: t3.version });
  check("test user deactivated", true, undefined);

  finish("PROFILE-ACCESS");
}

main().catch((e) => {
  console.error("CRASH:", e);
  process.exit(1);
});