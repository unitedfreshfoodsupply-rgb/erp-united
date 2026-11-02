/**
 * Arabic-Indic numerals (I18N-02). Tablets with an Arabic keyboard type ٠١٢٣٤٥٦٧٨٩ (or the
 * Persian ۰۱۲۳۴۵۶۷۸۹), the Arabic decimal separator ٫ and thousands separator ٬. JavaScript's
 * Number() and Prisma's Decimal read none of them: "١٢٫٥" became NaN — a silent 0 in a
 * quantity field, or a refused request. The screens show Latin digits in both languages
 * (by design); input in either script means the same number.
 */
const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN = /[۰-۹]/g;

/** Every Arabic-Indic / Persian digit as its Latin digit; the Arabic separators as "." and nothing. */
export function toLatinDigits(s: string): string {
  return s
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, "");
}

/** A string that is a number and nothing else (sign, digits in any of the three scripts, one decimal separator, grouping). */
const NUMBER_LIKE = /^\s*[+\-−]?[0-9٠-٩۰-۹][0-9٠-٩۰-۹٬,]*([.٫][0-9٠-٩۰-۹]+)?\s*$/;

/**
 * Normalises a request body: every string that is entirely a number written with Arabic
 * digits or separators becomes its Latin form. Text that merely contains digits ("فرع ٣")
 * is left as typed; Latin-only strings are untouched (a Latin "1,234" keeps its comma).
 */
export function normalizeNumerals<T>(value: T): T {
  if (typeof value === "string") {
    return (/[٠-٩۰-۹٫٬]/.test(value) && NUMBER_LIKE.test(value) ? toLatinDigits(value).replace(/−/g, "-").trim() : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => normalizeNumerals(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeNumerals(v);
    return out as T;
  }
  return value;
}
