import { ORDER_STATUSES, type OrderStatus } from "@/lib/types";
import { DICTIONARY } from "@/lib/locale/dictionary";
import { DEFAULT_OPERATIONAL_SETTINGS } from "@/lib/core/settings-registry";

export const STATUS_DOT: Record<OrderStatus, string> = {
  new: "🔵",
  preparing: "🟡",
  ready_for_loading: "🟢",
  loading: "🟠",
  loaded: "✓",
  dispatched: "🚚",
  cancelled: "⚪",
};

/** Order stage names, read from the dictionary (orders.status.*) so the order page, prints,
 * the audit log and server messages use the same words as Home and the profiles. */
const statusLabels = (locale: "ar" | "en") =>
  Object.fromEntries(ORDER_STATUSES.map((s) => [s, DICTIONARY[`orders.status.${s}`][locale]])) as Record<OrderStatus, string>;

export const STATUS_LABEL: Record<OrderStatus, string> = statusLabels("ar");

export const STATUS_LABEL_EN: Record<OrderStatus, string> = statusLabels("en");

const ACTIVE_STATUSES: OrderStatus[] = ["new", "preparing", "ready_for_loading", "loading"];

/** Every status before the order is actually finished (dispatched/cancelled are terminal). */
export const OPEN_STATUSES: OrderStatus[] = [
  "new",
  "preparing",
  "ready_for_loading",
  "loading",
  "loaded",
];

export function isOrderOpen(status: OrderStatus) {
  return OPEN_STATUSES.includes(status);
}

/** "Needs attention" only makes sense for orders still in the pipeline — a dispatched
 * or cancelled order keeps its historical shortage/needsReview flags forever, but
 * there's nothing left to act on, so it shouldn't inflate a "problems" count/filter. */
export function hasActiveProblem(order: {
  status: OrderStatus;
  needsReview: boolean;
  shortage: boolean;
}) {
  return isOrderOpen(order.status) && (order.needsReview || order.shortage);
}

/** Strictly "blocked, waiting on a supervisor decision right now" — unlike
 * hasActiveProblem, this excludes an already-approved shortage (needsReview:false,
 * shortage:true), which has nothing left to act on. Used for the urgent
 * "needs your intervention" count so it never cries wolf on a resolved order. */
export function needsSupervisorAction(order: { status: OrderStatus; needsReview: boolean }) {
  return isOrderOpen(order.status) && order.needsReview;
}

export type ExceptionCategory = "active" | "informational" | "resolved" | null;

/** One consistent classification of "what kind of exception is this order,
 * if any" — used by the Exceptions Center so a resolved/approved shortage never
 * reads the same as something the supervisor still has to act on.
 *  - active: open order, still blocked on a supervisor decision right now.
 *  - informational: open order, had a shortage that's already been approved —
 *    worth knowing, nothing to do.
 *  - resolved: order is closed (dispatched/cancelled) but has a shortage/review
 *    flag in its history — pure record, not actionable at all.
 */
export function exceptionCategory(order: {
  status: OrderStatus;
  needsReview: boolean;
  shortage: boolean;
}): ExceptionCategory {
  const open = isOrderOpen(order.status);
  if (open && order.needsReview) return "active";
  if (open && order.shortage) return "informational";
  if (!open && (order.needsReview || order.shortage)) return "resolved";
  return null;
}

// The thresholds below are business settings (orders.waiting_to_start_minutes,
// orders.stalled_minutes, orders.delivery_soon_minutes). Callers pass the configured
// values from useOperationalSettings() / getOperationalSettings(); the defaults here
// are only the fallback while those load.

/** Orders that arrived but nobody has started preparing yet, past a grace period —
 * the thing a supervisor most needs to catch before it becomes a late delivery. */
export function isWaitingTooLong(
  status: OrderStatus,
  createdAt: string,
  thresholdMin = DEFAULT_OPERATIONAL_SETTINGS.waitingToStartMinutes
) {
  if (status !== "new") return false;
  return (Date.now() - new Date(createdAt).getTime()) / 60000 > thresholdMin;
}

const IN_PROGRESS_STATUSES: OrderStatus[] = ["preparing", "ready_for_loading", "loading", "loaded"];

/** An order that's already been started (unlike isWaitingTooLong, which only
 * covers "new") but hasn't had ANY item/status update in a while — a stalled
 * bottleneck, not a "hasn't started" case. updatedAt only moves when someone
 * actually touches the order, so this is a genuine "nobody's working on this
 * right now" signal, not just a timer since creation. */
export function isStalledInProgress(
  status: OrderStatus,
  updatedAt: string,
  thresholdMin = DEFAULT_OPERATIONAL_SETTINGS.stalledMinutes
) {
  if (!IN_PROGRESS_STATUSES.includes(status)) return false;
  return (Date.now() - new Date(updatedAt).getTime()) / 60000 > thresholdMin;
}

export type Urgency = "late" | "soon" | "ok" | "none";

/** Simple client-safe urgency check against delivery date/time — no timezone lib needed. */
export function orderUrgency(
  status: OrderStatus,
  deliveryDate: string,
  deliveryTime: string | null,
  soonMin = DEFAULT_OPERATIONAL_SETTINGS.deliverySoonMinutes
): Urgency {
  if (!ACTIVE_STATUSES.includes(status)) return "none";
  const dt = new Date(`${deliveryDate}T${deliveryTime || "23:59"}:00`);
  if (Number.isNaN(dt.getTime())) return "none";
  const diffMin = (dt.getTime() - Date.now()) / 60000;
  if (diffMin < 0) return "late";
  if (diffMin < soonMin) return "soon";
  return "ok";
}

export const URGENCY_LABEL: Record<Urgency, string> = {
  late: "⏰ متأخر عن الميعاد",
  soon: "⏰ قريب من الميعاد",
  ok: "",
  none: "",
};
