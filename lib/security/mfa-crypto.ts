import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * At-rest protection for two-step sign-in material.
 *
 *  - TOTP secrets: AES-256-GCM. The key is derived (HKDF-SHA256) from the
 *    MFA_ENCRYPTION_KEY environment variable — a database dump alone cannot produce a
 *    single valid code. The user id is bound in as additional authenticated data, so a
 *    secret copied onto another user's row does not decrypt.
 *  - Recovery codes: HMAC-SHA256 under a second derived key. They are random (~50 bits)
 *    and single use, so a keyed hash is enough and keeps verification instant.
 *
 * Envelope: "v1.<iv>.<tag>.<ciphertext>" (base64url). The migration refuses anything
 * else in the column, so a clear secret can never be stored by mistake.
 *
 * Nothing here logs, and errors never carry key or plaintext material.
 */

const VERSION = "v1";

function deriveKey(master: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.from("united-erp-mfa", "utf8"), Buffer.from(info, "utf8"), 32));
}

let keys: { master: string; enc: Buffer; rec: Buffer } | null = null;
function keyset(master: string) {
  if (!keys || keys.master !== master) keys = { master, enc: deriveKey(master, "totp-secret-v1"), rec: deriveKey(master, "recovery-code-v1") };
  return keys;
}

export function encryptMfaSecret(plain: string, userId: string, master: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyset(master).enc, iv);
  cipher.setAAD(Buffer.from(`user:${userId}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Throws a generic error (no material in the message) when the envelope is not valid
 * for this user under this key — a wrong/rotated key, a copied row, or tampering. */
export function decryptMfaSecret(envelope: string, userId: string, master: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("mfa secret: unsupported envelope");
  try {
    const [, iv, tag, ct] = parts;
    const decipher = createDecipheriv("aes-256-gcm", keyset(master).enc, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`user:${userId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("mfa secret: cannot be decrypted with the configured key");
  }
}

/** Keyed hash of a NORMALISED recovery code (see normalizeRecoveryCode). Bound to the user. */
export function hashRecoveryCode(normalized: string, userId: string, master: string): string {
  return createHmac("sha256", keyset(master).rec).update(`${userId}:${normalized}`).digest("hex");
}
