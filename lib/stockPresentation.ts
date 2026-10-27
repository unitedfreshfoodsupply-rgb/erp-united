import type { MovementKind } from "@/lib/stock-service";
import { DICTIONARY } from "@/lib/locale";

/** Weights read as plain Latin digits with at most 3 decimals and no trailing zeros —
 * "12.5 كجم", not "12.500". Grouping stays off so a tablet's narrow columns don't wrap. */
export function fmtKg(n: number) {
  const rounded = Math.round(n * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function fmtSignedKg(n: number) {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtKg(Math.abs(n))}`;
}

export function fmtYield(pct: number | null) {
  return pct === null ? "—" : `${pct}%`;
}

/** Yield tone thresholds are presentational only — they colour a number the operator
 * already sees, and never gate or change any stored value. */
export function yieldTone(pct: number | null): "good" | "warn" | "bad" | "none" {
  if (pct === null) return "none";
  if (pct >= 90) return "good";
  if (pct >= 75) return "warn";
  return "bad";
}

export const YIELD_TONE_CLASS: Record<"good" | "warn" | "bad" | "none", string> = {
  good: "text-united-green",
  warn: "text-united-warn",
  bad: "text-united-danger",
  none: "text-united-muted",
};

// ── Movement labels (bilingual via DICTIONARY stock.movement.* keys) ──────────────

export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  intake: "استلام",
  intake_correction: "تصحيح استلام",
  intake_void: "إلغاء استلام",
  adjustment: "تسوية يدوية",
  transfer_out: "تحويل (خروج)",
  transfer_in: "تحويل (دخول)",
  issue: "صرف",
  customer_return: "مرتجع من عميل",
  supplier_return: "مرتجع لمورد",
  scrap: "تالف / إعدام",
  sorting_out: "فرز (خروج)",
  sorting_in: "فرز (دخول)",
  release_out: "إفراج محجوز (خروج)",
  release_in: "إفراج محجوز (دخول)",
};

export const MOVEMENT_LABEL_EN: Record<MovementKind, string> = {
  intake: DICTIONARY["stock.movement.intake"].en,
  intake_correction: DICTIONARY["stock.movement.intake_correction"].en,
  intake_void: DICTIONARY["stock.movement.intake_void"].en,
  adjustment: DICTIONARY["stock.movement.adjustment"].en,
  transfer_out: DICTIONARY["stock.movement.transfer_out"].en,
  transfer_in: DICTIONARY["stock.movement.transfer_in"].en,
  issue: DICTIONARY["stock.movement.issue"].en,
  customer_return: DICTIONARY["stock.movement.customer_return"].en,
  supplier_return: DICTIONARY["stock.movement.supplier_return"].en,
  scrap: DICTIONARY["stock.movement.scrap"].en,
  sorting_out: DICTIONARY["stock.movement.sorting_out"].en,
  sorting_in: DICTIONARY["stock.movement.sorting_in"].en,
  release_out: DICTIONARY["stock.movement.release_out"].en,
  release_in: DICTIONARY["stock.movement.release_in"].en,
};

export const MOVEMENT_ICON: Record<MovementKind, string> = {
  intake: "📥",
  intake_correction: "✏️",
  intake_void: "↩️",
  adjustment: "⚖️",
  transfer_out: "➡️",
  transfer_in: "⬅️",
  issue: "🚚",
  customer_return: "🔙",
  supplier_return: "📤",
  scrap: "🗑️",
  sorting_out: "🔀",
  sorting_in: "🔀",
  release_out: "🔓",
  release_in: "🔓",
};

// ── Stock audit labels (bilingual via DICTIONARY stock.audit.* keys) ──────────────

export const STOCK_AUDIT_LABEL: Record<string, string> = {
  supplier_created: "إضافة مورد",
  supplier_updated: "تعديل مورد",
  stock_product_created: "إضافة صنف",
  stock_product_updated: "تعديل صنف",
  product_created: "إضافة صنف للدليل",
  product_updated: "تعديل بيانات صنف",
  product_activated: "تفعيل صنف",
  product_deactivated: "إيقاف صنف",
  product_alias_added: "إضافة اسم بديل",
  product_alias_removed: "حذف اسم بديل",
  order_product_mapped: "ربط اسم أوردر بصنف",
  order_product_unmapped: "فك ربط اسم أوردر",
  stock_intake_created: "تسجيل استلام",
  stock_intake_updated: "تعديل استلام",
  stock_intake_voided: "إلغاء استلام",
  stock_adjustment_created: "تسوية مخزون",
  inventory_adjustment_requested: "تسوية مستنية موافقة",
  inventory_adjustment_rejected: "تسوية اترفضت",
  inventory_transfer_posted: "تحويل بين أماكن",
  inventory_scrap_posted: "تالف / إعدام",
  inventory_customer_return_posted: "مرتجع من عميل",
  inventory_supplier_return_posted: "مرتجع لمورد",
  inventory_issue_posted: "صرف مخزون",
  inventory_document_reversed: "إلغاء مستند مخزون",
  stock_reserved: "حجز مخزون",
  stock_reservation_released: "فك حجز",
  product_packaging_saved: "تعبئة صنف",
  stock_lot_updated: "تعديل دفعة",
};

export const STOCK_AUDIT_LABEL_EN: Record<string, string> = {
  supplier_created: DICTIONARY["stock.audit.supplier_created"].en,
  supplier_updated: DICTIONARY["stock.audit.supplier_updated"].en,
  product_created: DICTIONARY["stock.audit.product_created"].en,
  product_updated: DICTIONARY["stock.audit.product_updated"].en,
  product_activated: DICTIONARY["stock.audit.product_activated"].en,
  product_deactivated: DICTIONARY["stock.audit.product_deactivated"].en,
  product_alias_added: DICTIONARY["stock.audit.alias_added"].en,
  product_alias_removed: DICTIONARY["stock.audit.alias_removed"].en,
  order_product_mapped: DICTIONARY["stock.audit.order_product_mapped"].en,
  order_product_unmapped: DICTIONARY["stock.audit.order_product_unmapped"].en,
  stock_intake_created: DICTIONARY["stock.audit.intake_created"].en,
  stock_intake_updated: DICTIONARY["stock.audit.intake_updated"].en,
  stock_intake_voided: DICTIONARY["stock.audit.intake_voided"].en,
  stock_adjustment_created: DICTIONARY["stock.audit.adjustment_created"].en,
  inventory_adjustment_requested: DICTIONARY["stock.audit.adjustment_requested"].en,
  inventory_adjustment_rejected: DICTIONARY["stock.audit.adjustment_rejected"].en,
  inventory_transfer_posted: DICTIONARY["stock.audit.transfer_posted"].en,
  inventory_scrap_posted: DICTIONARY["stock.audit.scrap_posted"].en,
  inventory_customer_return_posted: DICTIONARY["stock.audit.customer_return_posted"].en,
  inventory_supplier_return_posted: DICTIONARY["stock.audit.supplier_return_posted"].en,
  inventory_issue_posted: DICTIONARY["stock.audit.issue_posted"].en,
  inventory_document_reversed: DICTIONARY["stock.audit.document_reversed"].en,
  stock_reserved: DICTIONARY["stock.audit.stock_reserved"].en,
  stock_reservation_released: DICTIONARY["stock.audit.reservation_released"].en,
  product_packaging_saved: DICTIONARY["stock.audit.packaging_saved"].en,
  stock_lot_updated: DICTIONARY["stock.audit.lot_updated"].en,
};

export function movementLabelEn(kind: MovementKind) {
  return MOVEMENT_LABEL_EN[kind];
}

export function movementLabelAr(kind: MovementKind) {
  return MOVEMENT_LABEL[kind];
}

/** Look up a movement label by language, keeping Arabic RTL direction. */
export function movementLabel(kind: MovementKind, locale: "ar" | "en"): string {
  return locale === "ar" ? MOVEMENT_LABEL[kind] : MOVEMENT_LABEL_EN[kind];
}

export function shortDate(iso: string) {
  return iso.slice(5).replace("-", "/"); // YYYY-MM-DD -> MM/DD
}

export function timeLabel(iso: string, locale: "ar" | "en" = "ar") {
  return new Date(iso).toLocaleTimeString(locale === "en" ? "en-GB" : "ar-EG", { hour: "2-digit", minute: "2-digit" });
}
