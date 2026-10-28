import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock, Hourglass, OctagonAlert, PauseCircle } from "lucide-react";
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
 *
 * Urgency is a bar on the inline-start edge (red: blocked or late; amber: soon, waiting or
 * stalled) so a column of cards can be scanned for trouble without every late card
 * shouting with a red frame. The whole card is one link to the order — the next action
 * is shown as its call to action, not as a second control nested inside the link.
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
  const action = nextAction(order, locale === "en" ? "en" : "ar");
  const shortage = shortageSummary(order, locale === "en" ? "en" : "ar");
  const remaining = isLoadingStage ? roll.remainingToLoad : roll.remainingToPrepare;
  const srcLabel = locale === "en" ? SOURCE_LABEL_EN : SOURCE_LABEL;
  const critical = (order.needsReview && activeProblem) || urgency === "late";
  const caution = !critical && (urgency === "soon" || waitingTooLong || stalled);

  return (
    <Link
      href={`/orders/${order.id}`}
      className="group relative block overflow-hidden card p-4 sm:p-5 transition hover:border-united-border-strong hover:shadow-card-hover"
    >
      {(critical || caution) && (
        <span aria-hidden className={`absolute inset-y-0 start-0 w-1 ${critical ? "bg-united-danger" : "bg-[#E2A33B]"}`} />
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold text-united-dark truncate">{order.customerName}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-sm font-medium text-united-green">
            <Clock size={14} aria-hidden />
            <span>{t("order.delivery")} {deliverySlot(order.deliveryDate, order.deliveryTime, locale === "en" ? "en" : "ar")}</span>
          </div>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-united-muted">
        <span dir="ltr" className="font-medium">{order.orderNumber}</span>
        {order.externalId && <span dir="ltr">{t("order.customer-ref")}: {order.externalId}</span>}
        <span>{srcLabel[order.source] ?? order.source}</span>
      </div>

      {/* Progress: items done of items ordered */}
      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-united-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={roll.itemsTotal} aria-valuenow={doneCount} aria-label={isLoadingStage ? t("order.loading") : t("order.prep")}>
          <div className={`h-full rounded-full ${doneCount === roll.itemsTotal ? "bg-united-green" : "bg-united-green/60"}`} style={{ width: `${pct}%` }} />
        </div>
        <span dir="ltr" className="whitespace-nowrap text-sm font-semibold text-united-dark">
          {doneCount}/{roll.itemsTotal}
        </span>
      </div>
      {stage !== "done" && stage !== "cancelled" && remaining > 0 && roll.singleUnit && (
        <div className="mt-1 text-xs text-united-muted">
          {t("order.remaining")} <span dir="ltr" className="font-semibold text-united-dark">{qty(remaining)} {roll.singleUnit}</span>{" "}
          {isLoadingStage ? t("order.loading") : t("order.prep")}
        </div>
      )}

      {(shortage || waitingTooLong || stalled || urgency !== "none") && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
          {activeProblem && shortage && (
            <span className="inline-flex items-center gap-1.5 text-united-warn"><AlertTriangle size={15} aria-hidden />{shortage}</span>
          )}
          {waitingTooLong && <span className="inline-flex items-center gap-1.5 text-united-warn"><Hourglass size={15} aria-hidden />{t("order.waiting")}</span>}
          {stalled && <span className="inline-flex items-center gap-1.5 text-united-warn"><PauseCircle size={15} aria-hidden />{t("order.stalled")}</span>}
          {urgency === "late" && <span className="inline-flex items-center gap-1.5 text-united-danger"><Clock size={15} aria-hidden />{t("order.past-due")}</span>}
          {urgency === "soon" && !activeProblem && (
            <span className="inline-flex items-center gap-1.5 text-united-warn"><Clock size={15} aria-hidden />{t("order.due-soon")}</span>
          )}
        </div>
      )}

      {/* Next action — what has to happen now, and who owns it */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-united-border pt-3">
        {action.tone === "done" || action.label === "—" ? (
          <span className="text-sm text-united-muted">{action.label}</span>
        ) : (
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold ${
              action.tone === "blocked" ? "bg-[#FDECEA] text-united-danger" : "bg-united-green/10 text-united-green group-hover:bg-united-green/15"
            }`}
          >
            {action.tone === "blocked" ? <OctagonAlert size={16} aria-hidden /> : <ArrowRight size={16} className="rtl:rotate-180" aria-hidden />}
            {action.label}
          </span>
        )}
        {action.owner !== "—" && <span className="shrink-0 text-xs text-united-muted">{action.owner}</span>}
      </div>

      <div className="mt-2 text-[11px] text-united-muted">
        {t("order.last-movement")} {agoLabel(order.updatedAt, undefined, locale)}
      </div>
    </Link>
  );
}
