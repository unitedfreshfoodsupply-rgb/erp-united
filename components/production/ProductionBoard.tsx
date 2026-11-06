"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, CircleDashed } from "lucide-react";
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
import { localName, orderCustomerName } from "@/lib/locale/names";
import { aggregateProduction, productionLines } from "@/lib/production";
import { QtyUnit } from "@/components/stock/QtyUnit";

export function ProductionBoard() {
  const { t, locale } = useLocale();
  const today = todayLocalISO();
  const [open, setOpen] = useState<string | null>(null);

  // One poll (PC-5): the orders in today's production scope (server-side productionScope:
  // open orders plus what was delivered or closed today). The per-product totals are computed
  // from this same list with the helper /api/production/daily uses, so the totals and the
  // drill-down under them always match, and a dispatched order stays clickable for the day.
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["orders", "production"],
    queryFn: () => apiFetch<{ orders: OrderDTO[] }>("/api/orders?scope=production"),
    refetchInterval: 5000,
    staleTime: 2000,
  });
  const openOrders = useMemo(() => (data?.orders ?? []).filter((o) => o.status !== "cancelled"), [data]);

  // Incomplete/short products surface first — that's what production needs to act on.
  const products = useMemo(
    () =>
      aggregateProduction(openOrders).sort((a, b) => {
        const remA = a.required - a.prepared;
        const remB = b.required - b.prepared;
        if (remA > 0 !== remB > 0) return remA > 0 ? -1 : 1;
        return remB - remA;
      }),
    [openOrders]
  );

  // Grand total per unit (KG, PC, ...) so the whole day's workload reads at a glance.
  const totalsByUnit = new Map<string, number>();
  for (const p of products) totalsByUnit.set(p.unit, (totalsByUnit.get(p.unit) ?? 0) + p.required);

  return (
    <div className="page-floor">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold text-united-dark">{t("production.title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} stale={isError && !!data} />
      </div>
      <p className="text-united-muted font-bold mb-4">{today}</p>

      {isLoading && <LoadingState />}
      {/* A failed background poll keeps the board it had (PM-4): the error replaces the board
          only when there is nothing to show. */}
      {isError && !data && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
      {data && products.length === 0 && (
        <EmptyState icon="📦" title={t("prodboard.empty")} />
      )}

      {data && products.length > 0 && (
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
          // Keyed by product and unit, like the picking sheet's cards (UXO-13, FLOOR-5): the same
          // product ordered in kg and in crates is two rows, and each lists only its own lines.
          const isOpen = open === p.key;
          const related = isOpen ? productionLines<OrderDTO, OrderDTO["items"][number]>(openOrders, p.key) : [];
          return (
            <div key={p.key} className="card p-5">
              <button
                type="button"
                className="w-full text-start"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : p.key)}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  {/* A long name wraps; the figure beside it stays on one line (FLOOR-14). */}
                  <span className="min-w-0 text-xl font-extrabold text-united-dark flex items-center gap-2">
                    <span className="min-w-0 break-words">{localName({ name: p.productNameEn ?? p.productName, nameAr: p.productNameAr }, locale === "en" ? "en" : "ar")}</span>
                    {complete ? <CheckCircle2 size={20} className="shrink-0 text-united-green" aria-label={t("ui.done")} /> : <CircleDashed size={20} className="shrink-0 text-united-warn" aria-hidden />}
                  </span>
                  <span className="shrink-0 whitespace-nowrap flex items-center gap-1 text-lg font-extrabold text-united-dark">
                    <span dir="ltr">
                      {qty(p.prepared)} / {qty(p.required)}
                    </span>
                    <span className="text-xs font-bold text-united-muted">{unitLabel(p.unit)}</span>
                    <ChevronDown size={18} aria-hidden className={`shrink-0 text-united-muted transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm text-united-muted font-bold mb-2">
                  <span>{p.orderCount === 1 ? t("prodboard.orders-one") : t("prodboard.orders", { count: p.orderCount })}</span>
                  {!complete && (
                    <span className="text-united-warn">
                      {t("prodboard.left")} <QtyUnit value={qty(remaining)} unit={p.unit} />
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
                  {related.length === 0 && (
                    <p className="text-sm text-united-muted">{t("prodboard.no-related")}</p>
                  )}
                  {related.map(({ order: o, item }) => {
                    return (
                      <Link
                        key={item.id}
                        href={`/orders/${o.id}`}
                        className="flex items-center justify-between text-sm py-2 px-2 -mx-2 rounded-lg hover:bg-united-dark/5"
                      >
                        <span className="font-bold text-united-dark">{orderCustomerName(o, locale === "en" ? "en" : "ar")}</span>
                        <QtyUnit value={qty(item.requiredQuantity)} unit={item.unit} className="text-united-muted" />
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
