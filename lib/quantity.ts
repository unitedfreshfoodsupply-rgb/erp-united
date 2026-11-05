/**
 * Quantities as people type and tap them (LOG-2, Nov 2026): plain numbers, up to three
 * decimals (a weight to the gram). In binary floating point 16.1 × 1000 is
 * 16100.000000000002 and 2.3 − 1 is 1.2999999999999998, so "has at most three decimals" must
 * not be asked by multiplying, and a stepper must not hand on raw float sums. Both questions
 * are answered here, on the number's decimal value — the one the person typed — so the server's
 * checks and the +/− buttons agree on what a valid quantity is. No dependencies: the same module
 * runs in the browser and on the server.
 */

export const QUANTITY_DECIMALS = 3;

/** True when `q` has at most `places` decimals as written: 16.1, 32.2, 2.01, 1.001 fit three;
 * 1.2999999999999998 and 0.0005 do not. Exact for quantities below 10^12 at three places. */
export function fitsDecimals(q: number, places = QUANTITY_DECIMALS): boolean {
  if (!Number.isFinite(q)) return false;
  const scale = 10 ** places;
  return Math.round(q * scale) / scale === q;
}

/** The stepper's next value: `value + delta` at `places` decimals, never below zero
 * (2.3 − 1 is 1.3). */
export function stepQuantity(value: number, delta: number, places = QUANTITY_DECIMALS): number {
  const scale = 10 ** places;
  return Math.max(0, Math.round((value + delta) * scale) / scale);
}
