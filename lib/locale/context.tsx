"use client";

import { createContext, useCallback, useEffect, useState, type ReactNode } from "react";
import { DICTIONARY } from "./dictionary";

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

function getInitialLocale(): Locale {
  if (typeof window === "undefined") return "ar";
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked — fall through to the browser preference.
  }
  if (stored === "ar" || stored === "en") return stored;
  // Respect browser language preference
  const browserLang = navigator.language?.slice(0, 2);
  return browserLang === "en" ? "en" : "ar";
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: "ar",
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key) => {
    const dict = DICTIONARY as any;
    return dict[key]?.ar ?? key;
  },
  dir: "rtl",
  isRTL: true,
  isEN: false,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("ar");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setLocaleState(getInitialLocale());
    setMounted(true);
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Storage blocked (private mode / policy): the switch still applies to this page.
    }
  }, []);

  // <html lang/dir> and the font follow the active locale, whichever way it was set —
  // including the locale restored from storage on load, which previously left the
  // document RTL/Arabic under an English UI until the language was toggled by hand.
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    document.body.classList.toggle("font-arabic", locale === "ar");
    document.body.classList.toggle("font-english", locale === "en");
  }, [locale, mounted]);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "ar" ? "en" : "ar");
  }, [locale, setLocale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const entry = (DICTIONARY as any)[key];
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
  const isRTL = locale === "ar";
  const isEN = locale === "en";

  // Hidden until the stored locale is known, so Arabic never flashes before English.
  // The element tree is the same before and after mount (only the style changes):
  // swapping wrappers here used to remount the whole app once on load, discarding
  // component state and firing every query twice.
  return (
    <LocaleContext.Provider value={{ locale, setLocale, toggleLocale, t, dir, isRTL, isEN }}>
      <div style={mounted ? { display: "contents" } : { display: "contents", visibility: "hidden" }}>{children}</div>
    </LocaleContext.Provider>
  );
}