/**
 * Environment validation.
 *
 * Production refuses to start when a required secret is missing, and says which
 * ones — all of them at once, at boot, rather than one at a time as each code
 * path happens to hit its own missing value. A half-configured deployment that
 * boots and then fails per-request is much worse than one that never boots: the
 * first looks healthy to a load balancer while quietly rejecting real work.
 *
 * Development and tests are deliberately NOT gated — `.env` already supplies
 * these locally, and failing a dev server over a missing N8N key helps nobody.
 */

// `next build` also runs with NODE_ENV=production and evaluates route modules, so
// gate on the build phase too: a CI job that compiles the artifact without runtime
// secrets must still succeed. The secrets are required to SERVE, not to compile.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
const isProduction = process.env.NODE_ENV === "production" && !isBuildPhase;

/** Needed for the server to serve a single authenticated request at all. */
const REQUIRED_IN_PRODUCTION = [
  ["DATABASE_URL", "Postgres connection used by Prisma at runtime"],
  ["JWT_SECRET", "signs the session cookie — without it sessions cannot be trusted"],
  // WS6: the key the TOTP (two-step sign-in) secrets are encrypted with at rest. Without
  // it no enrolled user could sign in, and no new secret could be stored safely.
  ["MFA_ENCRYPTION_KEY", "encrypts two-step sign-in (TOTP) secrets at rest — at least 32 random characters"],
] as const;

/** A key shorter than this is refused in production: it would be guessable offline. */
export const MFA_KEY_MIN_LENGTH = 32;

/**
 * Needed for one feature rather than for the server itself. Missing values here
 * fail CLOSED at the point of use (an API-key order request is rejected 401), so
 * this is a loud warning at boot, not a refusal to start — a site that can still
 * take orders by hand is better than a site that will not come up at all.
 */
const REQUIRED_FOR_INTEGRATIONS = [
  ["N8N_API_KEY", "authenticates n8n/Hermes order intake on POST /api/orders"],
  ...(process.env.STORAGE_PROVIDER === "local"
    ? []
    : ([
        ["SUPABASE_URL", "attachment storage (Supabase Storage)"],
        ["SUPABASE_SERVICE_ROLE_KEY", "attachment storage (Supabase Storage)"],
      ] as const)),
] as const;

function missing(vars: readonly (readonly [string, string])[], env: NodeJS.ProcessEnv = process.env) {
  return vars.filter(([name]) => !env[name]?.trim());
}

/**
 * What would stop a production boot, as [name, why] pairs — empty when the environment
 * is complete. Exported so the rule itself is unit-tested without booting a server.
 * Never returns or logs a value, only names.
 */
export function productionEnvProblems(env: NodeJS.ProcessEnv = process.env): [string, string][] {
  const problems: [string, string][] = missing(REQUIRED_IN_PRODUCTION, env).map(([n, w]) => [n, w]);
  const mfaKey = env.MFA_ENCRYPTION_KEY?.trim();
  if (mfaKey && mfaKey.length < MFA_KEY_MIN_LENGTH) {
    problems.push(["MFA_ENCRYPTION_KEY", `too short — at least ${MFA_KEY_MIN_LENGTH} random characters (openssl rand -base64 48)`]);
  }
  return problems;
}

if (isProduction) {
  const fatal = productionEnvProblems();
  if (fatal.length > 0) {
    throw new Error(
      "Refusing to start: missing or invalid required environment variable(s) in production —\n" +
        fatal.map(([name, why]) => `  - ${name}: ${why}`).join("\n") +
        "\nSee .env.example. No value is ever defaulted: an insecure fallback is worse than no boot."
    );
  }

  for (const [name, why] of missing(REQUIRED_FOR_INTEGRATIONS)) {
    console.warn(`[env] ${name} is not set — ${why}. That integration will be refused (401) until it is.`);
  }
}

/** The session signing secret. Guaranteed non-empty in production by the check above. */
export const JWT_SECRET = process.env.JWT_SECRET ?? "insecure-dev-secret-do-not-use-in-production";

/**
 * Key material for encrypting TOTP secrets (lib/security/mfa-crypto.ts derives the
 * actual AES key from it with HKDF). Guaranteed present and long enough in production
 * by the check above; development and tests fall back to a fixed, public dev value so
 * a fresh clone works — which is exactly why production refuses to boot without one.
 */
export const MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY?.trim() || "insecure-dev-mfa-key-do-not-use-in-production";
