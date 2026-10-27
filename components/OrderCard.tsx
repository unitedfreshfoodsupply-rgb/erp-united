import Link from "next/link";
import type { OrderDTO } from "@/lib/client-types";
import { StatusBadge } from "./StatusBadge";
import { orderUrgency, hasActiveProblem, isWaitingTooLong, isStalledInProgress } from "@/lib/orderPresentation";
import { deliverySlot, qty, agoLabel } from "@/lib/format";
import { nextAction, rollUpQuantities, shortageSummary, stageOf } from "@/lib/orderSummary";
import { SOURCE_LABEL, SOURCE_LABEL_EN } from "@/lib/auditLabels";
import { useOperationalSettings } from "@/lib/use-operational-settings";
import { useLocale } from "@/lib/locale";

/**
 * One order, as an operator needs to read it in a second: who it is for, when it is
 * due, how much of it is actually done, what is still owed, and what has to happen next.
 */
export function OrderCard({ order }: { order: OrderDTO }) {
  const { t, locale } = useLocale();
  const ops = useOperationalSettings();
  const stage = stageOf(order.status);
  const roll = rollUpQuantities(order.items);
  const isLoadingStage = stage === "load" || stage === "done";
  const doneCount = isLoadingStage ? roll.itemsLoaded : roll.itemsPrepared;
  const pct = roll.itemsTotal > 0 ? Math.round((doneCount / roll.itemsTotal) * 100) : 0;
  const urgency = orderUrgency(order.status, order.deliveryDate, order.deliveryTime, ops.deliverySoonMinutes);
  const activeProblem = hasActiveProblem(order);
  const waitingTooLong = isWaitingTooLong(order.status, order.createdAt, ops.waitingToStartMinutes);
  const stalled = isStalledInProgress(order.status, order.updatedAt, ops.stalledMinutes);
  const action = nextAction(order);
  const shortage = shortageSummary(order);
  const remaining = isLoadingStage ? roll.remainingToLoad : roll.remainingToPrepare;
  const srcLabel = locale === "en" ? SOURCE_LABEL_EN : SOURCE_LABEL;

  return (
    <Link
      href={`/orders/${order.id}`}
      className={`block card p-4 sm:p-5 border-2 transition hover:border-united-green hover:shadow-card-hover active:scale-[0.99] ${
        order.needsReview && activeProblem
          ? "!border-united-danger/40"
          : urgency === "late"
          ? "!border-united-danger/30"
          : "!border-united-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0">
          <div className="text-lg sm:text-xl font-extrabold text-united-dark truncate">
            {order.customerName}
          </div>
          <div className="text-united-green font-bold text-sm">
            {t("order.delivery")} {deliverySlot(order.deliveryDate, order.deliveryTime)}
          </div>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-bold text-united-muted mt-1">
        <span dir="ltr">{order.orderNumber}</span>
        {order.externalId && <span dir="ltr">{t("order.customer-ref")}: {order.externalId}</span>}
        <span>{srcLabel[order.source] ?? order.source}</span>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2 mt-3">
        <div className="h-1.5 flex-1 rounded-full bg-united-dark/10 overflow-hidden">
          <div
            className={`h-full ${doneCount === roll.itemsTotal ? "bg-united-green" : "bg-united-green/50"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span dir="ltr" className="text-sm text-united-muted font-bold whitespace-nowrap">
          {doneCount}/{roll.itemsTotal}
        </span>
      </div>
      {stage !== "done" && stage !== "cancelled" && remaining > 0 && roll.singleUnit && (
        <div className="text-xs font-bold text-united-muted mt-1">
          {t("order.remaining")} <span dir="ltr">{qty(remaining)} {roll.singleUnit}</span>{" "}
          {isLoadingStage ? t("order.loading") : t("order.prep")}
        </div>
      )}

      {/* Next action */}
      <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-united-border">
        <span
          className={`text-sm font-extrabold ${
            action.tone === "blocked"
              ? "text-united-danger"
              : action.tone === "action"
              ? "text-united-dark"
              : "text-united-muted"
          }`}
        >
          {action.tone === "blocked" ? "🔴 " : action.tone === "action" ? "▶ " : ""}
          {action.label}
        </span>
        {action.owner !== "—" && (
          <span className="text-xs font-bold text-united-muted shrink-0">{action.owner}</span>
        )}
      </div>

      {(shortage || waitingTooLong || stalled || urgency !== "none") && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          {activeProblem && shortage && (
            <span className="text-sm font-bold text-united-warn">⚠️ {shortage}</span>
          )}
          {waitingTooLong && <span className="text-sm font-bold text-united-warn">⏳ {t("order.waiting")}</span>}
          {stalled && <span className="text-sm font-bold text-united-warn">⏸️ {t("order.stalled")}</span>}
          {urgency === "late" && <span className="text-sm font-bold text-united-danger">⏰ {t("order.past-due")}</span>}
          {urgency === "soon" && !activeProblem && (
            <span className="text-sm font-bold text-united-warn">⏰ {t("order.due-soon")}</span>
          )}
        </div>
      )}

      <div className="text-[11px] font-bold text-united-muted mt-2">
        {t("order.last-movement")} {agoLabel(order.updatedAt, undefined, locale)}
      </div>
    </Link>
  );
}