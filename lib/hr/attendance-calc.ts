/**
 * Attendance measurement — pure functions, no database (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.4).
 *
 * Turns a day's first-in / last-out and the employee's schedule into minutes: worked, late,
 * left early, and minutes outside the schedule per class (day, night, rest day, holiday).
 * These are measurements only. Whether outside minutes are paid as overtime, need prior
 * approval, and at what multiplier is policy and statute (decisions P7, §7) applied by payroll.
 *
 * Conventions (the same for every employee, documented so payroll can rely on them):
 *  - Times are Cairo local "HH:MM"; a last-out earlier than the first-in is the next day.
 *  - On a working day the scheduled break is deducted from the time present, once.
 *  - On a rest day or a public holiday every minute present is outside the schedule.
 *  - Night minutes are those inside the schedule's night window, when the company has one.
 */

const BUSINESS_TZ = "Africa/Cairo";

export type ScheduleDay = {
  isWorkingDay: boolean;
  start: string | null;
  end: string | null;
  breakMinutes: number;
  nightStart: string | null;
  nightEnd: string | null;
};

export type DayMinutes = {
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeDayMinutes: number;
  overtimeNightMinutes: number;
  overtimeRestDayMinutes: number;
  overtimeHolidayMinutes: number;
};

export const ZERO_MINUTES: DayMinutes = {
  workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0,
  overtimeDayMinutes: 0, overtimeNightMinutes: 0, overtimeRestDayMinutes: 0, overtimeHolidayMinutes: 0,
};

/** "HH:MM" → minutes after midnight. */
export function hhmm(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Scheduled working minutes of a day (0 for a rest day). */
export function scheduledMinutes(d: ScheduleDay | null) {
  if (!d || !d.isWorkingDay || !d.start || !d.end) return 0;
  let end = hhmm(d.end);
  const start = hhmm(d.start);
  if (end <= start) end += 1440;
  return Math.max(0, end - start - d.breakMinutes);
}

function overlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Minutes of [from, to) (minutes after the day's midnight, may pass 1440) inside the night window. */
function nightOverlap(from: number, to: number, d: ScheduleDay | null) {
  if (!d?.nightStart || !d.nightEnd || to <= from) return 0;
  const ns = hhmm(d.nightStart);
  let ne = hhmm(d.nightEnd);
  if (ne <= ns) ne += 1440;
  let total = 0;
  // The window of the previous evening reaches into this morning; the next one into tomorrow.
  for (const k of [-1, 0, 1]) total += overlap(from, to, ns + k * 1440, ne + k * 1440);
  return total;
}

/**
 * Measures one day. `inMin` / `outMin` are minutes after local midnight of the day
 * (outMin may exceed 1440 for a shift that ends after midnight).
 */
export function measureDay(input: { inMin: number; outMin: number; schedule: ScheduleDay | null; holiday: boolean }): DayMinutes {
  const { inMin, schedule, holiday } = input;
  const outMin = Math.max(input.outMin, inMin);
  const span = outMin - inMin;
  if (holiday) return { ...ZERO_MINUTES, workedMinutes: span, overtimeHolidayMinutes: span };
  if (!schedule) return { ...ZERO_MINUTES, workedMinutes: span };
  if (!schedule.isWorkingDay || !schedule.start || !schedule.end) {
    return { ...ZERO_MINUTES, workedMinutes: span, overtimeRestDayMinutes: span };
  }
  const start = hhmm(schedule.start);
  let end = hhmm(schedule.end);
  if (end <= start) end += 1440;
  const worked = span > schedule.breakMinutes ? span - schedule.breakMinutes : span;
  const late = Math.min(Math.max(0, inMin - start), end - start);
  const early = Math.min(Math.max(0, end - outMin), end - start);
  // Outside the scheduled window: before the start and after the end.
  const before: [number, number] = [inMin, Math.min(outMin, start)];
  const after: [number, number] = [Math.max(inMin, end), outMin];
  const outside = Math.max(0, before[1] - before[0]) + Math.max(0, after[1] - after[0]);
  const night = nightOverlap(before[0], before[1], schedule) + nightOverlap(after[0], after[1], schedule);
  return {
    ...ZERO_MINUTES,
    workedMinutes: worked,
    lateMinutes: late,
    earlyLeaveMinutes: early,
    overtimeNightMinutes: night,
    overtimeDayMinutes: outside - night,
  };
}

// ---------------------------------------------------------------------------
// Cairo local time ↔ instants
// ---------------------------------------------------------------------------

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function localParts(d: Date) {
  const p = Object.fromEntries(partsFormatter.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The Cairo calendar day and minute of an instant. */
export function cairoLocal(d: Date) {
  return localParts(d);
}

/** The instant of a Cairo local date and "HH:MM" (DST-correct: Egypt's offset changes twice a year). */
export function cairoInstant(date: string, time: string, addDays = 0): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d + addDays, h, mi);
  // Guess with the offset at the wall time read as UTC, then correct once.
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const lp = localParts(new Date(guess));
    const [ly, lm, ld] = lp.date.split("-").map(Number);
    const seenAsUtc = Date.UTC(ly, lm - 1, ld, Math.floor(lp.minutes / 60), lp.minutes % 60);
    guess += wall - seenAsUtc;
  }
  return new Date(guess);
}

/** Minutes after local midnight of `date` for an instant (can be negative or exceed 1440). */
export function minutesFromLocalMidnight(date: string, at: Date) {
  return Math.round((at.getTime() - cairoInstant(date, "00:00").getTime()) / 60000);
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD calendar date. */
export function weekdayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Every YYYY-MM-DD from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string) {
  const out: string[] = [];
  const [y, m, d] = from.split("-").map(Number);
  for (let t = Date.UTC(y, m - 1, d); ; t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (iso > to) break;
    out.push(iso);
  }
  return out;
}
