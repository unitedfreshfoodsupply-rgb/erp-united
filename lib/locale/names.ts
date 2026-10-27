/**
 * Locale-aware display names for business entities.
 *
 * The schema's convention: `name` is the canonical English name (`legalName` /
 * `tradeName` for a company) and `nameAr` the Arabic one, optional on most models.
 * `nameEn` is accepted for DTOs that spell it out. This module only PICKS a value for
 * display — it never rewrites stored data and never invents a translation.
 *
 * Fallback policy (documented, deterministic):
 *   ar: Arabic name → English name → code → "بدون اسم"
 *   en: English name → Arabic name → code → "Unnamed"
 *
 * Pure and framework-free so server code, print pages and tests can use it.
 */

export type NameLocale = "ar" | "en";

export type LocalizedNameSource = {
  name?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  legalName?: string | null;
  tradeName?: string | null;
  code?: string | null;
  sku?: string | null;
};

const UNNAMED: Record<NameLocale, string> = { ar: "بدون اسم", en: "Unnamed" };

/** Collapses whitespace; anything that is not a non-blank string becomes null. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/\s+/g, " ").trim();
  return v ? v : null;
}

function firstOf(values: unknown[]): string | null {
  for (const v of values) {
    const c = cleanName(v);
    if (c) return c;
  }
  return null;
}

const englishOf = (e: LocalizedNameSource) => firstOf([e.nameEn, e.name, e.legalName, e.tradeName]);
const arabicOf = (e: LocalizedNameSource) => firstOf([e.nameAr]);
const codeOf = (e: LocalizedNameSource) => firstOf([e.code, e.sku]);

/** The name to show for `entity` in `locale` (see the fallback policy above). */
export function localName(entity: LocalizedNameSource | null | undefined, locale: NameLocale): string {
  if (!entity) return UNNAMED[locale];
  const primary = locale === "ar" ? arabicOf(entity) ?? englishOf(entity) : englishOf(entity) ?? arabicOf(entity);
  return primary ?? codeOf(entity) ?? UNNAMED[locale];
}

/** The other language's name when it exists and differs — for screens that show both. */
export function otherLocalName(entity: LocalizedNameSource | null | undefined, locale: NameLocale): string | null {
  if (!entity) return null;
  const other = locale === "ar" ? englishOf(entity) : arabicOf(entity);
  return other && other !== localName(entity, locale) ? other : null;
}

/** "CODE · Name" for selectors, where the code disambiguates; the code is never the
 * name itself, so a nameless record reads "CODE" rather than "CODE · CODE". */
export function codedLocalName(entity: LocalizedNameSource | null | undefined, locale: NameLocale, code?: string | null): string {
  const label = localName(entity, locale);
  const c = cleanName(code) ?? (entity ? codeOf(entity) : null);
  return c && c !== label ? `${c} · ${label}` : label;
}

/** Search across both names and the code, whatever the display locale. */
export function matchesLocalName(entity: LocalizedNameSource, query: string): boolean {
  const q = cleanName(query)?.toLowerCase();
  if (!q) return true;
  return [englishOf(entity), arabicOf(entity), codeOf(entity), cleanName(entity.name), cleanName(entity.legalName)].some((v) => !!v && v.toLowerCase().includes(q));
}

/** Locale-aware sort comparator by display name. */
export function compareLocalNames(locale: NameLocale) {
  const collator = new Intl.Collator(locale === "ar" ? "ar" : "en", { sensitivity: "base", numeric: true });
  return (a: LocalizedNameSource, b: LocalizedNameSource) => collator.compare(localName(a, locale), localName(b, locale));
}
