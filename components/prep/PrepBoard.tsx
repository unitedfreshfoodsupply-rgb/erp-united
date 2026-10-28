"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import type { OrderDTO } from "@/lib/client-types";
import { OrderCard } from "@/components/OrderCard";
import { EmptyState, ErrorState } from "@/components/States";
import { BoardSkeleton } from "@/components/Skeleton";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { orderUrgency } from "@/lib/orderPresentation";
import { useNewOrderAlert } from "@/lib/liveAlerts";
import { useLocale } from "@/lib/locale";
import { useOperationalSettings } from "@/lib/use-operational-settings";

const URGENCY_RANK = { late: 0, soon: 1, ok: 2, none: 3 } as const;

function byUrgency(soonMin: number) {
  return (a: OrderDTO, b: OrderDTO) => {
    const ua = URGENCY_RANK[orderUrgency(a.status, a.deliveryDate, a.deliveryTime, soonMin)];
    const ub = URGENCY_RANK[orderUrgency(b.status, b.deliveryDate, b.deliveryTime, soonMin)];
    if (ua !== ub) return ua - ub;
    return (a.deliveryTime ?? "").localeCompare(b.deliveryTime ?? "");
  };
}

export function PrepBoard() {
  const ops = useOperationalSettings();
  const { t } = useLocale();
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["orders", "prep"],
    queryFn: () => apiFetch<{ orders: OrderDTO[] }>("/api/orders?status=new,preparing"),
    refetchInterval: 3000,
  });

  useNewOrderAlert(data?.orders);

  const orders = data?.orders ?? [];
  const notStarted = orders.filter((o) => o.status === "new").sort(byUrgency(ops.deliverySoonMinutes));
  const inProgress = orders.filter((o) => o.status === "preparing").sort(byUrgency(ops.deliverySoonMinutes));
  const late = orders.filter((o) => orderUrgency(o.status, o.deliveryDate, o.deliveryTime, ops.deliverySoonMinutes) === "late").length;

  return (
    <div className="page-floor">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold text-united-dark">{t("orders.board-title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>

      {!isLoading && !isError && orders.length > 0 && (
        <p className="text-sm font-bold text-united-muted mt-1 mb-4">
          {notStarted.length} {t("orders.status.new")} · {inProgress.length} {t("orders.status.preparing")}
          {late > 0 && <span className="text-united-danger"> · {late} {t("orders.overdue")}</span>}
        </p>
      )}

      {isLoading && <BoardSkeleton />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && orders.length === 0 && (
        <EmptyState icon="👍" title={t("orders.empty-state")} />
      )}

      {inProgress.length > 0 && (
        <div className="mb-5">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-united-muted"><span aria-hidden className="h-2 w-2 rounded-full bg-[#E2A33B]" />{t("orders.section.preparing-header")} <span className="font-normal">({inProgress.length})</span></h2>
          <div className="flex flex-col gap-3">
            {inProgress.map((o) => (
              <OrderCard key={o.id} order={o} />
            ))}
          </div>
        </div>
      )}

      {notStarted.length > 0 && (
        <div>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-united-muted"><span aria-hidden className="h-2 w-2 rounded-full bg-united-info" />{t("orders.section.not-started-header")} <span className="font-normal">({notStarted.length})</span></h2>
          <div className="flex flex-col gap-3">
            {notStarted.map((o) => (
              <OrderCard key={o.id} order={o} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
