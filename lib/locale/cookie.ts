/**
 * The interface language, known before any script runs (Nov 2026).
 *
 * The chosen language is kept in a cookie (as well as localStorage, which lib/api-client.ts
 * reads), so app/layout.tsx renders <html lang/dir>, the font and every string in it from the
 * first byte, and the server HTML can be shown at once — no hidden page while the browser's
 * choice is read, and no Arabic flash under an English UI. With no choice made yet, the
 * browser's first preferred language decides, as navigator.language did on the client.
 *
 * No "use client" here: the root layout (a server component) reads the same names.
 */
export type UiLocale = "ar" | "en";

export const LOCALE_COOKIE = "u_locale";

export function isUiLocale(v: unknown): v is UiLocale {
  return v === "ar" || v === "en";
}

/** The browser's first preferred language: English when it is English, Arabic otherwise. */
export function preferredLocale(language: string | null | undefined): UiLocale {
  const first = (language ?? "").split(",")[0].split(";")[0].trim().toLowerCase();
  return first.slice(0, 2) === "en" ? "en" : "ar";
}

/** The language a page is rendered in: the cookie, else the Accept-Language header. */
export function initialLocale(cookie: string | null | undefined, acceptLanguage: string | null | undefined): UiLocale {
  return isUiLocale(cookie) ? cookie : preferredLocale(acceptLanguage);
}

/** The cookie line for `locale` (a layout hint like u_shell / u_rail in components/Nav.tsx). */
export function localeCookie(locale: UiLocale): string {
  return `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

/** The cookie's value in a document.cookie string, or null when it is absent or unknown. */
export function readLocaleCookie(cookieHeader: string): UiLocale | null {
  const v = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${LOCALE_COOKIE}=`))?.slice(LOCALE_COOKIE.length + 1);
  return isUiLocale(v) ? v : null;
}
