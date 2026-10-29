"use client";

import { useState } from "react";
import { CheckCircle2, CircleDashed } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import type { OrderDTO } from "@/lib/client-types";
import { StatusBadge } from "@/components/StatusBadge";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { todayLocalISO } from "@/lib/localDate";
import { qty, unitLabel } from "@/lib/format";
import { useLocale } from "@/lib/locale";

type ProductionRow = {
  productName: string;
  unit: string;
  required: number;
  prepared: number;
  orderCount: number;
};

export function ProductionBoard() {
  const { t } = useLocale();
  const today = todayLocalISO();
  const [open, setOpen] = useState<string | null>(null);

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["production"],
    queryFn: () =>
      apiFetch<{ date: string; products: ProductionRow[] }>(
        `/api/production/daily?date=${today}`
      ),
    refetchInterval: 5000,
  });

  // Same scope as the aggregation (server-side productionScope): open orders plus what was
  // delivered or closed today, so the drill-down always matches the totals above and a
  // dispatched order stays clickable for the day.
  const { data: ordersData } = useQuery({
    queryKey: ["orders", "production"],
    queryFn: () => apiFetch<{ orders: OrderDTO[] }>("/api/orders?scope=production"),
    refetchInterval: 5000,
    staleTime: 2000,
  });
  const openOrders = (ordersData?.orders ?? []).filter((o) => o.status !== "cancelled");

  // Incomplete/short products surface first — that's what production needs to act on.
  const products = [...(data?.products ?? [])].sort((a, b) => {
    const remA = a.required - a.prepared;
    const remB = b.required - b.prepared;
    if (remA > 0 !== remB > 0) return remA > 0 ? -1 : 1;
    return remB - remA;
  });

  // Grand total per unit (KG, PC, ...) so the whole day's workload reads at a glance.
  const totalsByUnit = new Map<string, number>();
  for (const p of products) totalsByUnit.set(p.unit, (totalsByUnit.get(p.unit) ?? 0) + p.required);

  return (
    <div className="page-floor">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold text-united-dark">{t("production.title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>
      <p className="text-united-muted font-bold mb-4">{today}</p>

      {isLoading && <LoadingState />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && products.length === 0 && (
        <EmptyState icon="📦" title={t("prodboard.empty")} />
      )}

      {!isLoading && !isError && products.length > 0 && (
        <div className="bg-united-dark text-white rounded-2xl p-5 mb-4 flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-sm font-bold text-white/60">{t("prodboard.total-orders")}</div>
            <div className="text-3xl font-extrabold">{openOrders.length}</div>
          </div>
          <div className="flex gap-4 flex-wrap">
            {[...totalsByUnit.entries()].map(([unit, total]) => (
              <div key={unit} className="text-end">
                <div className="text-sm font-bold text-white/60">{unitLabel(unit)}</div>
                <div dir="ltr" className="text-2xl font-extrabold">{qty(total)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {products.map((p) => {
          const remaining = p.required - p.prepared;
          const complete = remaining <= 0;
          const pct = p.required > 0 ? Math.min(100, (p.prepared / p.required) * 100) : 0;
          const isOpen = open === p.productName;
          const relatedOrders = openOrders.filter((o) =>
            o.items.some((i) => i.productName === p.productName)
          );
          return (
            <div key={p.productName} className="card p-5">
              <button
                className="w-full text-start"
                onClick={() => setOpen(isOpen ? null : p.productName)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xl font-extrabold text-united-dark flex items-center gap-2">
                    {p.productName}
                    {complete ? <CheckCircle2 size={20} className="text-united-green" aria-label={t("ui.done")} /> : <CircleDashed size={20} className="text-united-warn" aria-hidden />}
                  </span>
                  <span className="text-lg font-extrabold text-united-dark">
                    <span dir="ltr">
                      {qty(p.prepared)} / {qty(p.required)}
                    </span>
                    <span className="text-xs font-bold text-united-dark/40"> {unitLabel(p.unit)}</span>
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm text-united-dark/50 font-bold mb-2">
                  <span>{t("prodboard.orders", { count: p.orderCount })}</span>
                  {!complete && (
                    <span className="text-united-warn">
                      {t("prodboard.left")} <span dir="ltr">{qty(remaining)} {unitLabel(p.unit)}</span>
                    </span>
                  )}
                </div>
                <div className="h-2 rounded-full bg-united-dark/10 overflow-hidden">
                  <div
                    className={`h-full ${complete ? "bg-united-green" : "bg-united-warn"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </button>

              {isOpen && (
                <div className="mt-4 border-t border-united-dark/5 pt-3 flex flex-col gap-1">
                  {relatedOrders.length === 0 && (
                    <p className="text-sm text-united-dark/40">{t("prodboard.no-related")}</p>
                  )}
                  {relatedOrders.map((o) => {
                    const item = o.items.find((i) => i.productName === p.productName)!;
                    return (
                      <Link
                        key={o.id}
                        href={`/orders/${o.id}`}
                        className="flex items-center justify-between text-sm py-2 px-2 -mx-2 rounded-lg hover:bg-united-dark/5"
                      >
                        <span className="font-bold text-united-dark">{o.customerName}</span>
                        <span dir="ltr" className="text-united-dark/60">
                          {qty(item.requiredQuantity)} {unitLabel(item.unit)}
                        </span>
                        <StatusBadge status={o.status} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
