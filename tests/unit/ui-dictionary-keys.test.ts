/* Every dictionary key a screen refers to must exist. scripts/check-dict-integrity.py checks
   literal t("…") calls; this catches the indirect ones it cannot see — keys kept in arrays
   and maps (dictKey: "…", labelKey="…", a ternary of two keys) — which otherwise render as the
   raw key on screen. Permission keys and other codes that merely look like keys are excluded
   by only considering literals whose first segment the dictionary itself uses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DICTIONARY } from "../../lib/locale/dictionary";
import { PERMISSION_DEFS } from "../../lib/permissions";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

test("every dictionary-shaped string in components/ and app/ exists in the dictionary", () => {
  const keys = new Set(Object.keys(DICTIONARY));
  const prefixes = new Set([...keys].map((k) => k.split(".")[0]));
  const perms = new Set<string>(PERMISSION_DEFS.map((p) => p.key));
  const missing: string[] = [];
  for (const f of [...files("components"), ...files("app")]) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/["'`]([a-z][a-z0-9]*(?:[_-][a-z0-9]+)*(?:\.[a-z0-9_-]+)+)["'`]/g)) {
      const k = m[1];
      if (keys.has(k) || perms.has(k) || !prefixes.has(k.split(".")[0])) continue;
      if (/\.(tsx?|js|css|png|svg|json|md|com)$/.test(k)) continue;
      missing.push(`${f}: ${k}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every literal t(\"…\") key exists, dotted or not", () => {
  const keys = new Set(Object.keys(DICTIONARY));
  const missing: string[] = [];
  for (const f of [...files("components"), ...files("app")]) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([^"$]+)"/g)) {
      if (!keys.has(m[1])) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
