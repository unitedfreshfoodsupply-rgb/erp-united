/* Settings registry: validation and defaults. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OPERATIONAL_SETTINGS,
  SETTING_CHOICES,
  SETTING_DEFS,
  SETTING_KEYS,
  isSettingKey,
  parseSettingValue,
  settingValueText,
} from "@/lib/core/settings-registry";

test("every setting's default passes its own schema", () => {
  for (const key of SETTING_KEYS) {
    const r = parseSettingValue(key, SETTING_DEFS[key].default);
    assert.equal(r.ok, true, key);
  }
});

test("keys are dotted lower-case identifiers (the DB CHECK enforces the same)", () => {
  for (const key of SETTING_KEYS) assert.match(key, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
});

test("validation rejects out-of-range, wrong-type and fractional minutes", () => {
  assert.equal(parseSettingValue("orders.shortage_review_threshold_pct", 101).ok, false);
  assert.equal(parseSettingValue("orders.shortage_review_threshold_pct", -0.1).ok, false);
  assert.equal(parseSettingValue("orders.shortage_review_threshold_pct", "5").ok, false);
  assert.equal(parseSettingValue("orders.shortage_review_threshold_pct", 2.5).ok, true, "a percentage may be fractional");
  assert.equal(parseSettingValue("orders.stalled_minutes", 30.5).ok, false);
  assert.equal(parseSettingValue("orders.stalled_minutes", 0).ok, false);
  const bad = parseSettingValue("orders.stalled_minutes", 99999);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.error.length > 0, "error message is human-readable");
});

test("unknown keys are not settings, including prototype names", () => {
  assert.equal(isSettingKey("orders.nope"), false);
  assert.equal(isSettingKey("constructor"), false);
  assert.equal(isSettingKey("__proto__"), false);
  assert.equal(isSettingKey(42), false);
  assert.equal(isSettingKey("orders.stalled_minutes"), true);
});

test("operational defaults mirror the registry", () => {
  assert.equal(DEFAULT_OPERATIONAL_SETTINGS.shortageReviewThresholdPct, 5);
  assert.equal(DEFAULT_OPERATIONAL_SETTINGS.waitingToStartMinutes, 20);
  assert.equal(DEFAULT_OPERATIONAL_SETTINGS.stalledMinutes, 45);
  assert.equal(DEFAULT_OPERATIONAL_SETTINGS.deliverySoonMinutes, 60);
});

test("every choice setting has words for each of its values, in both languages", () => {
  for (const key of SETTING_KEYS) {
    const schema = SETTING_DEFS[key].schema as unknown as { _def?: { typeName?: string }; options?: string[] };
    if (schema._def?.typeName !== "ZodEnum") continue;
    const choices = SETTING_CHOICES[key];
    assert.ok(choices, `${key} has SETTING_CHOICES`);
    assert.deepEqual(Object.keys(choices!).sort(), [...schema.options!].sort(), key);
    for (const value of schema.options!) {
      assert.notEqual(settingValueText(key, JSON.stringify(value), "en"), value, `${key}=${value} is shown in words (en)`);
      assert.notEqual(settingValueText(key, JSON.stringify(value), "ar"), value, `${key}=${value} is shown in words (ar)`);
    }
  }
  assert.equal(settingValueText("hr.payroll_absent_policy", JSON.stringify("deduct"), "en"), "Deduct");
});
