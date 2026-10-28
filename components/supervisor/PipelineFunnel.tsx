"use client";

import type { OrderDTO } from "@/lib/client-types";
import type { OrderStatus } from "@/lib/types";

import { useLocale } from "@/lib/locale";
import { ORDER_DOT } from "@/components/StatusBadge";

const STAGE_KEYS: Record<OrderStatus, string> = {
  new: "orders.status.new",
  preparing: "orders.status.preparing",
  ready_for_loading: "orders.status.ready_for_loading",
  loading: "orders.status.loading",
  loaded: "orders.status.loaded",
  dispatched: "orders.status.dispatched",
  cancelled: "orders.status.cancelled",
};

const STAGES = (Object.entries(STAGE_KEYS) as [OrderStatus, string][]).map(([status]) => ({ status }));

/** The same stage colours as the status pills (components/StatusBadge.tsx). */
const DOT = ORDER_DOT;

/** The operational pipeline at a glance — every stage's count, click to filter.
 * Same statuses/workflow as everywhere else, just visualized as a funnel. */
export function PipelineFunnel({
  orders,
  activeStatus,
  onSelect,
}: {
  orders: OrderDTO[];
  activeStatus: OrderStatus | null;
  onSelect: (status: OrderStatus | null) => void;
}) {
  const { t } = useLocale();
  const counts = new Map<OrderStatus, number>();
  for (const o of orders) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);

  return (
    // All seven stages on one row from tablet up (was a 6-column grid that left one tile alone).
    <div className="grid grid-cols-4 sm:grid-cols-7 gap-2" role="group" aria-label={t("supervisor.pipeline-label")}>
      {STAGES.map((s) => {
        const count = counts.get(s.status) ?? 0;
        const active = activeStatus === s.status;
        return (
          <button
            key={s.status}
            onClick={() => onSelect(active ? null : s.status)}
            aria-pressed={active}
            className={`card px-2 py-3 text-center transition ${
              active ? "!border-united-dark ring-2 ring-united-dark/10" : "hover:border-united-border-strong"
            } ${count === 0 ? "opacity-70" : ""}`}
          >
            <div className="mb-1 text-2xl font-bold leading-none text-united-dark">{count}</div>
            <div className="flex items-start justify-center gap-1.5 text-xs font-medium text-united-muted">
              <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[s.status]}`} />
              <span className="leading-tight">{t(STAGE_KEYS[s.status])}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
