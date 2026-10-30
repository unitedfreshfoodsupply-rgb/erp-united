/**
 * How many rows a list endpoint returns. Lists used to stop at a fixed 300 without
 * saying so, so a record past the cap simply looked missing. Now the endpoint takes
 * `?limit=`, returns the total alongside the rows, and the screen offers "load more".
 * The default stays at the old cap, so existing callers see the same rows.
 */
export const LIST_DEFAULT_LIMIT = 300;
export const LIST_MAX_LIMIT = 3000;

export function listLimit(raw: string | number | null | undefined): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return LIST_DEFAULT_LIMIT;
  return Math.min(n, LIST_MAX_LIMIT);
}
