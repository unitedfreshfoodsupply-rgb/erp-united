/**
 * Business-date validation. Delivery and receipt dates are stored as plain
 * "YYYY-MM-DD" strings (the operator's calendar day, no timezone), so they are
 * checked as strings — never round-tripped through `new Date()`, which parses a
 * date-only string as UTC and can shift it a day.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A real calendar day in YYYY-MM-DD — rejects "2026-02-30" and "2026-9-1". */
export function isValidISODate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/**
 * A real calendar date for people's records (birth date, hire date, contract dates):
 * isValidISODate is for business documents and refuses anything before 2000.
 */
export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** 24-hour "HH:mm". */
export function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && HH_MM.test(value);
}
