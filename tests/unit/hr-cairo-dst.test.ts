/* Cairo wall-clock time → instant across Egypt's 2026 clock changes (tz database):
   - spring: Thursday 2026-04-23 24:00 → Friday 2026-04-24 01:00 (UTC+2 → UTC+3); 00:00–00:59 never happen;
   - autumn: Thursday 2026-10-29 24:00 → 23:00 (UTC+3 → UTC+2); 23:00–23:59 happen twice.
   The rules under test are documented on cairoCandidates / cairoInstant / cairoClockTime. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NonexistentLocalTime, cairoCandidates, cairoClockTime, cairoInstant, measureDay, minutesFromLocalMidnight, shiftMinutes } from "@/lib/hr/attendance-calc";

const iso = (d: Date) => d.toISOString();

test("an ordinary minute has one instant (summer UTC+3, winter UTC+2)", () => {
  assert.deepEqual(cairoCandidates("2026-07-01", "09:00").instants.map(iso), ["2026-07-01T06:00:00.000Z"]);
  assert.deepEqual(cairoCandidates("2026-01-15", "09:00").instants.map(iso), ["2026-01-15T07:00:00.000Z"]);
});

test("autumn 2026-10-29: 23:30 is shown twice — first at UTC+3, then at UTC+2", () => {
  const c = cairoCandidates("2026-10-29", "23:30");
  assert.deepEqual(c.instants.map(iso), ["2026-10-29T20:30:00.000Z", "2026-10-29T21:30:00.000Z"]);
  assert.equal(c.gap, null);
  // Just before and after the doubled hour: single instants.
  assert.deepEqual(cairoCandidates("2026-10-29", "22:59").instants.map(iso), ["2026-10-29T19:59:00.000Z"]);
  assert.deepEqual(cairoCandidates("2026-10-30", "00:00").instants.map(iso), ["2026-10-29T22:00:00.000Z"]);
});

test("autumn: cairoInstant and a first-in take the first occurrence", () => {
  assert.equal(iso(cairoInstant("2026-10-29", "23:00")), "2026-10-29T20:00:00.000Z");
  assert.equal(iso(cairoClockTime("2026-10-29", "23:00")), "2026-10-29T20:00:00.000Z");
});

test("autumn: a last-out takes the first occurrence after the first-in (shortest shift)", () => {
  const firstIn = cairoClockTime("2026-10-29", "09:30");
  assert.equal(iso(firstIn), "2026-10-29T06:30:00.000Z");
  const lastOut = cairoClockTime("2026-10-29", "23:00", 0, firstIn);
  assert.equal(iso(lastOut), "2026-10-29T20:00:00.000Z");
  // The attendance suite's day (09:30–23:00, schedule 09:00–17:00, 1 h break, night window 22:00–06:00):
  const m = measureDay({
    ...shiftMinutes("2026-10-29", firstIn, lastOut),
    schedule: { isWorkingDay: true, start: "09:00", end: "17:00", breakMinutes: 60, nightStart: "22:00", nightEnd: "06:00" }, holiday: false,
  });
  assert.equal(m.workedMinutes, 750);
  assert.equal(m.overtimeNightMinutes, 60);
  assert.equal(m.overtimeDayMinutes, 300);
  assert.equal(m.lateMinutes, 30);
});

test("autumn: a first-in in the second 23:xx — the last-out uses the later occurrence when the earlier is not after it", () => {
  const firstIn = new Date("2026-10-29T21:05:00.000Z"); // 23:05, second time round (UTC+2)
  assert.equal(iso(cairoClockTime("2026-10-29", "23:40", 0, firstIn)), "2026-10-29T21:40:00.000Z");
});

test("spring 2026-04-24: 00:00–00:59 never happen", () => {
  const c = cairoCandidates("2026-04-24", "00:30");
  assert.deepEqual(c.instants, []);
  // The jump: 00:30 read with the offset before the change (UTC+2) = 22:30Z = 01:30 local.
  assert.equal(iso(c.gap!), "2026-04-23T22:30:00.000Z");
  assert.deepEqual(cairoCandidates("2026-04-24", "01:00").instants.map(iso), ["2026-04-23T22:00:00.000Z"]);
  assert.deepEqual(cairoCandidates("2026-04-23", "23:59").instants.map(iso), ["2026-04-23T21:59:00.000Z"]);
});

test("spring: a typed clock time that never existed is refused, also as a next-morning last-out", () => {
  assert.throws(() => cairoClockTime("2026-04-24", "00:15"), NonexistentLocalTime);
  const firstIn = cairoClockTime("2026-04-23", "22:00");
  assert.throws(() => cairoClockTime("2026-04-23", "00:30", 1, firstIn), (e: unknown) => e instanceof NonexistentLocalTime && e.date === "2026-04-24" && e.time === "00:30");
  // 01:10 next morning exists: 22:00 (UTC+2) → 01:10 (UTC+3) is 2 h 10 min.
  const out = cairoClockTime("2026-04-23", "01:10", 1, firstIn);
  assert.equal((out.getTime() - firstIn.getTime()) / 60000, 130);
});

test("spring: the day's start (cairoInstant 00:00) is the first real minute, 01:00 local", () => {
  assert.equal(iso(cairoInstant("2026-04-24", "00:00")), "2026-04-23T22:00:00.000Z");
  assert.equal(iso(cairoInstant("2026-04-23", "00:00", 1)), "2026-04-23T22:00:00.000Z");
  // 08:00 on the short day is 7 elapsed hours after its start.
  assert.equal(minutesFromLocalMidnight("2026-04-24", cairoClockTime("2026-04-24", "08:00")), 7 * 60);
});

test("a shift on a clock-change day: the schedule sees the clock at arrival, the worked time is real time", () => {
  const sched = { isWorkingDay: true, start: "09:00", end: "17:00", breakMinutes: 0, nightStart: null, nightEnd: null };
  // Spring Friday: 09:00–17:00 on the clock is 8 real hours, on time, no overtime.
  const fi = cairoClockTime("2026-04-24", "09:00"), lo = cairoClockTime("2026-04-24", "17:00", 0, fi);
  assert.deepEqual(shiftMinutes("2026-04-24", fi, lo), { inMin: 540, outMin: 1020 });
  const m = measureDay({ ...shiftMinutes("2026-04-24", fi, lo), schedule: sched, holiday: false });
  assert.equal(m.workedMinutes, 480);
  assert.equal(m.lateMinutes, 0);
  assert.equal(m.overtimeDayMinutes, 0);
  // A night shift through the spring jump: 22:00 → 06:00 on the clock is 7 real hours.
  const ni = cairoClockTime("2026-04-23", "22:00"), no = cairoClockTime("2026-04-23", "06:00", 1, ni);
  assert.equal(shiftMinutes("2026-04-23", ni, no).outMin - shiftMinutes("2026-04-23", ni, no).inMin, 420);
  // A night shift through the autumn jump: 22:00 → 06:00 on the clock is 9 real hours.
  const ai = cairoClockTime("2026-10-29", "22:00"), ao = cairoClockTime("2026-10-29", "06:00", 1, ai);
  assert.equal(shiftMinutes("2026-10-29", ai, ao).outMin - shiftMinutes("2026-10-29", ai, ao).inMin, 540);
});
