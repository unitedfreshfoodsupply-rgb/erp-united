/* WS6 — web security headers, session cookie, password policy and health, end to end.

   - Every HTML response carries a nonce-based Content-Security-Policy, every <script>
     the server renders carries that response's nonce (so the CSP does not block the
     app), and the nonce changes per request. Checked on login, home, an order,
     accounting and the enrolment page.
   - The session cookie is HttpOnly + SameSite=Strict; its lifetime is capped at 24h
     whatever the setting says, and a token older than 24h is refused even if its own
     `exp` says otherwise.
   - New passwords: 10+ characters, not the username, not a common password. Old hashes
     keep working and are upgraded to cost 12 on sign-in.
   - /api/health answers {status} only and tests the database; /api/health/deep is
     administrators only. */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { call as rawCall, makeChecker, BASE } from "./_harness";
import { assertTestDatabase } from "./_guard";

// `next start` stamps every request with X-Forwarded-For of the loopback address, so all
// suites in a run share one IP bucket for auth.login_ip_lockout_threshold (20 failures /
// 15 min). This suite makes deliberate failures; it uses its own documentation-range
// address so it neither trips nor is tripped by the other suites' failures.
const XFF = { "x-forwarded-for": `198.18.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}` };
const call = (who: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => rawCall(who, method, path, body, { ...XFF, ...extra });
const login = (u: string, p = "1234") => call(u, "POST", "/api/auth/login", { username: u, password: p });

assertTestDatabase();
const db = new PrismaClient();
const { check, section, finish } = makeChecker();
const TAG = `zzweb${Date.now() % 1_000_000}`;

function cspOf(h: Headers) {
  const raw = h.get("content-security-policy") ?? "";
  return { raw, dirs: Object.fromEntries(raw.split(";").map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).map(([k, ...v]) => [k, v])) as Record<string, string[]> };
}

/** Every <script> tag must carry the response's nonce: anything else would be blocked. */
function scriptsWithoutNonce(html: string, nonce: string) {
  return [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !tag.includes(`nonce="${nonce}"`));
}

async function fetchPage(path: string, cookie?: string) {
  const r = await fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(45_000) });
  return { status: r.status, headers: r.headers, html: await r.text() };
}

function sessionCookie(setCookie: string | null) {
  const m = /united_session=([^;]*)/.exec(setCookie ?? "");
  return m ? `united_session=${m[1]}` : "";
}

async function main() {
  await login("admin");

  // ---------------------------------------------------------------------------
  section("1. CONTENT-SECURITY-POLICY ON THE LOGIN PAGE");
  const a = await fetchPage("/login");
  const b = await fetchPage("/login");
  const ca = cspOf(a.headers);
  const nonceA = (ca.dirs["script-src"] ?? []).find((x) => x.startsWith("'nonce-"))?.slice(7, -1) ?? "";
  const nonceB = (cspOf(b.headers).dirs["script-src"] ?? []).find((x) => x.startsWith("'nonce-"))?.slice(7, -1) ?? "";
  check("login renders (200)", a.status === 200, a.status);
  check("CSP header present", ca.raw.length > 0);
  check("default-src 'self'", JSON.stringify(ca.dirs["default-src"]) === JSON.stringify(["'self'"]), ca.dirs["default-src"]);
  check("script-src: nonce + strict-dynamic, no unsafe-inline/unsafe-eval", nonceA.length >= 16 && ca.dirs["script-src"].includes("'strict-dynamic'") && !ca.raw.includes("'unsafe-eval'") && !ca.dirs["script-src"].includes("'unsafe-inline'"), ca.dirs["script-src"]);
  check("frame-ancestors 'none', object-src 'none', base-uri 'self', form-action 'self'", ca.dirs["frame-ancestors"]?.[0] === "'none'" && ca.dirs["object-src"]?.[0] === "'none'" && ca.dirs["base-uri"]?.[0] === "'self'" && ca.dirs["form-action"]?.[0] === "'self'");
  check("img-src 'self' data: blob:, connect-src 'self'", JSON.stringify(ca.dirs["img-src"]) === JSON.stringify(["'self'", "data:", "blob:"]) && JSON.stringify(ca.dirs["connect-src"]) === JSON.stringify(["'self'"]));
  check("a fresh nonce per request", nonceA !== nonceB && nonceB.length >= 16);
  check("every script on /login carries the nonce", a.html.includes("<script") && scriptsWithoutNonce(a.html, nonceA).length === 0, scriptsWithoutNonce(a.html, nonceA).slice(0, 3));
  check("no inline event handlers (blocked by CSP)", !/\son(click|load|error|submit)=/i.test(a.html));
  check("only one CSP header (two would intersect)", (a.headers.get("content-security-policy") ?? "").split("default-src").length === 2);
  check("Permissions-Policy present", (a.headers.get("permissions-policy") ?? "").includes("camera=()"));
  check("X-Frame-Options DENY and nosniff kept", a.headers.get("x-frame-options") === "DENY" && a.headers.get("x-content-type-options") === "nosniff");

  section("2. EVERY MAJOR PAGE RENDERS UNDER THE CSP");
  const adminLogin = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...XFF }, body: JSON.stringify({ username: "admin", password: "1234" }) });
  const cookie = sessionCookie(adminLogin.headers.get("set-cookie"));
  const anyOrder = (await call("admin", "GET", "/api/orders")).body.orders?.[0];
  for (const path of ["/", "/accounting", "/stock/inventory", "/profile", "/mfa/setup", ...(anyOrder ? [`/orders/${anyOrder.id}`] : [])]) {
    let p = await fetchPage(path, cookie);
    if ([302, 307].includes(p.status) && p.headers.get("location")) p = await fetchPage(new URL(p.headers.get("location")!, BASE).pathname, cookie);
    const n = (cspOf(p.headers).dirs["script-src"] ?? []).find((x) => x.startsWith("'nonce-"))?.slice(7, -1) ?? "";
    const bad = scriptsWithoutNonce(p.html, n);
    check(`${path}: 200, CSP with nonce, every script nonce'd`, p.status === 200 && n.length >= 16 && p.html.includes("<script") && bad.length === 0, { status: p.status, bad: bad.slice(0, 2) });
  }
  const api = await fetch(BASE + "/api/auth/me");
  check("API responses carry the policy too", (api.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));

  // ---------------------------------------------------------------------------
  section("3. SESSION COOKIE AND LIFETIME CAP");
  const sc = adminLogin.headers.get("set-cookie") ?? "";
  check("cookie is HttpOnly", /httponly/i.test(sc), sc);
  check("cookie is SameSite=Strict", /samesite=strict/i.test(sc), sc);
  check("cookie Path=/", /path=\//i.test(sc));
  check("cookie Secure under next start (production)", /secure/i.test(sc), sc);
  const maxAge = Number(/max-age=(\d+)/i.exec(sc)?.[1]);
  check("default lifetime 12h", maxAge === 12 * 3600, maxAge);

  check("set the TTL setting to 720h", [200, 201].includes((await call("admin", "PATCH", "/api/admin/settings/auth.session_ttl_hours", { value: 720, reason: TAG })).status));
  const longLogin = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...XFF }, body: JSON.stringify({ username: "admin", password: "1234" }) });
  const longSc = longLogin.headers.get("set-cookie") ?? "";
  check("…the cookie is still capped at 24h", Number(/max-age=(\d+)/i.exec(longSc)?.[1]) === 24 * 3600, longSc);
  const tok: string = (await longLogin.json()).token;
  const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
  check("…and so is the token (exp - iat = 24h)", payload.exp - payload.iat === 24 * 3600, payload.exp - payload.iat);
  check("restore TTL 12h", [200, 201].includes((await call("admin", "PATCH", "/api/admin/settings/auth.session_ttl_hours", { value: 12, reason: TAG })).status));

  // A token older than the cap, even with a far-future exp (as an old build could mint).
  const adminRow = await db.user.findUnique({ where: { username: "admin" } });
  const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "insecure-dev-secret-do-not-use-in-production");
  const issued = Math.floor(Date.now() / 1000) - 25 * 3600;
  const stale = await new SignJWT({ id: adminRow!.id, name: adminRow!.name, username: "admin", role: "SUPER_ADMIN", sep: adminRow!.sessionEpoch })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt(issued).setExpirationTime(issued + 30 * 24 * 3600).sign(secret);
  const fresh = await new SignJWT({ id: adminRow!.id, name: adminRow!.name, username: "admin", role: "SUPER_ADMIN", sep: adminRow!.sessionEpoch })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(secret);
  check("a correctly signed token issued 25h ago is refused (absolute cap)", (await fetch(BASE + "/api/orders", { headers: { authorization: `Bearer ${stale}` } })).status === 401);
  check("…while the same token issued now works (control)", (await fetch(BASE + "/api/orders", { headers: { authorization: `Bearer ${fresh}` } })).status === 200);

  // ---------------------------------------------------------------------------
  section("4. PASSWORD POLICY (NEW PASSWORDS ONLY)");
  const mk = (username: string, password: string) => call("admin", "POST", "/api/admin/users", { name: `${TAG} pw`, username, password, role: "PREPARER" });
  const nine = await mk(`${TAG}a`, "Ab3$efgh9");
  check("9 characters: 400", nine.status === 400, nine.body);
  check("common password (1234567890): 400", (await mk(`${TAG}b`, "1234567890")).status === 400);
  check("common password, any case (Password123): 400", (await mk(`${TAG}c`, "Password123")).status === 400);
  check("password = username: 400", (await mk(`${TAG}userpass`, `${TAG}UserPass`)).status === 400);
  const en = await call("admin", "POST", "/api/admin/users", { name: "x", username: `${TAG}d`, password: "1234567890", role: "PREPARER" }, { "accept-language": "en" });
  check("…the refusal reads in English when asked", /well known/i.test(en.body.error ?? ""), en.body);
  const good = await mk(`${TAG}ok`, "Crate-Of-Mango-9");
  check("a good 16-character password: 201", good.status === 201, good.body);
  const row = await db.user.findUnique({ where: { username: `${TAG}ok` }, select: { passwordHash: true } });
  check("…hashed at bcrypt cost 12", bcrypt.getRounds(row!.passwordHash) === 12);
  const u = (await call("admin", "GET", "/api/admin/users")).body.users.find((x: any) => x.username === `${TAG}ok`);
  check("changing to a common password: 400", (await call("admin", "PATCH", `/api/admin/users/${u.id}`, { password: "qwertyuiop", expected_version: u.version })).status === 400);
  // The username is "zzweb<digits>ok" (13+ characters); the same text in other case.
  check("changing to the username (any case): 400", (await call("admin", "PATCH", `/api/admin/users/${u.id}`, { password: `${TAG}OK`, expected_version: u.version })).status === 400);

  section("5. OLD HASHES KEEP WORKING AND ARE UPGRADED ON SIGN-IN");
  await db.user.update({ where: { username: "mona" }, data: { passwordHash: bcrypt.hashSync("1234", 10) } });
  const v0 = (await db.user.findUnique({ where: { username: "mona" }, select: { version: true } }))!.version;
  check("seed account starts at cost 10", bcrypt.getRounds((await db.user.findUnique({ where: { username: "mona" } }))!.passwordHash) === 10);
  check("its old 4-character password still signs in (policy is for NEW passwords)", (await login("mona", "1234")).status === 200);
  const after = (await db.user.findUnique({ where: { username: "mona" }, select: { passwordHash: true, version: true } }))!;
  check("…and the hash is now cost 12", bcrypt.getRounds(after.passwordHash) === 12);
  check("…without bumping the row version (no admin-screen conflict)", after.version === v0);
  check("…and the same password signs in again", (await login("mona", "1234")).status === 200);

  // ---------------------------------------------------------------------------
  section("6. HEALTH");
  const h = await fetch(BASE + "/api/health");
  const hb = await h.json();
  check("/api/health: 200 {status:'ok'} and nothing else", h.status === 200 && JSON.stringify(hb) === JSON.stringify({ status: "ok" }), hb);
  check("…not cacheable", (h.headers.get("cache-control") ?? "").includes("no-store"));
  check("/api/health/deep anonymous: 401", (await call(null, "GET", "/api/health/deep")).status === 401);
  await login("mona");
  check("/api/health/deep as SALES: 403", (await call("mona", "GET", "/api/health/deep")).status === 403);
  const deep = await call("admin", "GET", "/api/health/deep");
  check("/api/health/deep as super admin: 200 ok", deep.status === 200 && deep.body.status === "ok", deep.body);
  check("…migrations: every shipped one applied, none failed", deep.body.migrations?.pending?.length === 0 && deep.body.migrations?.failed?.length === 0 && deep.body.migrations.applied >= deep.body.migrations.shipped, deep.body.migrations);
  check("…pending approvals counted", typeof deep.body.approvals?.pending === "number");
  check("…backup marker reported (not configured here)", deep.body.backup?.configured === false, deep.body.backup);
  check("…MFA coverage reported", Array.isArray(deep.body.mfa?.requiredRoles) && typeof deep.body.mfa?.activeUsersWithoutMfa === "number");
  check("…no connection string or secret in the payload", !/postgres(ql)?:\/\/|JWT_SECRET|MFA_ENCRYPTION_KEY/i.test(JSON.stringify(deep.body)));

  // Clean up.
  if (u?.id) {
    const cur = (await call("admin", "GET", "/api/admin/users")).body.users.find((x: any) => x.id === u.id);
    await call("admin", "PATCH", `/api/admin/users/${u.id}`, { active: false, expected_version: cur.version });
  }
  await db.$disconnect();
  finish("WEB-SECURITY");
}

main().catch((e) => {
  console.error("SUITE CRASHED", e);
  process.exit(2);
});
