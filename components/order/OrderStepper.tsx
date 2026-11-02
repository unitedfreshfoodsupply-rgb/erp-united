"use client";

import { Check } from "lucide-react";
import { useLocale } from "@/lib/locale";
import type { OrderStatus } from "@/lib/types";

const FLOW: OrderStatus[] = ["new", "preparing", "ready_for_loading", "loading", "loaded", "dispatched"];

/**
 * Where an order stands in its lifecycle (UX, maturity 2026-11): what is done, where it is
 * now, what comes next. Read-only — it never offers a transition the rules would refuse;
 * the actions stay where they are, behind their permissions and approvals.
 */
export function OrderStepper({ status }: { status: OrderStatus }) {
  const { t } = useLocale();
  if (status === "cancelled") {
    return <p className="pill-danger w-fit"><span className="pill-dot" />{t("orders.status.cancelled")}</p>;
  }
  const at = FLOW.indexOf(status);
  return (
    <ol className="flex w-full items-center gap-1 overflow-x-auto no-scrollbar py-1" aria-label={t("orders.stepper.label")}>
      {FLOW.map((s, i) => {
        const done = i < at || status === "dispatched";
        const current = i === at;
        return (
          <li key={s} className={`flex items-center gap-1 ${current ? "shrink-0" : "min-w-0 flex-1"}`} aria-current={current ? "step" : undefined} title={t(`orders.status.${s}`)}>
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                done ? "bg-united-green text-white" : current ? "border-2 border-united-green bg-white text-united-green" : "border border-united-border-strong bg-white text-united-muted"
              }`}
              aria-hidden
            >
              {done ? <Check size={13} strokeWidth={3} /> : i + 1}
            </span>
            {/* Only the current stage is named on screen (six names do not fit a card); the
                others are named for screen readers and on hover. */}
            <span className={current ? "whitespace-nowrap text-xs font-semibold text-united-dark" : "sr-only"}>
              {t(`orders.status.${s}`)}
              {done && <span className="sr-only"> — {t("orders.stepper.done")}</span>}
            </span>
            {i < FLOW.length - 1 && <span aria-hidden className={`mx-1 h-px min-w-4 flex-1 ${done ? "bg-united-green" : "bg-united-border-strong"}`} />}
          </li>
        );
      })}
    </ol>
  );
}
