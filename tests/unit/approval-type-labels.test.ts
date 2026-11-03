/* Every approval type has a label in both languages: screens (approvals inbox, Command
   Center) show it by key, so a missing key showed the Arabic server label in English
   or a generic "Other" (maturity 2026-11). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_TYPES } from "@/lib/core/approvals";
import { DICTIONARY } from "@/lib/locale/dictionary";

test("every approval type has an Arabic and an English label", () => {
  const dict = DICTIONARY as Record<string, { ar: string; en: string } | undefined>;
  const missing = Object.keys(APPROVAL_TYPES).filter((k) => !dict[`approvals.type.${k}`]?.ar || !dict[`approvals.type.${k}`]?.en);
  assert.deepEqual(missing, []);
});
