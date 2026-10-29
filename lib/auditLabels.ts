import type { AuditLogDTO } from "@/lib/client-types";
import { STATUS_LABEL, STATUS_LABEL_EN } from "@/lib/orderPresentation";
import type { OrderStatus } from "@/lib/types";
import { qty, intlLocale, unitLabel } from "@/lib/format";

/**
 * Turning the audit trail into an operational story.
 *
 * The audit table records field-level changes, which is right for an audit trail and
 * wrong for a human reading "what happened to this order". "prepared_quantity_set:
 * oldValue 0 → newValue 10" is a database row; "أحمد جهّز ١٠ كجم مانجا" is what
 * actually happened. This module is the translation layer, and it is the only place
 * that decides how an event reads — in Arabic or English.
 *
 * The raw rows stay available for supervisors and admins — see the audit screen's
 * technical view — so nothing is lost, it just isn't the primary UI any more.
 */

export type TimelineLocale = "ar" | "en";

function statusLabel(v: string | null, locale: TimelineLocale) {
  const labels = locale === "en" ? STATUS_LABEL_EN : STATUS_LABEL;
  return v && v in labels ? labels[v as OrderStatus] : v ?? "?";
}

const FIELD_LABEL: Record<TimelineLocale, Record<string, string>> = {
  ar: {
    customerName: "اسم العميل",
    deliveryDate: "تاريخ التسليم",
    deliveryTime: "ميعاد التسليم",
    notes: "الملاحظات",
    vehicle: "العربية",
    driverName: "اسم السواق",
    crateCount: "عدد البرنيكة",
  },
  en: {
    customerName: "the customer name",
    deliveryDate: "the delivery date",
    deliveryTime: "the delivery time",
    notes: "the notes",
    vehicle: "the vehicle",
    driverName: "the driver name",
    crateCount: "the crate count",
  },
};

function fieldLabel(field: string | null, locale: TimelineLocale) {
  return field ? FIELD_LABEL[locale][field] ?? field : "—";
}

function withUnit(value: string | number | null, unit?: string | null) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  const shown = Number.isFinite(n) ? qty(n) : String(value);
  return unit ? `${shown} ${unitLabel(unit)}` : shown;
}

export type TimelineEvent = {
  id: string;
  icon: string;
  /** WHO did it. */
  actor: string;
  /** DID WHAT — the headline, in operational language. */
  headline: string;
  /** RESULT / detail — quantities, names, the consequence. Optional. */
  detail?: string;
  reason?: string | null;
  at: string;
  source: string;
  /** Visually separates the milestones (stage changes) from routine item work. */
  milestone: boolean;
};

type Describe = (l: AuditLogDTO, locale: TimelineLocale) => Omit<TimelineEvent, "id" | "actor" | "at" | "source">;

/** The same story in both languages: [Arabic, English]. */
const pick = (locale: TimelineLocale, ar: string, en: string) => (locale === "en" ? en : ar);

const STAGE_HEADLINE: Record<string, { icon: string; ar: string; en: string }> = {
  preparing: { icon: "🧰", ar: "بدأ التجهيز", en: "started preparation" },
  ready_for_loading: { icon: "📦", ar: "خلّص التجهيز — الأوردر جاهز للتحميل", en: "finished preparation — the order is ready for loading" },
  loading: { icon: "🚚", ar: "بدأ التحميل", en: "started loading" },
  loaded: { icon: "✅", ar: "خلّص التحميل", en: "finished loading" },
  dispatched: { icon: "🏁", ar: "أكّد خروج العربية", en: "confirmed the vehicle's dispatch" },
  cancelled: { icon: "🚫", ar: "لغى الأوردر", en: "cancelled the order" },
  new: { icon: "↩️", ar: "رجّع الأوردر لأول الخط", en: "sent the order back to the start" },
};

const item = (l: AuditLogDTO, locale: TimelineLocale) => l.itemName ?? pick(locale, "صنف", "an item");
const change = (l: AuditLogDTO) => `${l.oldValue || "—"} ← ${l.newValue || "—"}`;

const DESCRIBE: Record<string, Describe> = {
  order_created: (_, x) => ({ icon: "📥", headline: pick(x, "الأوردر وصل", "order received"), milestone: true }),

  status_changed: (l, x) => {
    const to = l.newValue ?? "";
    const meta = STAGE_HEADLINE[to];
    return {
      icon: meta?.icon ?? "🔄",
      headline: meta ? pick(x, meta.ar, meta.en) : pick(x, `نقل الأوردر لـ${statusLabel(l.newValue, x)}`, `moved the order to ${statusLabel(l.newValue, x)}`),
      detail: meta ? undefined : pick(x, `من ${statusLabel(l.oldValue, x)}`, `from ${statusLabel(l.oldValue, x)}`),
      milestone: true,
    };
  },

  status_override: (l, x) => ({
    icon: "⚠️",
    headline: pick(x, `غيّر مرحلة الأوردر يدويًا لـ${statusLabel(l.newValue, x)}`, `manually moved the order to ${statusLabel(l.newValue, x)}`),
    detail: pick(x, `كانت ${statusLabel(l.oldValue, x)} — تغيير خارج المسار العادي`, `was ${statusLabel(l.oldValue, x)} — a change outside the normal flow`),
    milestone: true,
  }),

  prepared_quantity_set: (l, x) => ({
    icon: "⚖️",
    headline: pick(x, `سجّل ${withUnit(l.newValue, l.itemUnit)} متجهّز`, `recorded ${withUnit(l.newValue, l.itemUnit)} prepared`),
    detail: l.itemName ?? undefined,
    milestone: false,
  }),

  item_marked_prepared: (l, x) => ({ icon: "✓", headline: pick(x, `خلّص تجهيز ${item(l, x)}`, `finished preparing ${item(l, x)}`), milestone: false }),

  loaded_quantity_set: (l, x) => ({
    icon: "⚖️",
    headline: pick(x, `سجّل ${withUnit(l.newValue, l.itemUnit)} متحمّل`, `recorded ${withUnit(l.newValue, l.itemUnit)} loaded`),
    detail: l.itemName ?? undefined,
    milestone: false,
  }),

  item_marked_loaded: (l, x) => ({ icon: "✓", headline: pick(x, `خلّص تحميل ${item(l, x)}`, `finished loading ${item(l, x)}`), milestone: false }),

  required_quantity_edited: (l, x) => ({
    icon: "✏️",
    headline: pick(x, `عدّل المطلوب من ${item(l, x)}`, `changed the required quantity of ${item(l, x)}`),
    detail: `${withUnit(l.oldValue, l.itemUnit)} ← ${withUnit(l.newValue, l.itemUnit)}`,
    milestone: false,
  }),

  shortage_approved: (_, x) => ({
    icon: "👍",
    headline: pick(x, "اعتمد الفرق وفكّ وقف الأوردر", "approved the difference and released the order"),
    detail: pick(x, "الأوردر يقدر يكمل بالكميات المسجلة", "the order can continue with the recorded quantities"),
    milestone: true,
  }),

  order_edited: (l, x) => ({ icon: "✏️", headline: pick(x, `عدّل ${fieldLabel(l.fieldChanged, x)}`, `changed ${fieldLabel(l.fieldChanged, x)}`), detail: change(l), milestone: false }),

  order_cloned: (l, x) => ({
    icon: "📋",
    headline: pick(x, "عمل نسخة من الأوردر", "copied the order"),
    detail: l.newValue ? pick(x, `الأوردر الجديد ${l.newValue}`, `new order ${l.newValue}`) : undefined,
    milestone: true,
  }),

  order_cancelled: (_, x) => ({ icon: "🚫", headline: pick(x, "لغى الأوردر", "cancelled the order"), milestone: true }),

  order_reopened: (l, x) => ({
    icon: "🔓",
    headline: pick(x, `فتح الأوردر تاني لمرحلة ${statusLabel(l.newValue, x)}`, `reopened the order to ${statusLabel(l.newValue, x)}`),
    detail: pick(x, "الأصناف اللي في المرحلة دي محتاجة تأكيد تاني", "items in this stage need confirming again"),
    milestone: true,
  }),

  order_assigned: (l, x) => ({
    icon: "👤",
    headline: l.newValue ? pick(x, `سلّم الأوردر لـ${l.newValue}`, `assigned the order to ${l.newValue}`) : pick(x, "شال التكليف من الأوردر", "removed the assignment from the order"),
    milestone: false,
  }),

  approval_requested: (_, x) => ({ icon: "⏳", headline: pick(x, "طلب اعتماد", "requested approval"), milestone: false }),
  approval_level_approved: (_, x) => ({ icon: "☑️", headline: pick(x, "وافق على مستوى من الاعتماد", "approved one approval level"), milestone: false }),
  approval_approved: (_, x) => ({ icon: "☑️", headline: pick(x, "وافق على طلب الاعتماد", "approved the approval request"), milestone: false }),
  approval_rejected: (_, x) => ({ icon: "✋", headline: pick(x, "رفض طلب الاعتماد", "rejected the approval request"), milestone: true }),
  approval_cancelled: (_, x) => ({ icon: "↩️", headline: pick(x, "طلب الاعتماد اتلغى", "the approval request was cancelled"), milestone: false }),

  stock_issue_exception_raised: (l, x) => ({ icon: "⚠️", headline: pick(x, "الكمية اللي خرجت أكتر من المسجل في المخزن", "more left than the stock records hold"), detail: l.newValue ?? undefined, milestone: false }),
  stock_issue_exception_resolved: (l, x) => ({ icon: "✅", headline: pick(x, "اتحلّ فرق المخزن", "the stock difference was resolved"), detail: l.newValue ?? undefined, milestone: false }),
  stock_issue_exception_voided: (_, x) => ({ icon: "↩️", headline: pick(x, "فرق المخزن اتلغى (الأوردر اتفتح تاني)", "the stock difference was voided (the order was reopened)"), milestone: false }),
  inventory_issue_posted: (l, x) => ({ icon: "📤", headline: pick(x, "البضاعة اتخصمت من المخزن", "the goods were issued from stock"), detail: l.newValue ?? undefined, milestone: false }),

  order_customer_mapped: (l, x) => ({ icon: "🔗", headline: pick(x, "ربط الأوردر بحساب العميل", "linked the order to the customer account"), detail: l.newValue ?? undefined, milestone: false }),
  order_product_mapped: (l, x) => ({ icon: "🔗", headline: pick(x, `ربط ${item(l, x)} بصنف المخزن`, `linked ${item(l, x)} to a stock product`), detail: l.newValue ?? undefined, milestone: false }),
  order_product_unmapped: (l, x) => ({ icon: "✂️", headline: pick(x, `فك ربط ${item(l, x)}`, `unlinked ${item(l, x)}`), milestone: false }),
  order_priced: (_, x) => ({ icon: "🏷️", headline: pick(x, "سعّر الأوردر من قائمة الأسعار", "priced the order from the price list"), milestone: false }),
  order_line_price_overridden: (l, x) => ({ icon: "🏷️", headline: pick(x, `غيّر سعر ${item(l, x)}`, `changed the price of ${item(l, x)}`), detail: l.oldValue || l.newValue ? change(l) : undefined, milestone: false }),
  order_credit_evaluated: (l, x) => ({ icon: "💳", headline: pick(x, "راجع حد ائتمان العميل", "checked the customer's credit limit"), detail: l.newValue ?? undefined, milestone: false }),
  attachment_added: (l, x) => ({ icon: "📎", headline: pick(x, "أضاف مرفق", "added an attachment"), detail: l.newValue ?? undefined, milestone: false }),
  attachment_removed: (l, x) => ({ icon: "📎", headline: pick(x, "شال مرفق", "removed an attachment"), detail: l.oldValue ?? undefined, milestone: false }),
};

/**
 * Dispatch writes one status row plus a row per manifest field. Shown raw that is four
 * consecutive lines for one physical event. They are folded into the dispatch entry.
 */
const MANIFEST_FIELDS = new Set(["vehicle", "driverName", "crateCount"]);

/** The order's story in `locale` (Arabic by default — the floor's language). */
export function buildTimeline(logs: AuditLogDTO[], locale: TimelineLocale = "ar"): TimelineEvent[] {
  // Server returns newest-first; the story reads oldest-first.
  const ordered = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const dispatchedHeadline = pick(locale, STAGE_HEADLINE.dispatched.ar, STAGE_HEADLINE.dispatched.en);

  const events: TimelineEvent[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const l = ordered[i];

    // Fold the manifest edits that accompany a dispatch into the dispatch event.
    if (l.action === "order_edited" && MANIFEST_FIELDS.has(l.fieldChanged ?? "")) {
      const previous = events[events.length - 1];
      if (previous && previous.headline === dispatchedHeadline) {
        const part =
          l.fieldChanged === "vehicle"
            ? pick(locale, `العربية ${l.newValue}`, `vehicle ${l.newValue}`)
            : l.fieldChanged === "driverName"
            ? pick(locale, `السواق ${l.newValue}`, `driver ${l.newValue}`)
            : pick(locale, `${l.newValue} برنيكة`, `${l.newValue} crates`);
        previous.detail = previous.detail ? `${previous.detail} · ${part}` : part;
        continue;
      }
    }

    const describe = DESCRIBE[l.action];
    const base = describe
      ? describe(l, locale)
      : { icon: "•", headline: pick(locale, "تحديث على الأوردر", "updated the order"), detail: l.newValue ?? undefined, milestone: false as boolean };

    events.push({
      id: l.id,
      actor: l.userName,
      at: l.timestamp,
      source: l.source,
      reason: l.reason,
      ...base,
    });
  }
  return events;
}

/** Latest meaningful activity, for "who touched this last and when" on a card. */
export function latestActivity(logs: AuditLogDTO[], locale: TimelineLocale = "ar"): TimelineEvent | null {
  const events = buildTimeline(logs, locale);
  return events.length ? events[events.length - 1] : null;
}

export const SOURCE_LABEL: Record<string, string> = {
  user: "مستخدم",
  manual: "يدوي",
  system: "نظام",
  n8n: "أوتوماتيك",
  hermes: "Hermes",
};

export const SOURCE_LABEL_EN: Record<string, string> = {
  user: "User",
  manual: "Manual",
  system: "System",
  n8n: "n8n",
  hermes: "Hermes",
};

export function timeLabel(iso: string, locale: TimelineLocale = "ar") {
  return new Date(iso).toLocaleString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}
