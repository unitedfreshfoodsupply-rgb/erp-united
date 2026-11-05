"use client";

import { createContext, useCallback, useEffect, useState, type ReactNode } from "react";
import { DICTIONARY } from "./dictionary";
import { setActiveLocale } from "./active";
import { localeCookie, preferredLocale, readLocaleCookie } from "./cookie";

export type Locale = "ar" | "en";

export type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  dir: "ltr" | "rtl";
  isRTL: boolean;
  isEN: boolean;
};

const STORAGE_KEY = "united_locale";

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // Storage blocked — the cookie and the browser preference still decide.
  }
}

function writeStored(l: Locale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // Storage blocked (private mode / policy): the cookie still carries the choice.
  }
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: "ar",
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key) => {
    const dict: Record<string, { ar: string; en: string } | undefined> = DICTIONARY;
    return dict[key]?.ar ?? key;
  },
  dir: "rtl",
  isRTL: true,
  isEN: false,
});

/**
 * `initialLocale` is the language the server rendered the page in (app/layout.tsx, from the
 * u_locale cookie — lib/locale/cookie.ts), so the first render here matches the server HTML
 * and the page is shown as soon as it arrives.
 */
export function LocaleProvider({ children, initialLocale = "ar" }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // The cookie and localStorage (which lib/api-client.ts reads) agree from here on. A choice
  // made before the cookie existed is still only in localStorage: it moves into the cookie,
  // and that browser sees the switch once, on its first load after this release.
  useEffect(() => {
    const cookie = readLocaleCookie(document.cookie);
    const stored = readStored();
    if (cookie) {
      if (stored !== cookie) writeStored(cookie);
      if (cookie !== initialLocale) setLocaleState(cookie);
      return;
    }
    if (stored === "ar" || stored === "en") {
      document.cookie = localeCookie(stored);
      if (stored !== initialLocale) setLocaleState(stored);
      return;
    }
    // No choice made: the browser's language, as the server guessed from Accept-Language.
    const preferred = preferredLocale(navigator.language);
    if (preferred !== initialLocale) setLocaleState(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on load
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.cookie = localeCookie(l);
    writeStored(l);
  }, []);

  // <html lang/dir> and the font follow the active locale, whichever way it was set. The
  // server already rendered them for the initial one; this keeps them right after a switch.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    document.body.classList.toggle("font-arabic", locale === "ar");
    document.body.classList.toggle("font-english", locale === "en");
    // The server titled the page in the initial language (app/layout.tsx); follow a switch.
    document.title = DICTIONARY["app.title"][locale];
  }, [locale]);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "ar" ? "en" : "ar");
  }, [locale, setLocale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const entry = (DICTIONARY as Record<string, { ar: string; en: string } | undefined>)[key];
      if (!entry) return key;
      const arText = entry.ar;
      const enText = entry.en;
      // A blank side falls back to the other language; an entry that is deliberately
      // empty in both stays empty. Only an unknown key shows the key itself.
      const picked = locale === "en" ? enText || arText : arText || enText;
      const text = typeof picked === "string" ? picked : null;
      if (text === null) return key;
      if (!params || !text) return text;
      return text.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`));
    },
    [locale]
  );

  const dir: "ltr" | "rtl" = locale === "ar" ? "rtl" : "ltr";
  // Browser only: on the server this is one module-wide value shared by concurrent requests,
  // so it stays "ar" there (lib/locale/active.ts) rather than follow one request's cookie.
  if (typeof window !== "undefined") setActiveLocale(locale);
  const isRTL = locale === "ar";
  const isEN = locale === "en";

  // Shown from the first byte: the server rendered this same locale (no hidden page until
  // hydration). The wrapper stays so the element tree is the one the app has always had.
  return (
    <LocaleContext.Provider value={{ locale, setLocale, toggleLocale, t, dir, isRTL, isEN }}>
      <div style={{ display: "contents" }}>{children}</div>
    </LocaleContext.Provider>
  );
}