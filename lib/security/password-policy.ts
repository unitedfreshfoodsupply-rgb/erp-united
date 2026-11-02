import bcrypt from "bcryptjs";

/**
 * Password rules and hashing, framework-free (imported by the admin service, the
 * sign-in route and unit tests).
 *
 * The policy applies to NEW passwords only — creating a user or setting a password.
 * An existing hash is never re-judged: an account whose password predates these rules
 * keeps signing in exactly as before, so deploying them locks nobody out.
 */

/** WS6: raised from 8. */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
/** WS6: raised from 10. New hashes use this; older ones are upgraded on the next sign-in. */
export const BCRYPT_COST = 12;

/**
 * The passwords tried first by every guessing tool, plus the obvious local ones. Kept
 * short on purpose: the length rule already removes most of any public list, and what
 * remains here is what a person under time pressure actually types. Compared
 * case-insensitively.
 */
const COMMON_PASSWORDS = new Set(
  [
    "1234567890", "0123456789", "12345678910", "123456789a", "a123456789", "1q2w3e4r5t", "1qaz2wsx3edc",
    "qwertyuiop", "asdfghjkl;", "zxcvbnm123", "qwerty1234", "qwerty12345", "1234qwerty", "q1w2e3r4t5",
    "password12", "password123", "password1234", "password!1", "passw0rd12", "p@ssw0rd12", "p@ssword123",
    "iloveyou12", "letmein123", "welcome123", "welcome1234", "admin12345", "admin123456", "administrator",
    "changeme123", "default123", "abc1234567", "abcdefghij", "1111111111", "0000000000", "1212121212",
    "9876543210", "5555555555", "1234512345", "1122334455", "aaaaaaaaaa", "qazwsxedcr", "superadmin",
    "superadmin1", "united1234", "united12345", "united2024", "united2025", "united2026", "united@123",
    "united@2026", "unitederp1", "unitederp123", "egypt12345", "cairo12345", "test123456", "test1234567",
    "guest12345", "user123456", "manager123", "accountant1", "accountant123",
  ].map((p) => p.toLowerCase())
);

export type PasswordProblem = "type" | "too_short" | "too_long" | "equals_username" | "common";

/** Null when acceptable, else the first rule it breaks. */
export function passwordProblem(password: unknown, username?: string | null): PasswordProblem | null {
  if (typeof password !== "string") return "type";
  if (password.length < MIN_PASSWORD_LENGTH) return "too_short";
  if (password.length > MAX_PASSWORD_LENGTH) return "too_long";
  const lower = password.trim().toLowerCase();
  if (username && lower === username.trim().toLowerCase()) return "equals_username";
  if (COMMON_PASSWORDS.has(lower)) return "common";
  return null;
}

/** Arabic message for the admin screen (the server-message catalogue translates it). */
export function passwordProblemMessage(problem: PasswordProblem): string {
  switch (problem) {
    case "type":
    case "too_short":
      return `كلمة السر لازم تكون ${MIN_PASSWORD_LENGTH} خانات على الأقل`;
    case "too_long":
      return `كلمة السر لازم تكون ${MAX_PASSWORD_LENGTH} خانة بالكتير`;
    case "equals_username":
      return "كلمة السر مينفعش تكون نفس اسم المستخدم";
    case "common":
      return "كلمة السر دي مشهورة وسهل تتخمن — اختار كلمة سر تانية";
  }
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

/** True when a stored hash was made with a lower cost than today's (or is unreadable). */
export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) < BCRYPT_COST;
  } catch {
    return false;
  }
}
