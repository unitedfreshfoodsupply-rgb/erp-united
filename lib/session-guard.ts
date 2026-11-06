import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { resolveAuth, type AuthContext, type AuthOutcome } from "@/lib/authz";
import { homePathFor } from "@/lib/nav";
import { signInHref } from "@/lib/hooks/urlQuery";
import type { Permission } from "@/lib/permissions";
import { HOME_BY_ROLE } from "@/lib/types";

export { HOME_BY_ROLE };

/** Where a visitor without a usable session goes: the sign-in form, or — when the
 * session is held until a second factor is set up (WS6) — the enrolment page. The sign-in
 * form is told which page was asked for (?next=, from the path middleware.ts records), so a
 * shared link or a notification opens that page once the visitor has signed in. When the
 * database could not check the session at all, nowhere: the page fails (its error screen)
 * instead of signing a signed-in user out. */
export async function signInPath(): Promise<string> {
  return signInPathFor(await resolveAuth());
}

function signInPathFor(outcome: AuthOutcome): string {
  if (outcome.kind === "unavailable") throw outcome.error;
  return outcome.kind === "mfa_enroll" ? "/mfa/setup" : signInHref(headers().get("x-united-path"));
}

/** The signed-in user for a page, from one read of the session; otherwise redirects (or, when
 * the database could not answer, fails to the error screen) exactly as signInPath says. */
async function pageUser(): Promise<AuthContext> {
  const outcome = await resolveAuth();
  if (outcome.kind === "ok") return outcome.ctx;
  redirect(signInPathFor(outcome));
}

export type PageGate =
  | { ok: true; user: AuthContext }
  | { ok: false; user: AuthContext; missing: Permission[] };

/**
 * Server-side page guard.
 *
 * Unauthenticated (or disabled) visitors are sent to /login. An authenticated user
 * who lacks the permission is NOT bounced somewhere else — the page renders an
 * explicit access-denied state. A silent redirect hides the fact that a rule exists,
 * which makes a genuine permission problem indistinguishable from a broken link.
 *
 * This is defence in depth, not the defence: every API the page calls enforces the
 * same permission independently, so a hidden link is never what keeps data safe.
 */
export async function requirePagePermission(
  permission: Permission | Permission[]
): Promise<PageGate> {
  const user = await pageUser();
  const needed = Array.isArray(permission) ? permission : [permission];
  const missing = needed.filter((p) => !user.can(p));
  if (missing.length > 0) return { ok: false, user, missing };
  return { ok: true, user };
}

/** Like requirePagePermission, but any one of the permissions opens the page. */
export async function requireAnyPagePermission(permissions: Permission[]): Promise<PageGate> {
  const user = await pageUser();
  if (permissions.some((p) => user.can(p))) return { ok: true, user };
  return { ok: false, user, missing: permissions };
}

/** Landing page for the signed-in user, derived from what they can actually reach. */
export async function resolveHomePath() {
  const user = await pageUser();
  return homePathFor(user.permissions, user.role);
}
