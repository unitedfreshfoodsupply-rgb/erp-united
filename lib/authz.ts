import { cache } from "react";
import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/rbac";
import { forbiddenMessage } from "@/lib/authz-core";
import { type Permission } from "@/lib/permissions";
import { type Role } from "@/lib/types";
import { applyOverrides, loadUserWithOverrides } from "@/lib/authz-core";
import { getSetting } from "@/lib/core/settings-service";

// The rules live in authz-core, which has no framework dependency and can therefore be
// imported by scripts. This module is only the request-scoped layer over them.
export {
  actorCan,
  assertPermission,
  forbiddenMessage,
  resolveEffectivePermissions,
  syncPermissionCatalogue,
} from "@/lib/authz-core";

/**
 * The one authorization mechanism in the system.
 *
 * Every protected route, service action and page resolves access through this file.
 * Nothing anywhere else may decide access from a role string — that is exactly how
 * authorization drifts out of sync between the API and the screen that calls it.
 *
 * Three properties this is built to guarantee:
 *
 *  1. It reads the user from the DATABASE on every request, never from the JWT. The
 *     token proves who you are; it does not say what you may do. A disabled account
 *     or a changed role therefore takes effect on the very next request, with no
 *     session to expire and nothing to revoke.
 *  2. It fails CLOSED. If permission resolution throws — the database is unreachable,
 *     a row is malformed — the caller gets no permissions and the request is refused.
 *     A failure to prove access is never treated as access.
 *  3. SUPER_ADMIN short-circuits to every permission and ignores overrides, so the
 *     administrator role cannot be edited into uselessness.
 */

export type AuthContext = {
  id: string;
  name: string;
  username: string;
  role: Role;
  permissions: Set<Permission>;
  /** Passwords are administrator-managed (users.edit); this flag is informational only. */
  active: boolean;
  mustChangePassword: boolean;
  deviceId?: string;
  can: (permission: Permission) => boolean;
};

function buildContext(
  user: { id: string; name: string; username: string; role: string; active: boolean; mustChangePassword?: boolean },
  permissions: Set<Permission>,
  deviceId?: string
): AuthContext {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role as Role,
    permissions,
    active: user.active,
    mustChangePassword: user.mustChangePassword ?? false,
    deviceId,
    can: (permission) => permissions.has(permission),
  };
}

/**
 * Loads the current user and their effective permissions, or null when there is no
 * valid session, the account no longer exists, or it has been disabled.
 *
 * WS6: also null while the account owes a second factor — its role is listed in
 * auth.mfa_required_roles and it has not enrolled. Such a session reaches nothing but
 * the enrolment endpoints (getMfaEnrollmentSession) and logout; every guard below and
 * every page treats it as not signed in, and the guards say why (403
 * auth.mfa-enroll-required) so the client can send the user to /mfa/setup.
 *
 * Any error while resolving is swallowed into null — refused, not allowed.
 */
export async function getAuthContext(deviceId?: string): Promise<AuthContext | null> {
  const resolved = await loadAuthState();
  return resolved.kind === "ok" ? buildContext(resolved.user, resolved.permissions, deviceId) : null;
}

/** The signed-in identity for the two-step enrolment endpoints only: a full session OR
 * one that is held at enrolment. Never use this to authorize anything else. */
export type MfaSessionUser = { id: string; name: string; username: string; role: Role; sessionEpoch: number; mfaEnabled: boolean; mustEnroll: boolean; deviceId?: string };

export async function getMfaEnrollmentSession(req?: NextRequest): Promise<MfaSessionUser | null> {
  const resolved = await loadAuthState();
  if (resolved.kind === "none") return null;
  const u = resolved.user;
  return { id: u.id, name: u.name, username: u.username, role: u.role as Role, sessionEpoch: u.sessionEpoch, mfaEnabled: u.mfaEnabled, mustEnroll: resolved.kind === "mfa_enroll", deviceId: deviceIdOf(req) };
}

/** True when the request carries a valid session that is held at MFA enrolment. */
export async function isMfaEnrollmentPending(): Promise<boolean> {
  return (await loadAuthState()).kind === "mfa_enroll";
}

/** For the enrolment endpoints: 401 without a session (full or held at enrolment). */
export async function requireMfaSession(req?: NextRequest): Promise<MfaSessionUser> {
  const s = await getMfaEnrollmentSession(req);
  if (!s) throw new ApiError(401, "لازم تسجل دخول الأول", "auth.required");
  return s;
}

type LoadedUser = { id: string; name: string; username: string; role: string; active: boolean; sessionEpoch: number; mustChangePassword: boolean; mfaEnabled: boolean };
type AuthState =
  | { kind: "none" }
  | { kind: "mfa_enroll"; user: LoadedUser }
  | { kind: "ok"; user: LoadedUser; permissions: Set<Permission> };

/**
 * One database round trip for identity AND permissions, memoised for the lifetime of
 * the request.
 *
 * Both matter on site: every protected request pays this cost, the database is a
 * region away, and a page guard plus the endpoints it calls would otherwise each
 * re-resolve the same user. Fetching the overrides alongside the user keeps the total
 * at exactly one query — the same as the role-only check this replaced — so adding
 * permissions cost the request nothing. (The MFA policy is a setting, served from the
 * in-process settings cache.)
 */
const loadAuthState = cache(async (): Promise<AuthState> => {
  try {
    const session = await getSessionUser();
    if (!session) return { kind: "none" };
    // The DB is authoritative for role and active state, not the signed token.
    const loaded = await loadUserWithOverrides(session.id);
    if (!loaded || !loaded.user.active) return { kind: "none" };
    // A password change (or any future "sign out everywhere") bumps the epoch; tokens
    // minted before it stop working on their very next request.
    if (loaded.user.sessionEpoch !== session.sessionEpoch) return { kind: "none" };
    // WS6: a role that requires a second factor gets nowhere without one. Checked per
    // request against the database (not a token claim), so it also catches a session
    // that predates the policy and a user just moved into a required role.
    if (!loaded.user.mfaEnabled) {
      const required = await getSetting("auth.mfa_required_roles");
      if (required.includes(loaded.user.role as Role)) return { kind: "mfa_enroll", user: loaded.user };
    }
    return {
      kind: "ok",
      user: loaded.user,
      // Passwords are administrator-managed end to end (users.edit) — there is no
      // self-service change, so mustChangePassword is informational only (shown as a
      // notice on the read-only profile) and never strips the user's permissions.
      permissions: applyOverrides(loaded.user.role as Role, loaded.overrides),
    };
  } catch (err) {
    // Next signals "this route must render dynamically" and "redirect" by throwing.
    // Those are control flow, not failures — swallowing them would both spam the log
    // with fake auth errors and interfere with Next's own rendering decisions.
    if (isFrameworkControlFlow(err)) throw err;
    console.error("[authz] permission resolution failed — denying access", err);
    return { kind: "none" };
  }
});

function isFrameworkControlFlow(err: unknown) {
  const digest = (err as { digest?: unknown })?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_") || digest === "DYNAMIC_SERVER_USAGE");
}

function deviceIdOf(req?: NextRequest) {
  return req?.headers.get("x-device-id") ?? undefined;
}

/** 401 when not signed in, 403 when signed in without the permission. */
/** The refusal for a request without a usable context: 403 with a machine-readable code
 * when the session is held at MFA enrolment, else the usual 401. */
async function noContext(): Promise<never> {
  if (await isMfaEnrollmentPending()) {
    throw new ApiError(403, "لازم تفعّل التحقق بخطوتين الأول", "auth.mfa-enroll-required");
  }
  throw new ApiError(401, "لازم تسجل دخول الأول", "auth.required");
}

export async function requirePermission(
  req: NextRequest | undefined,
  permission: Permission | Permission[]
): Promise<AuthContext> {
  const ctx = await getAuthContext(deviceIdOf(req));
  if (!ctx) return noContext();
  const needed = Array.isArray(permission) ? permission : [permission];
  const missing = needed.filter((p) => !ctx.can(p));
  if (missing.length > 0) throw new ApiError(403, forbiddenMessage(missing));
  return ctx;
}

/** Passes when the caller holds ANY of the listed permissions. */
export async function requireAnyPermission(
  req: NextRequest | undefined,
  permissions: Permission[]
): Promise<AuthContext> {
  const ctx = await getAuthContext(deviceIdOf(req));
  if (!ctx) return noContext();
  if (!permissions.some((p) => ctx.can(p))) throw new ApiError(403, forbiddenMessage(permissions));
  return ctx;
}

/** Authenticated only — for endpoints whose finer checks happen in the service. */
export async function requireAuth(req?: NextRequest): Promise<AuthContext> {
  const ctx = await getAuthContext(deviceIdOf(req));
  if (!ctx) return noContext();
  // SEC-01: there is no self-service password change (an administrator sets passwords), so
  // "must change password" is a notice, never a lock: refusing here locked the user out of
  // every authenticated-only route with no way to clear the flag themselves.
  return ctx;
}
