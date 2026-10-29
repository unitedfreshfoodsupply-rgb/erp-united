import { DICTIONARY } from "./dictionary";
import { intlLocale } from "@/lib/format";

/**
 * Translation for server-rendered print pages. They cannot read the locale the browser
 * stored, so the link that opens them passes it (`?lang=en`, like the invoice print);
 * no parameter means Arabic, the document default.
 */
export type PrintLocale = "ar" | "en";

export function printLocale(searchParams?: { lang?: string | string[] } | null): PrintLocale {
  const v = searchParams?.lang;
  return (Array.isArray(v) ? v[0] : v) === "en" ? "en" : "ar";
}

/** The same lookup rules as the client `t()`: a blank side falls back to the other
 * language, an unknown key shows itself, `{name}` fills from params. */
export function printT(locale: PrintLocale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const entry = (DICTIONARY as Record<string, { ar: string; en: string } | undefined>)[key];
    if (!entry) return key;
    const text = locale === "en" ? entry.en || entry.ar : entry.ar || entry.en;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  };
}

export function printDir(locale: PrintLocale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Dates and numbers on the sheet use the sheet's language, with the app's digits (lib/format). */
export function printIntl(locale: PrintLocale): string {
  return intlLocale(locale);
}
