import type { Locale } from "./context";
import { unitLabel } from "@/lib/format";

/**
 * Text the system generated and stored, shown in the reader's language.
 *
 * Journal descriptions, document references and reasons, notification and approval titles
 * and audit values are written once, in one language, when the event happens ("فاتورة
 * مبيعات INV-2026-00010", "2 employees · 0 blocking issues"). They are records and stay as
 * stored; this module only changes how they read on screen.
 *
 * Each entry is a pair of templates. `{}` is a value carried over unchanged (a document
 * number, a name, a date); `{n}` is a number. A text is matched whole, or — for the
 * " · "-joined summaries — part by part, and a slot that is itself a known phrase is
 * translated too. Anything that matches nothing (user-typed text, names) is shown as stored.
 * Server error messages are a different path: lib/locale/server-messages.ts.
 */

const PAIRS: readonly (readonly [ar: string, en: string])[] = [
  // Journal entries
  ["فاتورة مبيعات {}", "Sales invoice {}"],
  ["إشعار دائن {} على {}", "Credit note {} on {}"],
  ["فاتورة خدمة {} ({})", "Service bill {} ({})"],
  ["فاتورة مورد {} ({})", "Supplier bill {} ({})"],
  ["إشعار مدين {} على {}", "Debit note {} on {}"],
  ["تحصيل {} من {} ({})", "Receipt {} from {} ({})"],
  ["تحصيل {} من {}", "Receipt {} from {}"],
  ["سداد {} لـ {} ({})", "Payment {} to {} ({})"],
  ["سداد {} لـ {}", "Payment {} to {}"],
  ["عكس تحصيل {} من {}: {}", "Reversal of receipt {} from {}: {}"],
  ["عكس سداد {} لـ {}: {}", "Reversal of payment {} to {}: {}"],
  ["رد مبلغ {} لـ {}: {}", "Refund {} to {}: {}"],
  ["استرداد {} من {}: {}", "Refund {} from {}: {}"],
  ["رصيد افتتاحي — {} ({})", "Opening balance — {} ({})"],
  ["رصيد افتتاحي — {}", "Opening balance — {}"],
  ["عكس مسير مرتبات {}: {}", "Reversal of payroll run {}: {}"],
  ["عكس صرف مرتبات {}: {}", "Reversal of salary payment {}: {}"],
  ["عكس {}: {}", "Reversal of {}: {}"],
  ["مسير مرتبات {}", "Payroll run {}"],
  ["صرف مرتبات {}", "Salary payment {}"],
  ["استرداد سلف {}", "Advance recovery {}"],
  ["صرف تحت حساب مرتب {}", "Salary on account {}"],
  ["مصروف {}: {}", "Expense {}: {}"],
  ["سلفة — {}", "Advance — {}"],
  ["صرف مستحقات — {}", "Reimbursement — {}"],
  ["رد سلفة — {}", "Advance returned — {}"],
  ["صرف تحت حساب مرتب {} — {}", "Salary on account {} — {}"],
  ["قيمة مخزون — {}", "Inventory value — {}"],
  ["استلامات ومرتجعات موردين", "Supplier receipts and returns"],
  ["صرف ومرتجعات عملاء", "Customer issues and returns"],
  ["تسويات وهالك وتحويلات", "Adjustments, waste and transfers"],
  ["رصيد مخزون افتتاحي", "Opening stock"],
  ["الخصم من المنبع", "Withholding tax"],
  ["الخصم من المنبع ({})", "Withholding tax ({})"],
  ["مصاريف البنك", "Bank charges"],
  ["مصاريف البنك ({})", "Bank charges ({})"],
  ["فرق التحصيل", "Settlement difference"],
  ["فرق التحصيل ({})", "Settlement difference ({})"],
  // Stock movement kinds (in "قيمة مخزون — استلام RC-…")
  ["استلام {}", "goods receipt {}"],
  ["استلام", "goods receipt"],
  ["تصحيح استلام {}", "receipt correction {}"],
  ["إلغاء استلام {}", "receipt void {}"],
  ["تسوية {}", "adjustment {}"],
  ["تحويل {}", "transfer {}"],
  ["صرف لعميل {}", "issue to customer {}"],
  ["مرتجع عميل {}", "customer return {}"],
  ["مرتجع مورد {}", "supplier return {}"],
  ["فرز — خارج {}", "sorting out {}"],
  ["فرز — داخل {}", "sorting in {}"],
  ["إفراج محجوز — خارج {}", "quarantine release out {}"],
  ["إفراج محجوز — داخل {}", "quarantine release in {}"],
  // Documents, orders and reasons
  ["أوردر {}", "Order {}"],
  ["الأوردر اتلغى: {}", "Order cancelled: {}"],
  ["اتنسخ من {}", "Copied from {}"],
  ["إلغاء {}: {}", "Cancellation of {}: {}"],
  ["إلغاء {} — راجع اليوم", "Cancellation of {} — day returned"],
  ["إلغاء {}", "Cancellation of {}"],
  ["إلغاء أمر {}", "Cancelled order {}"],
  ["مرتجع على {}: {}", "Return on {}: {}"],
  ["أمر الشراء اتلغى: {}", "Purchase order cancelled: {}"],
  ["من عرض السعر {}", "From quotation {}"],
  ["من طلب عرض السعر {}", "From RFQ {}"],
  ["استحقاق {}", "due {}"],
  ["تعيين", "Hire"],
  ["(اتغيّرت)", "(changed)"],
  ["{}: اتجهز {} واتحمل {} {}", "{}: prepared {}, loaded {} {}"],
  ["{}: عجز {} عند العميل", "{}: {} short at the customer"],
  ["{}: عجز {} عند العميل — {}", "{}: {} short at the customer — {}"],
  ["{}: تالف {}", "{}: {} damaged"],
  ["{}: تالف {} — {}", "{}: {} damaged — {}"],
  ["{}: العميل رفض {} (رجعت المخزن)", "{}: customer rejected {} (back in stock)"],
  ["{}: العميل رفض {} (رجعت المخزن) — {}", "{}: customer rejected {} (back in stock) — {}"],
  ["{}: خرج {}، اتصرف من الدفاتر {}", "{}: {} went out, {} issued from the books"],
  ["تم تجاوز استثناء مكرر — {}: نقص {} (تم تسجيله قبل كده)", "Duplicate exception skipped — {}: {} short (already recorded)"],
  // Notifications and approvals
  ["{}: مطلوب {} {}، الفعلي {} (فرق {}%)", "{}: required {} {}, actual {} ({}% difference)"],
  ["مطلوب موافقتك: {}", "Your approval is needed: {}"],
  ["اتوافق على: {}", "Approved: {}"],
  ["اترفض: {}", "Rejected: {}"],
  ["اتوزّع عليك أوردر {}", "Order {} was assigned to you"],
  ["اتوزّع عليك: {}", "Assigned to you: {}"],
  ["أوردر {} لعميل عدّى حدود الائتمان", "Order {} for a customer over the credit limit"],
  ["ائتمان أوردر {}", "Order credit {}"],
  ["أوردر {} خرج وسطر مااتصرفوش بالكامل من المخزون", "Order {} left with a line not fully issued from stock"],
  ["أوردر {} خرج و{n} سطور مااتصرفوش بالكامل من المخزون", "Order {} left with {} lines not fully issued from stock"],
  ["صرف من دفعات منتهية الصلاحية — {}", "Issued from expired lots — {}"],
  ["أمر شراء {}", "Purchase order {}"],
  ["فاتورة {} — {} ({})", "Bill {} — {} ({})"],
  ["فاتورة خدمة {} — {} ({})", "Service bill {} — {} ({})"],
  ["فاتورة خدمة إجماليها {} — أكبر من حد الاعتماد {}", "Service bill of {} — above the approval limit {}"],
  ["الصنف مش متربط بدليل الأصناف", "Product not linked to the catalog"],
  ["وحدة السطر مش بتتحول لوحدة الصنف", "Line unit does not convert to the product unit"],
  ["الرصيد المسجل أقل من اللي خرج", "Recorded stock is less than what went out"],
  // Counts and states in " · " summaries
  ["{n} سطر", "{} lines"],
  ["{n} صف", "{} rows"],
  ["{n} سطر مربوط", "{} linked lines"],
  ["{n} أوردر", "{} orders"],
  ["{n} موظف", "{} employees"],
  ["{n} قسيمة", "{} payslips"],
  ["{n} جاهز", "{} ready"],
  ["{n} مشكلة مانعة", "{} blocking issues"],
  ["{n} جديد", "{} new"],
  ["{n} اتغير", "{} changed"],
  ["{n} متساب", "{} kept"],
  ["{n} ناقص", "{} incomplete"],
  ["{n} مش مربوط", "{} unmapped"],
  ["{n} موجود", "{} already"],
  ["{n} اتعين خلال الفترة", "{} joined during"],
  ["{n} من غير شريحة", "{} no tier"],
  ["{n} من غير تاريخ ميلاد", "{} missing birth date"],
  ["{n} يوم", "{} days"],
  ["{n} يوم رجعوا للرصيد", "{} days back to the register"],
  ["{n} بايت", "{} bytes"],
  ["من {}", "from {}"],
  ["اتلغى", "cancelled"],
  ["اتوقف", "retired"],
  ["اتأكد", "confirmed"],
  ["عكس", "reversal"],
  ["مسير مرتبات", "payroll_run"],
  ["صرف مرتبات", "payroll_payment"],
  ["توزيع بالتناسب", "proportional"],
  ["مفيش سعر", "missing_price"],
  ["موقوف", "inactive"],
  ["(افتراضية)", "(default)"],
  ["(موقوفة)", "(inactive)"],
  ["{n} محاولات غلط — مقفول {n} دقائق", "{} failed attempts — locked for {} minutes"],
  // Integration key scopes, stored as keys in audit values
  ["إنشاء أوردرات", "orders.create"],
  ["متابعة الحالة", "orders.status"],
  ["إرسال الحضور (جهاز)", "attendance.ingest"],
  // Values some audit rows store as identifiers (attendance, pay components)
  ["حضور", "present"],
  ["غياب", "absent"],
  ["غياب بدون أجر", "absent_unpaid"],
  ["إجازة", "leave"],
  ["إجازة رسمية", "holiday"],
  ["راحة", "rest_day"],
  ["إيقاف", "suspended"],
  ["بأثر رجعي", "retro"],
  ["نسخة {n}", "v{n}"],
  ["استحقاق", "earning"],
  ["استقطاع", "deduction"],
  ["حصة صاحب العمل", "employer_contribution"],
  ["معلومة بس", "information"],
  ["ثابت شهري", "fixed"],
  ["إدخال لمرة", "input"],
  ["محسوب", "system"],
  ["خاضع للضريبة: {}", "tax {}"],
  ["خاضع للتأمينات: {}", "SI {}"],
  ["نعم", "true"],
  ["لا", "false"],
  ["غير محدد", "?"],
];

type Rule = { re: RegExp; out: string; weight: number };

const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]{2,}/;
const MAX_DEPTH = 3;
const cache: Partial<Record<Locale, { exact: Map<string, string>; rules: Rule[] }>> = {};

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rules that read `from`-language text and write the other language. */
function rulesFor(target: Locale) {
  const hit = cache[target];
  if (hit) return hit;
  const exact = new Map<string, string>();
  const rules: Rule[] = [];
  for (const [ar, en] of PAIRS) {
    const [from, to] = target === "en" ? [ar, en] : [en, ar];
    if (!/\{n?\}/.test(from)) {
      exact.set(from, to.replace(/\{n\}/g, "{}"));
      continue;
    }
    const parts = from.split(/(\{n?\})/);
    const src = parts.map((p) => (p === "{}" ? "([\\s\\S]+?)" : p === "{n}" ? "(-?[\\d٠-٩][\\d٠-٩.,]*)" : escapeRe(p))).join("");
    rules.push({ re: new RegExp(`^${src}$`), out: to.replace(/\{n\}/g, "{}"), weight: from.replace(/\{n?\}/g, "").length });
  }
  rules.sort((a, b) => b.weight - a.weight);
  return (cache[target] = { exact, rules });
}

function needsWork(text: string, target: Locale) {
  return target === "en" ? ARABIC.test(text) : LATIN.test(text);
}

function translateOne(text: string, target: Locale, depth: number): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const { exact, rules } = rulesFor(target);
  const direct = exact.get(trimmed);
  if (direct !== undefined) return direct;
  if (depth >= MAX_DEPTH) return null;
  for (const r of rules) {
    const m = r.re.exec(trimmed);
    if (!m) continue;
    const slots = m.slice(1).map((v) => translateOne(v, target, depth + 1) ?? v);
    let i = 0;
    return r.out.replace(/\{\}/g, () => slots[i++] ?? "");
  }
  return null;
}

/** Identifiers some rows store (`payroll_run`, `absent_unpaid`) read as words in English. */
let identifiers: Set<string> | null = null;
const ENGLISH_KEYS: Record<string, string> = { "orders.create": "Create orders", "orders.status": "Track status", "attendance.ingest": "Send attendance (device)" };
function englishIdentifier(seg: string): string | null {
  const key = ENGLISH_KEYS[seg.trim()];
  if (key) return seg.replace(seg.trim(), key);
  identifiers ??= new Set(PAIRS.map(([, en]) => en).filter((en) => /^[a-z]+(?:_[a-z]+)*$/.test(en)));
  const t = seg.trim();
  if (!identifiers.has(t)) return null;
  const words = t.replace(/_/g, " ");
  return seg.replace(t, words.charAt(0).toUpperCase() + words.slice(1));
}

/** A unit code after a number ("2 KG") reads as the reader's unit word ("2 كجم", "2 kg"). */
const UNIT_AFTER_NUMBER = /(\d)\s(KG|G|TON|L|ML|PIECE|PCS?|BOX|CARTON|CRATE|DOZEN|BUNCH|PALLET)\b/g;

/** `text` as the reader of `locale` should see it; unknown text is returned as stored. */
export function systemText(text: string | null | undefined, locale: Locale): string {
  const out = translate(text, locale);
  return out.replace(UNIT_AFTER_NUMBER, (_, d: string, u: string) => `${d} ${unitLabel(u, locale)}`);
}

function translate(text: string | null | undefined, locale: Locale): string {
  if (!text) return text ?? "";
  if (locale === "en" && !ARABIC.test(text)) {
    if (!/[a-z][_.]?[a-z]/.test(text)) return text;
    return text.split(" · ").map((seg) => englishIdentifier(seg) ?? seg).join(" · ");
  }
  if (!needsWork(text, locale)) return text;
  // Summaries are " · "-joined parts, each read on its own (no template spans a " · ").
  if (!text.includes(" · ")) return translateOne(text, locale, 0) ?? text;
  return text
    .split(" · ")
    .map((seg) => translateOne(seg, locale, 0) ?? (locale === "en" ? englishIdentifier(seg) : null) ?? seg)
    .join(" · ");
}
