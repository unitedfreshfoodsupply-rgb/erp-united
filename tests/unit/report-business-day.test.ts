/* Timestamp reports filter and date by the Cairo business day, not the UTC one
   (lib/reports/business-day.ts) — across Egypt's 2026 clock changes (spring: Friday
   2026-04-24 starts at 01:00 UTC+3; autumn: Thursday 2026-10-29 lasts 25 hours). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { businessDate, businessDayRange } from "@/lib/reports/business-day";

const iso = (r: { gte: Date; lt: Date }) => [r.gte.toISOString(), r.lt.toISOString()];

test("a winter day runs from 22:00Z the day before to 22:00Z (UTC+2)", () => {
  assert.deepEqual(iso(businessDayRange("2026-11-03", "2026-11-03")), ["2026-11-02T22:00:00.000Z", "2026-11-03T22:00:00.000Z"]);
});

test("a summer day runs from 21:00Z the day before to 21:00Z (UTC+3)", () => {
  assert.deepEqual(iso(businessDayRange("2026-07-01", "2026-07-31")), ["2026-06-30T21:00:00.000Z", "2026-07-31T21:00:00.000Z"]);
});

test("clock changes: the spring Friday starts when the clocks jump; the autumn Thursday has 25 hours", () => {
  assert.deepEqual(iso(businessDayRange("2026-04-24", "2026-04-24")), ["2026-04-23T22:00:00.000Z", "2026-04-24T21:00:00.000Z"]);
  assert.deepEqual(iso(businessDayRange("2026-10-29", "2026-10-29")), ["2026-10-28T21:00:00.000Z", "2026-10-29T22:00:00.000Z"]);
});

test("a 01:30 Cairo approval (23:30Z the day before) is dated and filtered on its own Cairo day", () => {
  const at = new Date("2026-11-02T23:30:00Z");
  assert.equal(businessDate(at), "2026-11-03");
  const day = businessDayRange("2026-11-03", "2026-11-03");
  assert.ok(at >= day.gte && at < day.lt, "inside the 3 Nov filter");
  const before = businessDayRange("2026-11-02", "2026-11-02");
  assert.ok(!(at >= before.gte && at < before.lt), "and not in the 2 Nov one");
});
