import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP), with nothing but
 * node:crypto — no third-party service sees a secret or a code.
 *
 * Parameters are the ones every authenticator app assumes by default: HMAC-SHA1,
 * 30-second steps, 6 digits. A code is accepted for the current step and one step
 * either side (clock drift on a phone is common); the caller passes the last step it
 * accepted for this user, and only a LATER step is accepted — the same code can never
 * be used twice, even inside its own 90-second window.
 *
 * Pure: no database, no framework. Unit-tested against the RFC 6238 test vectors.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
/** 160 bits, the RFC 4226 recommendation for HMAC-SHA1. */
export const TOTP_SECRET_BYTES = 20;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** RFC 4226 HOTP. `algorithm` exists only so the RFC 6238 SHA-256/512 vectors can be checked. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCode(secretBase32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

function sameDigits(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Checks a code against the current step ± TOTP_WINDOW. Returns the step it matched,
 * or null. A step at or before `lastUsedStep` never matches (replay protection): the
 * caller persists the returned step atomically, conditional on it still being newer.
 */
export function verifyTotp(
  secretBase32: string,
  code: unknown,
  opts: { nowMs?: number; lastUsedStep?: number | null } = {}
): number | null {
  if (typeof code !== "string") return null;
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secretBase32);
  const now = totpStep(opts.nowMs);
  let matched: number | null = null;
  // Check every candidate (no early exit) so the time taken does not say which matched.
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
    if (sameDigits(hotp(key, step), digits) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.lastUsedStep != null && matched <= opts.lastUsedStep) return null;
  return matched;
}

/** The otpauth:// URI authenticator apps scan (Key Uri Format). */
export function otpauthUri(secretBase32: string, account: string, issuer = "UNITED ERP"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;
/** No 0/O/1/I/L: a code copied by hand from paper must read back unambiguously. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** "XXXXX-XXXXX": 10 symbols from a 31-letter alphabet ≈ 49.5 bits each. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  // Rejection sampling: bytes past the largest multiple of the alphabet size are
  // dropped, so every symbol is equally likely (no modulo bias).
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  while (codes.size < count) {
    let s = "";
    while (s.length < 10) {
      for (const b of randomBytes(16)) {
        if (b < limit && s.length < 10) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
      }
    }
    codes.add(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return [...codes];
}

/** Case, spaces and dashes do not matter when a recovery code is typed back. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{10}$/.test(s) ? s : null;
}
