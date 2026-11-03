/* "old → new" reads the right way round in both languages: the arrow glyph does not mirror
   in right-to-left text, so Arabic needs "←" and English "→", and each value is isolated so
   a value in the other script cannot turn the pair around. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, changeArrow, changeText } from "../../lib/auditLabels";
import type { AuditLogDTO } from "../../lib/client-types";

const FSI = "⁨";
const PDI = "⁩";
const plain = (s: string | undefined) => (s ?? "").replace(/[⁦-⁩]/g, "");

const row = (action: string, extra: Partial<AuditLogDTO>) =>
  ({ id: "1", action, userName: "سارة", timestamp: new Date(2026, 0, 1).toISOString(), source: "user", reason: null, fieldChanged: null, oldValue: null, newValue: null, itemName: "طماطم", itemUnit: null, ...extra }) as unknown as AuditLogDTO;

test("the arrow points from the old value to the new one in the reader's direction", () => {
  assert.equal(changeArrow("en"), "→");
  assert.equal(changeArrow("ar"), "←");
});

test("each value is its own isolate, old first", () => {
  assert.equal(changeText("12.50", "15.00", "en"), `${FSI}12.50${PDI} → ${FSI}15.00${PDI}`);
  assert.equal(changeText("غائب", "حاضر", "ar"), `${FSI}غائب${PDI} ← ${FSI}حاضر${PDI}`);
});

test("timeline changes read old → new in English and old ← new in Arabic", () => {
  const price = row("order_line_price_overridden", { oldValue: "12.50", newValue: "15.00" });
  assert.equal(plain(buildTimeline([price], "en")[0].detail), "12.50 → 15.00");
  assert.equal(plain(buildTimeline([price], "ar")[0].detail), "12.50 ← 15.00");

  const edit = row("order_edited", { fieldChanged: "notes", oldValue: "a", newValue: "b" });
  assert.equal(plain(buildTimeline([edit], "en")[0].detail), "a → b");
  assert.equal(plain(buildTimeline([edit], "ar")[0].detail), "a ← b");

  const required = row("required_quantity_edited", { oldValue: "10", newValue: "12" });
  assert.equal(plain(buildTimeline([required], "en")[0].detail), "10 → 12");
  assert.equal(plain(buildTimeline([required], "ar")[0].detail), "10 ← 12");
});
