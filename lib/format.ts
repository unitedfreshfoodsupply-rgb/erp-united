/**
 * Presentation helpers shared by every operational screen, so the same value never
 * reads two different ways in two places.
 */

const AR_WEEKDAY = ["الأحد", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت"];
const AR_MONTH = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

function parseISODate(iso: string) {
  // Plain calendar date, parsed as such — going through the local timezone is what
  // makes a delivery date render as the day before for anyone ahead of UTC.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** "النهارده" / "بكرة" / "امبارح" / "الخميس ١١ سبتمبر" — a date an operator reads at a glance.
 * English: "Today" / "Tomorrow" / "Yesterday" / "Thu 11 Sep". */
export function friendlyDate(iso: string | null | undefined, now = new Date(), locale: "ar" | "en" = "ar"): string {
  const en = locale === "en";
  if (!iso) return en ? "No date" : "من غير تاريخ";
  const today = todayISO(now);
  if (iso === today) return en ? "Today" : "النهارده";
  const t = parseISODate(today);
  const d = parseISODate(iso);
  const diffDays = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (diffDays === 1) return en ? "Tomorrow" : "بكرة";
  if (diffDays === -1) return en ? "Yesterday" : "امبارح";
  if (en) return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${AR_WEEKDAY[d.getDay()]} ${d.getDate()} ${AR_MONTH[d.getMonth()]}`;
}

/** Delivery slot as one phrase: "النهارده ٠٨:٠٠" or "النهارده — من غير ميعاد" ("Today · 08:00"). */
export function deliverySlot(dateISO: string, time: string | null | undefined, locale: "ar" | "en" = "ar") {
  const day = friendlyDate(dateISO, undefined, locale);
  return time ? `${day} · ${time}` : `${day} · ${locale === "en" ? "no set time" : "من غير ميعاد محدد"}`;
}

/** Quantities: trim trailing zeros, never render "10.00 kg" or a bare "0.30000000004". */
export function qty(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

/** Quantity with its unit, wrapped so the bidi algorithm can't swap number and unit. */
export function qtyUnit(n: number | null | undefined, unit: string): string {
  return n === null || n === undefined ? "—" : `${qty(n)} ${unit}`;
}

/** The Intl locale for dates and numbers: "ar-EG" writes Arabic-Indic digits, which an
 * English screen must not show. */
export function intlLocale(locale?: string): string {
  return locale === "en" ? "en-GB" : "ar-EG";
}

/** "من ٣ دقايق" / "3 min ago" — relative time for "when did this last move". */
export function agoLabel(iso: string, now = Date.now(), locale: "ar" | "en" = "ar"): string {
  const en = locale === "en";
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return en ? "just now" : "دلوقتي";
  const mins = Math.round(secs / 60);
  if (mins < 60) return en ? `${mins} min ago` : `من ${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return en ? `${hours} h ago` : `من ${hours} ساعة`;
  const days = Math.round(hours / 24);
  if (en) return days === 1 ? "a day ago" : `${days} days ago`;
  return days === 1 ? "من يوم" : `من ${days} يوم`;
}

export function clockLabel(iso: string, locale: "ar" | "en" = "ar") {
  return new Date(iso).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit" });
}

export function dateTimeLabel(iso: string) {
  const d = new Date(iso);
  return `${friendlyDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)} ${clockLabel(iso)}`;
}

/** A value that may be missing, rendered as something meaningful instead of blank. */
export function orDash(v: string | number | null | undefined, fallback = "—") {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s === "" ? fallback : s;
}
