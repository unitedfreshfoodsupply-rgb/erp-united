/**
 * Filters, search and paging kept in the address (Nov 2026).
 *
 * The address only records the list's state, so a link, a bookmark or Back reopens it as it
 * was. Writing it with the router (router.replace) made every filter change a server round
 * trip — the page re-rendered on the server and useSearchParams changed only when that
 * returned — before the list's own request was even sent. history.replaceState changes the
 * address in place: Next's router picks it up for useSearchParams with no request
 * (components/profiles/ProfileParts.tsx keeps its ?tab= the same way).
 */

/** `search` (a location.search) with `patch` applied; null, undefined and "" remove a key. */
export function withParams(search: string, patch: Record<string, string | number | null | undefined>): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") next.delete(k);
    else next.set(k, String(v));
  }
  return next;
}

/**
 * A list's state change (components/ui/DataTable.tsx useListState): keys carry the list's
 * prefix (two lists on one page keep apart), and any change but paging starts again at page 1.
 */
export function withListPatch(search: string, patch: Record<string, string | number | null>, prefix = ""): URLSearchParams {
  const next = withParams(search, Object.fromEntries(Object.entries(patch).map(([k, v]) => [prefix + k, v])));
  if (!("page" in patch)) next.delete(prefix + "page");
  return next;
}

/** Puts `params` in the address in place of the current query string (no navigation, no request). */
export function replaceQuery(params: URLSearchParams) {
  const qs = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
}

/**
 * The page a signed-out visitor asked for (`?next=` on /login, set by lib/session-guard.ts and the
 * API client's 401 handler), when it is a page of this app: a same-origin path, never another site
 * ("//host", "/\\host", "https://…") and never the sign-in steps themselves. Null otherwise.
 */
export function returnPath(next: string | null | undefined, origin: string): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || url.pathname === "/login" || url.pathname.startsWith("/mfa")) return null;
    // Only pages: a route handler or a build file is never a place to land after signing in, and
    // neither is /no-access (the landing for an account without any permission, not a destination).
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/") || url.pathname === "/no-access") return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

/** Any fixed origin: returnPath only needs one to resolve a path against. */
const SIGN_IN_ORIGIN = "http://united.invalid";

/** The sign-in address for a visitor who asked for `asked` (the path middleware.ts records in
 * x-united-path): /login?next=… when returnPath accepts it, plain /login otherwise (and for "/",
 * which lands on the home page anyway). Used by lib/session-guard.ts signInPath. */
export function signInHref(asked: string | null | undefined): string {
  const back = asked && asked !== "/" ? returnPath(asked, SIGN_IN_ORIGIN) : null;
  return back ? `/login?next=${encodeURIComponent(back)}` : "/login";
}
