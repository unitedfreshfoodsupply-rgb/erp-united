import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToString } from "react-dom/server";
import { initialLocale, localeCookie, preferredLocale, readLocaleCookie } from "@/lib/locale/cookie";
import { activeLocale } from "@/lib/locale/active";
import { LocaleProvider, useLocale } from "@/lib/locale";

// The app's .tsx is compiled here with the classic JSX transform (tsconfig "jsx": "preserve"),
// which looks React up when a component renders.
(globalThis as { React?: unknown }).React = React;

test("the page language: the cookie when set, else the browser's first preferred language", () => {
  assert.equal(initialLocale("en", "ar-EG,ar;q=0.9"), "en");
  assert.equal(initialLocale("ar", "en-US,en;q=0.9"), "ar");
  assert.equal(initialLocale(undefined, "en-US,en;q=0.9,ar;q=0.8"), "en");
  assert.equal(initialLocale(undefined, "ar-EG,ar;q=0.9,en-US;q=0.8"), "ar");
  assert.equal(initialLocale("fr", "*"), "ar", "an unknown cookie or a wildcard header falls back to Arabic");
  assert.equal(initialLocale(null, null), "ar");
  assert.equal(preferredLocale("EN-gb"), "en");
});

test("the cookie line and reading it back from document.cookie", () => {
  assert.equal(localeCookie("en"), "u_locale=en; path=/; max-age=31536000; samesite=lax");
  assert.equal(readLocaleCookie("u_shell=tabs; u_locale=en; u_rail=0"), "en");
  assert.equal(readLocaleCookie("u_locale=ar"), "ar");
  assert.equal(readLocaleCookie("x_u_locale=en; u_shell=tabs"), null);
  assert.equal(readLocaleCookie("u_locale=xx"), null);
  assert.equal(readLocaleCookie(""), null);
});

function Probe() {
  const { t, dir } = useLocale();
  return createElement("p", { dir }, t("app.title"));
}

test("server render: shown at once (never hidden until hydration), in the cookie's language", () => {
  const en = renderToString(createElement(LocaleProvider, { initialLocale: "en", children: createElement(Probe) }));
  assert.ok(!/visibility/.test(en), en);
  assert.ok(en.includes('dir="ltr"') && en.includes("UNITED — Production &amp; Dispatch"), en);
  const ar = renderToString(createElement(LocaleProvider, { children: createElement(Probe) }));
  assert.ok(!/visibility/.test(ar), ar);
  assert.ok(ar.includes('dir="rtl"') && ar.includes("نظام التجهيز والتحميل"), ar);
  // The formatting locale is one module-wide value on the server: an English request must not
  // switch it for the Arabic requests rendered alongside it.
  assert.equal(activeLocale(), "ar");
});
