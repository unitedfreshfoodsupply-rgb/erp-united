/**
 * The locale the UI is rendering in, for formatting helpers called during render that
 * have no hook access (fmtMoney is used from 80+ places). LocaleProvider sets it in its
 * own render, which always runs before its children's, so a child formatting a value
 * sees the same locale as its text — no one-render lag after a switch. On the server it
 * stays "ar": it is one value for the whole process, shared by concurrent requests, so the
 * provider sets it only in the browser.
 */
let active: "ar" | "en" = "ar";

export function setActiveLocale(locale: "ar" | "en") {
  active = locale;
}

export function activeLocale(): "ar" | "en" {
  return active;
}
