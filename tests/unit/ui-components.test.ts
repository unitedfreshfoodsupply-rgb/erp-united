import { test } from "node:test";
import assert from "node:assert/strict";
import { initialsOf } from "@/components/ui/Avatar";
import { niceTicks } from "@/components/charts/Charts";
import { readFileSync } from "node:fs";
import { HOME_PERMISSIONS } from "@/lib/nav";

test("avatar initials: first and last word, Latin upper-cased", () => {
  assert.equal(initialsOf("Mona Adel"), "MA");
  assert.equal(initialsOf("  karim  fouad  hassan "), "KH");
  assert.equal(initialsOf("admin"), "A");
  assert.equal(initialsOf(""), "?");
});

test("avatar initials: Arabic letters stay apart (zero-width non-joiner between them)", () => {
  assert.equal(initialsOf("أحمد علي"), "أ‌ع");
  assert.equal(initialsOf("سارة"), "س");
});

test("chart ticks: zero, round steps, top covers the maximum", () => {
  assert.deepEqual(niceTicks(0), [0]);
  assert.deepEqual(niceTicks(80_000), [0, 20_000, 40_000, 60_000, 80_000]);
  const t = niceTicks(6_350);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 6_350);
  assert.ok(t.length >= 3 && t.length <= 6, String(t));
  const step = t[1] - t[0];
  assert.ok(t.every((v, i) => v === i * step));
});

test("home API gate lists exactly the home page's permissions", () => {
  const src = readFileSync("app/api/home/route.ts", "utf8");
  const listed = [...src.matchAll(/"([a-z]+(?:\.[a-z_]+)+)"/g)].map((m) => m[1]).filter((k) => !k.startsWith("next/"));
  assert.deepEqual([...listed].sort(), [...HOME_PERMISSIONS].sort());
});
