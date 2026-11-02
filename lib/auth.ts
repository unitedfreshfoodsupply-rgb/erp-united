import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { JWT_SECRET } from "@/lib/env";
import type { Role } from "@/lib/types";

// Hashing lives in a framework-free module (cost, rehash rule, password policy).
export { hashPassword, verifyPassword, needsRehash } from "@/lib/security/password-policy";

const COOKIE_NAME = "united_session";

/**
 * WS6: absolute session lifetime. auth.session_ttl_hours (default 12) still sets how
 * long a sign-in lasts, but no session — whatever the setting says, and whatever `exp`
 * an older token carries — is honoured more than this long after it was issued.
 * Sessions are never extended (there is no sliding refresh), so this is a true cap.
 */
export const MAX_SESSION_HOURS = 24;

/** The hours a new session is signed for: the setting, floored to 1, capped at MAX_SESSION_HOURS. */
export function effectiveSessionHours(ttlHours: number) {
  const h = Number.isFinite(ttlHours) ? Math.floor(ttlHours) : 12;
  return Math.min(MAX_SESSION_HOURS, Math.max(1, h));
}

// lib/env.ts is the single place that decides what a missing secret means: in
// production a missing JWT_SECRET refuses the boot rather than falling back to a
// string baked into this repo, which anyone who has read the source could use to
// forge a SUPER_ADMIN session.
const secret = new TextEncoder().encode(JWT_SECRET);

export type SessionUser = {
  id: string;
  name: string;
  username: string;
  role: Role;
  /** User.sessionEpoch at sign-in. A token whose epoch no longer matches the user's
   * row is refused, which is how a password change ends every older session. Tokens
   * issued before this claim existed read as epoch 1, so deploying it signs nobody out. */
  sessionEpoch: number;
};

export async function createSessionToken(user: SessionUser, ttlHours: number) {
  return new SignJWT({ id: user.id, name: user.name, username: user.username, role: user.role, sep: user.sessionEpoch })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${effectiveSessionHours(ttlHours)}h`)
    .sign(secret);
}

/**
 * Sets the session cookie to `token` — the SAME token the response hands the tab
 * (sessionStorage), so the two credentials can never disagree.
 *
 * SameSite=Strict (WS6, was Lax): the cookie is not sent on any request started by
 * another site, top-level navigations included. Nothing in the app depends on a
 * cross-site arrival carrying the session: integrations authenticate with API keys
 * (no cookie), every redirect is same-site, and the client sends a Bearer token from
 * sessionStorage. The one visible effect: following a link to the app from another
 * site (webmail, chat web client) opens the sign-in page instead of the target page;
 * opening it directly (address bar, bookmark, QR scan, reload) is unaffected.
 */
export function setSessionCookieToken(token: string, ttlHours: number) {
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: effectiveSessionHours(ttlHours) * 3600,
  });
}

export async function setSessionCookie(user: SessionUser, ttlHours: number) {
  const token = await createSessionToken(user, ttlHours);
  setSessionCookieToken(token, ttlHours);
  return token;
}

export function clearSessionCookie() {
  cookies().delete(COOKIE_NAME);
}

/** Verify a raw JWT string and return the embedded SessionUser, or null on any
 * failure (expired, tampered, wrong key). Shared by the cookie path and the Bearer
 * path below. */
async function verifyToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    // Absolute cap, applied to the issue time rather than trusting `exp`: a token minted
    // before the cap existed (or under a longer TTL setting) still ends on time.
    if (typeof payload.iat !== "number" || Date.now() / 1000 - payload.iat > MAX_SESSION_HOURS * 3600) return null;
    if (typeof payload.id !== "string" || !payload.id) return null;
    return {
      id: payload.id as string,
      name: payload.name as string,
      username: payload.username as string,
      role: payload.role as Role,
      sessionEpoch: typeof payload.sep === "number" ? payload.sep : 1,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the session from two sources, in order of precedence:
 *
 *  1. `Authorization: Bearer <JWT>` — set by the client from
 *     sessionStorage (tab-scoped). If this header is present but its token is
 *     invalid or expired, the request is refused as unauthenticated (returns
 *     null). There is NO silent fallback to the shared cookie when a Bearer
 *     token is present but bad — that would let a compromised tab read
 *     the cookie of another user.
 *
 *  2. `united_session` httpOnly cookie — the traditional shared storage,
 *     used when no Authorization header is supplied (backward-compatible
 *     path for users who do not need multi-tab isolation).
 *
 * A well-formed Bearer token that is valid for a *different* user than the
 * cookie happens to also hold is not possible (the JWT carries the identity;
 * the server re-reads permissions from the DB for every request), so there
 * is no cross-user confusion risk.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  // 1. Authorization: Bearer — tab-scoped sessionStorage
  try {
    const { headers } = await import("next/headers");
    const authHeader = headers().get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const user = await verifyToken(authHeader.slice(7));
      // SECURITY: if a Bearer token is present but invalid or expired, DO NOT
      // fall back to the cookie. A Bearer-bearing request explicitly opted into
      // per-tab auth; silently using the cookie would defeat the isolation.
      return user;
    }
    // If an Authorization header is present but NOT a Bearer token, refuse.
    if (authHeader) return null;
  } catch {
    // headers() may not be available outside a request context (e.g. build
    // phase). Silently fall through to cookie.
  }

  // 2. Cookie — shared traditional path
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
}

// ---------------------------------------------------------------------------
// Two-step sign-in: the pre-authentication token
// ---------------------------------------------------------------------------

/**
 * After a correct password, an MFA-enrolled user gets this instead of a session. It
 * proves only "this password was right, a few minutes ago" and is accepted by exactly
 * one thing: the code step of POST /api/auth/login.
 *
 * It can never be used as a session: it is signed with a DIFFERENT key (derived from
 * JWT_SECRET, so no new secret to manage), carries its own audience and type, and has
 * no `id` claim — verifyToken() above refuses it on the signature alone.
 */
const PREAUTH_TTL_SECONDS = 5 * 60;
const PREAUTH_AUDIENCE = "united-mfa-preauth";
const preauthKey = createHash("sha256").update(`united-mfa-preauth:${JWT_SECRET}`).digest();

export type PreAuth = { userId: string; sessionEpoch: number };

export async function createPreAuthToken(p: PreAuth) {
  return new SignJWT({ typ: "mfa-preauth", sep: p.sessionEpoch })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(p.userId)
    .setAudience(PREAUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${PREAUTH_TTL_SECONDS}s`)
    .sign(preauthKey);
}

export async function verifyPreAuthToken(token: unknown): Promise<PreAuth | null> {
  if (typeof token !== "string" || token.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(token, preauthKey, { audience: PREAUTH_AUDIENCE, algorithms: ["HS256"] });
    if (payload.typ !== "mfa-preauth" || typeof payload.sub !== "string" || typeof payload.sep !== "number") return null;
    return { userId: payload.sub, sessionEpoch: payload.sep };
  } catch {
    return null;
  }
}
