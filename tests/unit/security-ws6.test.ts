/* WS6 security primitives, without a server or a database: TOTP (RFC 6238 vectors,
   window, replay), the encryption of secrets at rest, recovery codes, the password
   policy and bcrypt cost, the session lifetime cap, the CSP builder, and the production
   environment rule for MFA_ENCRYPTION_KEY. */
import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "@/lib/security/totp";
import { decryptMfaSecret, encryptMfaSecret, hashRecoveryCode } from "@/lib/security/mfa-crypto";
import { BCRYPT_COST, MIN_PASSWORD_LENGTH, hashPassword, needsRehash, passwordProblem, verifyPassword } from "@/lib/security/password-policy";
import { buildContentSecurityPolicy, generateNonce } from "@/lib/security/csp";
import { productionEnvProblems } from "@/lib/env";
import { effectiveSessionHours, MAX_SESSION_HOURS } from "@/lib/auth";
import { parseSettingValue, SETTING_DEFS } from "@/lib/core/settings-registry";

// RFC 6238 Appendix B. The seeds are the ASCII strings "1234567890" repeated to the key length.
const SEED20 = Buffer.from("12345678901234567890", "ascii");
const SEED32 = Buffer.from("12345678901234567890123456789012", "ascii");
const SEED64 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii");
const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("HOTP/TOTP match every RFC 6238 test vector (SHA-1, SHA-256, SHA-512)", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    const step = Math.floor(t / 30);
    assert.equal(hotp(SEED20, step, 8, "sha1"), sha1, `sha1 @${t}`);
    assert.equal(hotp(SEED32, step, 8, "sha256"), sha256, `sha256 @${t}`);
    assert.equal(hotp(SEED64, step, 8, "sha512"), sha512, `sha512 @${t}`);
  }
});

test("RFC 4226 HOTP vectors (6 digits)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(SEED20, counter), code));
});

test("base32 round-trips and decodes the RFC seed", () => {
  assert.equal(base32Encode(SEED20), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), SEED20);
  const s = generateTotpSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(base32Encode(base32Decode(s)), s);
  assert.throws(() => base32Decode("not-base32!"));
});

test("verifyTotp accepts ±1 step, refuses ±2 and malformed codes", () => {
  const secret = generateTotpSecret();
  const now = 1_800_000_000_000;
  const at = (ms: number) => totpCode(secret, ms);
  assert.equal(verifyTotp(secret, at(now), { nowMs: now }), totpStep(now));
  assert.equal(verifyTotp(secret, at(now - 30_000), { nowMs: now }), totpStep(now) - 1);
  assert.equal(verifyTotp(secret, at(now + 30_000), { nowMs: now }), totpStep(now) + 1);
  // ±2 steps is outside the window (unless the code happens to collide — 1 in a million).
  const far = at(now - 60_000);
  if (far !== at(now) && far !== at(now - 30_000) && far !== at(now + 30_000)) assert.equal(verifyTotp(secret, far, { nowMs: now }), null);
  assert.equal(verifyTotp(secret, "12345", { nowMs: now }), null);
  assert.equal(verifyTotp(secret, "1234567", { nowMs: now }), null);
  assert.equal(verifyTotp(secret, 123456, { nowMs: now }), null);
  assert.equal(verifyTotp(secret, "abcdef", { nowMs: now }), null);
  assert.equal(verifyTotp(secret, ` ${at(now).slice(0, 3)} ${at(now).slice(3)} `, { nowMs: now }), totpStep(now), "spaces are ignored");
});

test("replay protection: a step at or before the last used one is refused", () => {
  const secret = generateTotpSecret();
  const now = 1_800_000_000_000;
  const step = totpStep(now);
  assert.equal(verifyTotp(secret, totpCode(secret, now), { nowMs: now, lastUsedStep: step }), null, "same step twice");
  assert.equal(verifyTotp(secret, totpCode(secret, now - 30_000), { nowMs: now, lastUsedStep: step }), null, "older step");
  assert.equal(verifyTotp(secret, totpCode(secret, now + 30_000), { nowMs: now, lastUsedStep: step }), step + 1, "the next step is fine");
});

test("otpauth URI carries issuer, account, and the standard parameters", () => {
  const uri = otpauthUri("JBSWY3DPEHPK3PXP", "admin");
  assert.match(uri, /^otpauth:\/\/totp\/UNITED%20ERP%3Aadmin\?/);
  const q = new URL(uri.replace("otpauth://", "https://x/")).searchParams;
  assert.equal(q.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(q.get("issuer"), "UNITED ERP");
  assert.equal(q.get("digits"), "6");
  assert.equal(q.get("period"), "30");
  assert.equal(q.get("algorithm"), "SHA1");
});

test("secrets are encrypted (AES-GCM), bound to the user and the key", () => {
  const key = "k".repeat(40);
  const env = encryptMfaSecret("JBSWY3DPEHPK3PXP", "user-1", key);
  assert.match(env, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!env.includes("JBSWY3DPEHPK3PXP"));
  assert.notEqual(env, encryptMfaSecret("JBSWY3DPEHPK3PXP", "user-1", key), "fresh IV each time");
  assert.equal(decryptMfaSecret(env, "user-1", key), "JBSWY3DPEHPK3PXP");
  assert.throws(() => decryptMfaSecret(env, "user-2", key), /cannot be decrypted/, "copied to another user");
  assert.throws(() => decryptMfaSecret(env, "user-1", "other".repeat(10)), /cannot be decrypted/, "wrong key");
  const parts = env.split(".");
  const flipped = [parts[0], parts[1], parts[2], (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1)].join(".");
  assert.throws(() => decryptMfaSecret(flipped, "user-1", key), "tampered ciphertext");
  // The error never echoes material.
  try {
    decryptMfaSecret(env, "user-1", "other".repeat(10));
  } catch (e) {
    assert.ok(!String(e).includes("other") && !String(e).includes(parts[3]));
  }
});

test("recovery codes: 10 unique, unambiguous, normalised, keyed hashes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(normalizeRecoveryCode(" abcde-fghjk "), "ABCDEFGHJK");
  assert.equal(normalizeRecoveryCode("short"), null);
  assert.equal(normalizeRecoveryCode(42), null);
  const h = hashRecoveryCode("ABCDEFGHJK", "u1", "k".repeat(40));
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, hashRecoveryCode("ABCDEFGHJK", "u2", "k".repeat(40)), "bound to the user");
  assert.notEqual(h, hashRecoveryCode("ABCDEFGHJK", "u1", "j".repeat(40)), "bound to the key");
});

test("password policy: length 10, not the username, not a common password", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 10);
  assert.equal(passwordProblem("short123", "bob"), "too_short");
  assert.equal(passwordProblem("123456789", "bob"), "too_short");
  assert.equal(passwordProblem(undefined, "bob"), "type");
  assert.equal(passwordProblem("operator.k1", "operator.k1"), "equals_username");
  assert.equal(passwordProblem("Operator.K1", "operator.k1"), "equals_username", "case-insensitive");
  assert.equal(passwordProblem("Password123", "bob"), "common");
  assert.equal(passwordProblem("1234567890", "bob"), "common");
  assert.equal(passwordProblem("united2026", "bob"), "common");
  assert.equal(passwordProblem("x".repeat(201), "bob"), "too_long");
  assert.equal(passwordProblem("Tomato-Crate-47", "bob"), null);
});

test("bcrypt: new hashes at cost 12; older cost-10 hashes still verify and are flagged for rehash", async () => {
  assert.equal(BCRYPT_COST, 12);
  const h = await hashPassword("Tomato-Crate-47");
  assert.equal(bcrypt.getRounds(h), 12);
  assert.equal(needsRehash(h), false);
  const old = bcrypt.hashSync("Tomato-Crate-47", 10);
  assert.equal(await verifyPassword("Tomato-Crate-47", old), true, "old hashes keep working");
  assert.equal(needsRehash(old), true);
  assert.equal(needsRehash("not-a-hash"), false);
});

test("session lifetime: setting floored to 1h and capped at 24h", () => {
  assert.equal(MAX_SESSION_HOURS, 24);
  assert.equal(effectiveSessionHours(12), 12);
  assert.equal(effectiveSessionHours(0.5), 1);
  assert.equal(effectiveSessionHours(720), 24);
  assert.equal(effectiveSessionHours(Number.NaN), 12);
});

test("CSP: nonce-based scripts, no unsafe-inline/eval in production, framing and plugins off", () => {
  const nonce = generateNonce();
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(nonce, generateNonce());
  const csp = buildContentSecurityPolicy(nonce);
  const d = Object.fromEntries(csp.split(";").map((x) => x.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.ok(d["script-src"].includes(`'nonce-${nonce}'`));
  assert.ok(d["script-src"].includes("'strict-dynamic'"));
  assert.ok(!d["script-src"].includes("'unsafe-inline'"));
  assert.ok(!d["script-src"].includes("'unsafe-eval'"));
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'self'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.deepEqual(d["img-src"], ["'self'", "data:", "blob:"]);
  assert.deepEqual(d["connect-src"], ["'self'"]);
  assert.ok(buildContentSecurityPolicy(nonce, { dev: true }).includes("'unsafe-eval'"), "dev only");
});

test("production refuses to boot without a long-enough MFA_ENCRYPTION_KEY", () => {
  const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "j".repeat(40) } as unknown as NodeJS.ProcessEnv;
  assert.deepEqual(productionEnvProblems({ ...base, MFA_ENCRYPTION_KEY: "m".repeat(48) }), []);
  assert.deepEqual(productionEnvProblems(base).map(([n]) => n), ["MFA_ENCRYPTION_KEY"]);
  assert.deepEqual(productionEnvProblems({ ...base, MFA_ENCRYPTION_KEY: "   " }).map(([n]) => n), ["MFA_ENCRYPTION_KEY"]);
  assert.deepEqual(productionEnvProblems({ ...base, MFA_ENCRYPTION_KEY: "short" }).map(([n]) => n), ["MFA_ENCRYPTION_KEY"]);
  // Names only — never a value.
  assert.ok(!JSON.stringify(productionEnvProblems({ ...base, MFA_ENCRYPTION_KEY: "short" })).includes("\"short\""));
});

test("auth.mfa_required_roles: default SUPER_ADMIN + ACCOUNTANT; only known roles, no duplicates", () => {
  assert.deepEqual(SETTING_DEFS["auth.mfa_required_roles"].default, ["SUPER_ADMIN", "ACCOUNTANT"]);
  assert.equal(parseSettingValue("auth.mfa_required_roles", []).ok, true);
  assert.equal(parseSettingValue("auth.mfa_required_roles", ["SALES"]).ok, true);
  assert.equal(parseSettingValue("auth.mfa_required_roles", ["NOPE"]).ok, false);
  assert.equal(parseSettingValue("auth.mfa_required_roles", ["SALES", "SALES"]).ok, false);
  assert.equal(parseSettingValue("auth.mfa_required_roles", "SUPER_ADMIN").ok, false);
});
