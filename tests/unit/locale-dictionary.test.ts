import { test } from "node:test";
import assert from "node:assert/strict";
import { DICTIONARY } from "@/lib/locale/dictionary";

const entries = Object.entries(DICTIONARY as Record<string, { ar: unknown; en: unknown }>);
const ARABIC = /[؀-ۿ]/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every dictionary entry has string Arabic and English text", () => {
  for (const [key, entry] of entries) {
    assert.equal(typeof entry.ar, "string", `${key}.ar`);
    assert.equal(typeof entry.en, "string", `${key}.en`);
    // Empty is allowed only when both sides are deliberately empty (a suffix slot).
    assert.equal((entry.ar as string) === "", (entry.en as string) === "", `${key}: one side is empty`);
  }
});

test("no generated placeholder translations (e.g. \"مورد empty\" / \"Supplier Empty\")", () => {
  for (const [key, entry] of entries) {
    const ar = entry.ar as string;
    assert.ok(!(ARABIC.test(ar) && /[؀-ۿ]+ [a-z]{2,}( [a-z]+)*$/.test(ar)), `${key}: ar looks generated: ${ar}`);
    const tail = key.split(/[.\-_]/).slice(1).join(" ").toLowerCase();
    assert.ok(!(/^[a-z]+( [a-z]+)*$/.test(ar) && tail.includes(ar)), `${key}: ar is the key's own words: ${ar}`);
  }
});

test("Arabic and English use the same {placeholders}, and none uses {{double}} braces", () => {
  for (const [key, entry] of entries) {
    const ar = entry.ar as string;
    const en = entry.en as string;
    assert.ok(!/\{\{/.test(ar) && !/\{\{/.test(en), `${key}: {{ }} is not interpolated`);
    assert.deepEqual(placeholders(en), placeholders(ar), `${key}: placeholder mismatch`);
  }
});

test("keys used through lookup tables exist (import statuses, location types, supplier names)", () => {
  for (const key of [
    "admin.data-import.status.done",
    "admin.data-import.status.failed",
    "admin.data-import.status.exists",
    "admin.data-import.status.opening-stock",
    "admin.data-import.help.names",
    "purchasing.supplier.form.name_ar",
    "admin.toggle-btn.activate",
    "admin.toggle-btn.deactivate",
    "sales.customer.nameAr",
  ]) {
    assert.ok(key in DICTIONARY, key);
  }
  // The duplicate placeholder that used to override this label is gone.
  assert.equal((DICTIONARY as Record<string, { ar: string }>)["sales.customer.nameAr"].ar, "الاسم بالعربي");
});
