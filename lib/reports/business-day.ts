import { todayLocalISO } from "@/lib/localDate";
import { cairoInstant } from "@/lib/hr/attendance-calc";

/**
 * A report period over a timestamp column, in the business's own calendar day (Cairo,
 * DST-correct — see lib/localDate.ts): from local midnight of `from` up to, not including,
 * local midnight after `to`. UTC boundaries would date a 01:30 approval to the day before
 * and leave it out of a filter on its own day.
 */
export function businessDayRange(from: string, to: string) {
  return { gte: cairoInstant(from, "00:00"), lt: cairoInstant(to, "00:00", 1) };
}

/** The business day (YYYY-MM-DD, Cairo) a timestamp falls on — how a report row dates it. */
export const businessDate = (at: Date) => todayLocalISO(at);
