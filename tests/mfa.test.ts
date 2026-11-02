/* WS6 — two-step sign-in (TOTP), end to end against the running server.

   The test database turns auth.mfa_required_roles off (tests/reset-db.ts) so the other
   suites can sign in as admin/karim. This suite switches it back on for its own
   accounts and exercises: the forced-enrolment hold (pages and APIs), enrolment with the
   secret shown once and stored encrypted, two-step sign-in, replay protection, recovery
   codes (single use), the code-attempt lockout, disable/regenerate (password + code),
   the administrator reset with four-eyes, audit rows that never carry secrets, and that
   a role change takes effect on the very next request. Restores the policy at the end. */
import { PrismaClient } from "@prisma/client";
import { call as rawCall, page, makeChecker, tokenFor, BASE } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { totpCode, verifyTotp } from "../lib/security/totp";

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
const TAG = `zzmfa${Date.now() % 1_000_000}`;
const PW = "Tomato-Crate-47x";

const now = () => Date.now();
/** A 6-digit string that is NOT valid for the secret right now (any step in the window). */
function wrongCode(secret: string) {
  for (let i = 0; ; i++) {
    const c = String(100000 + ((i * 7919) % 900000));
    if (verifyTotp(secret, c) === null) return c;
  }
}
async function setPolicy(who: string, value: string[] | null) {
  return call(who, "PATCH", "/api/admin/settings/auth.mfa_required_roles", { value, reason: TAG });
}
async function createUser(username: string, role: string) {
  const r = await call("admin", "POST", "/api/admin/users", { name: `${TAG} ${role}`, username, password: PW, role });
  check(`created ${username} (${role})`, r.status === 201, r.body);
  return r.body.user as { id: string };
}
async function enroll(who: string) {
  const start = await call(who, "POST", "/api/auth/mfa/enroll");
  const secret: string = start.body.secret;
  const confirm = await call(who, "POST", "/api/auth/mfa/enroll/confirm", { code: totpCode(secret, now()) });
  return { start, confirm, secret, codes: (confirm.body.recovery_codes ?? []) as string[] };
}
async function auditFor(entityId: string, action: string) {
  return db.auditLog.findMany({ where: { entityId, action }, orderBy: { timestamp: "desc" } });
}

async function main() {
  await login("admin");
  await login("karim");

  const acc = `${TAG}acc`; // ACCOUNTANT — required role
  const sal = `${TAG}sal`; // SALES — voluntary MFA
  const lck = `${TAG}lck`; // SALES — lockout target
  const sa2 = `${TAG}sa2`; // a second SUPER_ADMIN — four-eyes
  const accU = await createUser(acc, "ACCOUNTANT");
  const salU = await createUser(sal, "SALES");
  const lckU = await createUser(lck, "SALES");
  const sa2U = await createUser(sa2, "SUPER_ADMIN");

  // ---------------------------------------------------------------------------
  section("1. WITHOUT MFA: SIGN-IN IS UNCHANGED");
  {
    const r = await login(sal, PW);
    check("one step: 200 with a session token", r.status === 200 && typeof r.body.token === "string", r.status);
    check("…and no enrolment required for SALES", r.body.mfa_enrollment_required === false, r.body);
    check("…the session works", (await call(sal, "GET", "/api/sales/customers")).status === 200);
  }

  // ---------------------------------------------------------------------------
  section("2. THE POLICY: DEFAULT, AND THE ENROLMENT HOLD");
  {
    const list = (await call("admin", "GET", "/api/admin/settings")).body.settings as any[];
    const row = list.find((s) => s.key === "auth.mfa_required_roles");
    check("default is SUPER_ADMIN + ACCOUNTANT", JSON.stringify(row?.defaultValue) === JSON.stringify(["SUPER_ADMIN", "ACCOUNTANT"]), row?.defaultValue);
    check("the test database overrides it to [] (tests/reset-db.ts)", Array.isArray(row?.value) && row.value.length === 0, row?.value);
    check("an unknown role is refused (400)", (await setPolicy("admin", ["NOT_A_ROLE"])).status === 400);
    check("a non-admin cannot change it (403)", (await setPolicy(sal, [])).status === 403);
    check("require it for ACCOUNTANT", [200, 201].includes((await setPolicy("admin", ["ACCOUNTANT"])).status));

    const r = await login(acc, PW);
    check("ACCOUNTANT without MFA: password accepted, told to enrol", r.status === 200 && r.body.mfa_enrollment_required === true && typeof r.body.token === "string", r.body);
    const api = await call(acc, "GET", "/api/orders");
    check("…every API answers 403 auth.mfa-enroll-required", api.status === 403 && api.body.code === "auth.mfa-enroll-required", api);
    const acct = await call(acc, "GET", "/api/accounting/accounts");
    check("…accounting too", acct.status === 403 && acct.body.code === "auth.mfa-enroll-required", acct.status);
    const pg = await page(acc, "/accounting");
    check("…pages redirect to /mfa/setup", [302, 307].includes(pg.status) && (pg.location ?? "").includes("/mfa/setup"), pg);
    const home = await page(acc, "/");
    check("…the home page too", [302, 307].includes(home.status) && (home.location ?? "").includes("/mfa/setup"), home.status);
    const me = await call(acc, "GET", "/api/auth/me");
    check("…/me says why (user null, mfa_enrollment_required)", me.body.user === null && me.body.mfa_enrollment_required === true, me.body);
    const st = await call(acc, "GET", "/api/auth/mfa");
    check("…but its own MFA status is reachable", st.status === 200 && st.body.mfa.mustEnroll === true && st.body.mfa.enabled === false, st.body);
    check("…and the enrolment page renders", (await page(acc, "/mfa/setup")).status === 200);

    const karimNow = await call("karim", "GET", "/api/orders");
    check("a session issued BEFORE the policy changed is held too (karim)", karimNow.status === 403 && karimNow.body.code === "auth.mfa-enroll-required", karimNow.status);
    check("anonymous MFA status: 401", (await call(null, "GET", "/api/auth/mfa")).status === 401);
    check("anonymous enrolment: 401", (await call(null, "POST", "/api/auth/mfa/enroll")).status === 401);
  }

  // ---------------------------------------------------------------------------
  section("3. ENROLMENT: SECRET SHOWN ONCE, STORED ENCRYPTED, SESSIONS ROTATED");
  let accSecret = "";
  let accCodes: string[] = [];
  let confirmCode = "";
  {
    const start = await call(acc, "POST", "/api/auth/mfa/enroll");
    accSecret = start.body.secret;
    check("start returns a base32 secret + otpauth URI", /^[A-Z2-7]{32}$/.test(accSecret) && String(start.body.otpauth_uri).startsWith("otpauth://totp/") && String(start.body.otpauth_uri).includes(accSecret), start.body);
    const pending = await db.user.findUnique({ where: { id: accU.id }, select: { mfaPendingSecret: true, mfaSecret: true } });
    check("pending secret stored encrypted (v1 envelope), never in clear", !!pending?.mfaPendingSecret?.startsWith("v1.") && !pending.mfaPendingSecret.includes(accSecret) && pending.mfaSecret === null);
    check("a wrong code does not confirm (400)", (await call(acc, "POST", "/api/auth/mfa/enroll/confirm", { code: wrongCode(accSecret) })).status === 400);
    const before = tokenFor(acc);
    confirmCode = totpCode(accSecret, now());
    const confirm = await call(acc, "POST", "/api/auth/mfa/enroll/confirm", { code: confirmCode });
    accCodes = confirm.body.recovery_codes ?? [];
    check("the right code confirms (200) with 10 recovery codes and a new token", confirm.status === 200 && accCodes.length === 10 && typeof confirm.body.token === "string" && confirm.body.token !== before, confirm.status);
    check("…this session carries on (orders 200)", (await call(acc, "GET", "/api/orders")).status === 200);
    const old = await fetch(BASE + "/api/orders", { headers: { authorization: `Bearer ${before}` } });
    check("…every older session ended (old token 401)", old.status === 401, old.status);
    const row = await db.user.findUnique({ where: { id: accU.id }, select: { mfaSecret: true, mfaEnabledAt: true, mfaPendingSecret: true, mfaLastStep: true } });
    check("DB: secret encrypted, enabled, pending cleared, last step recorded", !!row?.mfaSecret?.startsWith("v1.") && !row.mfaSecret.includes(accSecret) && !!row.mfaEnabledAt && row.mfaPendingSecret === null && (row.mfaLastStep ?? 0) > 0);
    const rec = await db.userMfaRecoveryCode.findMany({ where: { userId: accU.id } });
    const plain = new Set(accCodes.map((c) => c.replace("-", "")));
    check("DB: 10 recovery codes, only hashes", rec.length === 10 && rec.every((r) => /^[0-9a-f]{64}$/.test(r.codeHash) && !plain.has(r.codeHash) && !accCodes.includes(r.codeHash)));
    const audits = await auditFor(accU.id, "mfa_enrolled");
    check("audit: mfa_enrolled recorded", audits.length === 1, audits.length);
    const allAudit = JSON.stringify(await db.auditLog.findMany({ where: { entityId: accU.id } }));
    check("audit rows never carry the secret or a recovery code", !allAudit.includes(accSecret) && !accCodes.some((c) => allAudit.includes(c)));
    check("enrolling again is refused (409)", (await call(acc, "POST", "/api/auth/mfa/enroll")).status === 409);
    const st = await call(acc, "GET", "/api/auth/mfa");
    check("status: enabled, 10 codes left, required", st.body.mfa.enabled === true && st.body.mfa.recoveryCodesRemaining === 10 && st.body.mfa.required === true, st.body);
  }

  // ---------------------------------------------------------------------------
  section("4. TWO-STEP SIGN-IN");
  {
    const step1 = await call(`${acc}#2`, "POST", "/api/auth/login", { username: acc, password: PW });
    check("password step: mfa_required + mfa_token, NO session", step1.status === 200 && step1.body.mfa_required === true && typeof step1.body.mfa_token === "string" && step1.body.token === undefined && !step1.body.user, step1.body);
    const raw = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...XFF }, body: JSON.stringify({ username: acc, password: PW }) });
    check("…and no session cookie is set", !(raw.headers.get("set-cookie") ?? "").includes("united_session="), raw.headers.get("set-cookie"));
    const mfaToken: string = step1.body.mfa_token;
    const asSession = await fetch(BASE + "/api/orders", { headers: { authorization: `Bearer ${mfaToken}` } });
    check("the pre-auth token is not a session (401)", asSession.status === 401, asSession.status);
    const asCookie = await fetch(BASE + "/api/auth/me", { headers: { cookie: `united_session=${mfaToken}` } });
    check("…not as a cookie either (/me user null)", (await asCookie.json()).user === null);
    check("wrong password: still 401 (no hint MFA exists)", (await call(null, "POST", "/api/auth/login", { username: acc, password: "Wrong-Password-1" })).status === 401);
    check("a wrong code: 401", (await call(null, "POST", "/api/auth/login", { mfa_token: mfaToken, code: wrongCode(accSecret) })).status === 401);
    check("the enrolment code again (replay): 401", (await call(null, "POST", "/api/auth/login", { mfa_token: mfaToken, code: confirmCode })).status === 401);
    const tampered = mfaToken.slice(0, -3) + (mfaToken.endsWith("AAA") ? "BBB" : "AAA");
    check("a tampered pre-auth token: 401", (await call(null, "POST", "/api/auth/login", { mfa_token: tampered, code: totpCode(accSecret, now() + 30_000) })).status === 401);
    check("a session token in place of the pre-auth token: 401", (await call(null, "POST", "/api/auth/login", { mfa_token: tokenFor(acc), code: totpCode(accSecret, now() + 30_000) })).status === 401);
    const nextCode = totpCode(accSecret, now() + 30_000);
    const ok = await call(`${acc}#2`, "POST", "/api/auth/login", { mfa_token: mfaToken, code: nextCode });
    check("the next code: 200 with a session", ok.status === 200 && typeof ok.body.token === "string" && ok.body.mfa_enrollment_required === false, ok.body);
    check("…which works", (await call(`${acc}#2`, "GET", "/api/orders")).status === 200);
    const again = await call(null, "POST", "/api/auth/login", { username: acc, password: PW });
    check("the same code a second time (replay): 401", (await call(null, "POST", "/api/auth/login", { mfa_token: again.body.mfa_token, code: nextCode })).status === 401);

    // Recovery codes: single use, audited.
    const s1 = await call(null, "POST", "/api/auth/login", { username: acc, password: PW });
    const rc = await call(`${acc}#3`, "POST", "/api/auth/login", { mfa_token: s1.body.mfa_token, recovery_code: accCodes[0].toLowerCase() });
    check("a recovery code signs in (case-insensitive)", rc.status === 200 && typeof rc.body.token === "string", rc.status);
    const s2 = await call(null, "POST", "/api/auth/login", { username: acc, password: PW });
    check("…but only once", (await call(null, "POST", "/api/auth/login", { mfa_token: s2.body.mfa_token, recovery_code: accCodes[0] })).status === 401);
    check("audit: mfa_recovery_code_used", (await auditFor(accU.id, "mfa_recovery_code_used")).length === 1);
    check("status: 9 codes left", (await call(acc, "GET", "/api/auth/mfa")).body.mfa.recoveryCodesRemaining === 9);
  }

  // ---------------------------------------------------------------------------
  section("5. CODE ATTEMPTS ARE RATE-LIMITED");
  {
    await login(lck, PW);
    const { secret, confirm } = await enroll(lck);
    check("lockout user enrolled (voluntary, SALES)", confirm.status === 200, confirm.status);
    const s = await call(null, "POST", "/api/auth/login", { username: lck, password: PW });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await call(null, "POST", "/api/auth/login", { mfa_token: s.body.mfa_token, code: wrongCode(secret) })).status);
    check("5 wrong codes: 401 each", statuses.every((x) => x === 401), statuses);
    const locked = await call(null, "POST", "/api/auth/login", { mfa_token: s.body.mfa_token, code: totpCode(secret, now() + 30_000) });
    check("…then even the right code is refused (429)", locked.status === 429, locked.status);
    check("…and so is the password step", (await call(null, "POST", "/api/auth/login", { username: lck, password: PW })).status === 429);
  }

  // ---------------------------------------------------------------------------
  section("6. DISABLE AND NEW RECOVERY CODES NEED PASSWORD + CODE");
  {
    const { codes } = await enroll(sal);
    check("SALES user enrolled voluntarily", codes.length === 10);
    check("required role cannot disable its own MFA (409)", (await call(acc, "POST", "/api/auth/mfa/disable", { password: PW, recovery_code: accCodes[1] })).status === 409);
    check("regenerate without a code: 401", (await call(sal, "POST", "/api/auth/mfa/recovery-codes", { password: PW })).status === 401);
    check("regenerate with a wrong password: 401", (await call(sal, "POST", "/api/auth/mfa/recovery-codes", { password: "Wrong-Password-1", recovery_code: codes[1] })).status === 401);
    const regen = await call(sal, "POST", "/api/auth/mfa/recovery-codes", { password: PW, recovery_code: codes[0] });
    check("regenerate with password + recovery code: 10 new codes", regen.status === 200 && regen.body.recovery_codes?.length === 10, regen.status);
    const fresh: string[] = regen.body.recovery_codes;
    check("…the old codes stopped working", (await call(sal, "POST", "/api/auth/mfa/disable", { password: PW, recovery_code: codes[2] })).status === 401);
    check("disable with a wrong password: 401", (await call(sal, "POST", "/api/auth/mfa/disable", { password: "Wrong-Password-1", recovery_code: fresh[0] })).status === 401);
    check("disable with password + code: 200", (await call(sal, "POST", "/api/auth/mfa/disable", { password: PW, recovery_code: fresh[0] })).status === 200);
    check("audit: regenerated + disabled", (await auditFor(salU.id, "mfa_recovery_codes_regenerated")).length === 1 && (await auditFor(salU.id, "mfa_disabled")).length === 1);
    const back = await login(sal, PW);
    check("…sign-in is one step again", back.status === 200 && typeof back.body.token === "string" && !back.body.mfa_required, back.body);
    check("…recovery rows removed", (await db.userMfaRecoveryCode.count({ where: { userId: salU.id } })) === 0);
  }

  // ---------------------------------------------------------------------------
  section("7. DEFAULT POLICY COVERS SUPER_ADMIN");
  {
    await login(sa2, PW);
    const { confirm } = await enroll(sa2);
    check("second super admin enrolled", confirm.status === 200, confirm.status);
    check("the enrolled admin resets the policy to its default (SUPER_ADMIN + ACCOUNTANT)", [200, 201].includes((await setPolicy(sa2, null)).status));
    const held = await call("admin", "GET", "/api/admin/users");
    check("the un-enrolled super admin is now held at enrolment", held.status === 403 && held.body.code === "auth.mfa-enroll-required", held.status);
    check("the enrolled one is not", (await call(sa2, "GET", "/api/admin/users")).status === 200);
    check("ACCOUNTANT stays covered (enrolled acc works)", (await call(acc, "GET", "/api/orders")).status === 200);
    check("put the policy back to ACCOUNTANT only", [200, 201].includes((await setPolicy(sa2, ["ACCOUNTANT"])).status));
    check("admin works again", (await call("admin", "GET", "/api/admin/users")).status === 200);
  }

  // ---------------------------------------------------------------------------
  section("8. ADMINISTRATOR RESET (AUDITED, FOUR-EYES)");
  {
    check("a SALES user cannot reset anyone (403)", (await call(sal, "POST", `/api/admin/users/${accU.id}/mfa/reset`, { reason: TAG })).status === 403);
    check("a reason is required (400)", (await call("admin", "POST", `/api/admin/users/${accU.id}/mfa/reset`, {})).status === 400);
    check("own reset while another super admin exists: 403", (await call(sa2, "POST", `/api/admin/users/${sa2U.id}/mfa/reset`, { reason: TAG })).status === 403);
    const r = await call("admin", "POST", `/api/admin/users/${accU.id}/mfa/reset`, { reason: `${TAG} lost phone` });
    check("admin resets the accountant's MFA (200)", r.status === 200, r);
    check("…their sessions end (401)", (await call(acc, "GET", "/api/orders")).status === 401);
    const audits = await auditFor(accU.id, "mfa_reset");
    check("…audited with the reason and the actor", audits.length === 1 && audits[0].reason === `${TAG} lost phone` && audits[0].userName !== acc, audits[0]);
    const relog = await login(acc, PW);
    check("…and at next sign-in a required role must enrol again", relog.status === 200 && relog.body.mfa_enrollment_required === true, relog.body);
    check("resetting a user without MFA: 409", (await call("admin", "POST", `/api/admin/users/${accU.id}/mfa/reset`, { reason: TAG })).status === 409);
    check("another super admin may reset sa2 (200)", (await call("admin", "POST", `/api/admin/users/${sa2U.id}/mfa/reset`, { reason: TAG })).status === 200);
  }

  // ---------------------------------------------------------------------------
  section("9. A ROLE CHANGE APPLIES ON THE NEXT REQUEST (no stale privilege in the token)");
  {
    await login(sal, PW);
    check("SALES reads customers", (await call(sal, "GET", "/api/sales/customers")).status === 200);
    let u = (await call("admin", "GET", "/api/admin/users")).body.users.find((x: any) => x.id === salU.id);
    await call("admin", "PATCH", `/api/admin/users/${salU.id}`, { role: "PREPARER", expected_version: u.version });
    check("demoted to PREPARER: the same session is refused at once (403)", (await call(sal, "GET", "/api/sales/customers")).status === 403);
    u = (await call("admin", "GET", "/api/admin/users")).body.users.find((x: any) => x.id === salU.id);
    await call("admin", "PATCH", `/api/admin/users/${salU.id}`, { role: "ACCOUNTANT", expected_version: u.version });
    const held = await call(sal, "GET", "/api/orders");
    check("promoted into a required role without MFA: held at enrolment at once", held.status === 403 && held.body.code === "auth.mfa-enroll-required", held.status);
  }

  // ---------------------------------------------------------------------------
  section("10. CLEAN UP");
  check("policy back to the test value []", [200, 201].includes((await setPolicy("admin", [])).status));
  check("karim works again", (await call("karim", "GET", "/api/orders")).status === 200);
  for (const id of [accU.id, salU.id, sa2U.id, lckU.id]) {
    const u = (await call("admin", "GET", "/api/admin/users")).body.users.find((x: any) => x.id === id);
    if (u?.active) await call("admin", "PATCH", `/api/admin/users/${id}`, { active: false, expected_version: u.version });
  }
  await db.$disconnect();
  finish("MFA");
}

main().catch(async (e) => {
  console.error("SUITE CRASHED", e);
  // Never leave the shared test database requiring MFA for admin/karim.
  await call("admin", "PATCH", "/api/admin/settings/auth.mfa_required_roles", { value: [], reason: "mfa suite crash cleanup" }).catch(() => {});
  process.exit(2);
});
