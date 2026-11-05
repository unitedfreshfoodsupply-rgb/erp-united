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
