"use client";

import { useState } from "react";
import { Ban, Check } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { todayLocalISO } from "@/lib/localDate";
import { qty, unitLabel } from "@/lib/format";
import type { DailySheetDTO } from "@/lib/picking-sheet";
import { useLocale } from "@/lib/locale";

// Dictionary keys, translated at render.
const STATUS_LABEL: Record<string, string> = {
  new: "picking.status.new",
  preparing: "picking.status.preparing",
  ready_for_loading: "picking.status.ready_for_loading",
  loading: "picking.status.loading",
};

const STATUS_COLOR: Record<string, string> = {
  new: "text-blue-600 bg-blue-50",
  preparing: "text-amber-600 bg-amber-50",
  ready_for_loading: "text-emerald-600 bg-emerald-50",
  loading: "text-purple-600 bg-purple-50",
};

export function PickingSheet() {
  const { t } = useLocale();
  const today = todayLocalISO();
  const [date, setDate] = useState(today);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [filterPrepStatus, setFilterPrepStatus] = useState<string>("all");

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } =
    useQuery({
      queryKey: ["picking-sheet", date],
      queryFn: () =>
        apiFetch<DailySheetDTO>(
          `/api/production/daily/sheet?date=${date}`
        ),
      refetchInterval: 10_000,
    });

  const lines = data?.lines ?? [];
  const summary = data?.summary;

  // Filter by preparation status
  const filteredLines = lines
    .map((line) => {
      const isRelevant =
        filterPrepStatus === "all" ||
        (filterPrepStatus === "pending" && line.totalRemaining > 0) ||
        (filterPrepStatus === "done" && line.totalRemaining === 0) ||
        (filterPrepStatus === "rejected" &&
          line.allocations.some((a) => a.rejected));
      if (!isRelevant) return null;
      return {
        ...line,
        allocations: line.allocations.filter((a) => {
          if (filterPrepStatus === "all") return true;
          if (filterPrepStatus === "rejected") return a.rejected;
          if (filterPrepStatus === "pending")
            return a.preparationStatus !== "done";
          if (filterPrepStatus === "done")
            return a.preparationStatus === "done";
          return true;
        }),
      };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);

  return (
    <div className="p-4 max-w-4xl mx-auto pb-16 print:pb-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-1 print:mb-2">
        <h1 className="text-2xl font-extrabold text-united-dark print:hidden">
          {t("picking.title")}
        </h1>
        <h2 className="hidden print:block text-xl font-bold text-center">
          {t("picking.print-title", { date })}
        </h2>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>

      {/* Date picker row */}
      <div className="flex gap-3 items-center mb-4 flex-wrap print:hidden">
        <label className="flex items-center gap-2">
          <span className="text-sm font-bold text-united-muted">{t("picking.date")}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="field text-sm px-3 py-1.5"
          />
        </label>

        {/* Filter chips */}
        <div className="flex gap-1">
          {(["all", "pending", "done", "rejected"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilterPrepStatus(f)}
              className={`text-xs font-bold px-3 py-1.5 rounded-lg tap-target ${
                filterPrepStatus === f
                  ? "bg-united-green text-white"
                  : "bg-united-dark/5 text-united-muted"
              }`}
            >
              {t(`picking.filter.${f}`)}
            </button>
          ))}
        </div>

        <button
          onClick={() => window.print()}
          className="btn-secondary text-xs px-3 py-1.5 ms-auto"
        >
          {t("picking.print")}
        </button>
      </div>

      {isLoading && <LoadingState />}
      {isError && (
        <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
      )}
      {!isLoading && !isError && lines.length === 0 && (
        <EmptyState icon="📦" title={t("picking.empty")} />
      )}

      {/* Summary bar */}
      {summary && lines.length > 0 && (
        <div className="bg-united-dark text-white rounded-2xl p-4 mb-4 flex flex-wrap gap-x-6 gap-y-2 print:bg-gray-800">
          <div>
            <div className="text-xs text-white/60 font-bold">{t("picking.orders")}</div>
            <div className="text-xl font-extrabold">{summary.orderCount}</div>
          </div>
          <div>
            <div className="text-xs text-white/60 font-bold">{t("picking.required")}</div>
            <div dir="ltr" className="text-xl font-extrabold">
              {qty(summary.totalRequired)}
            </div>
          </div>
          <div>
            <div className="text-xs text-white/60 font-bold">{t("picking.prepared")}</div>
            <div dir="ltr" className="text-xl font-extrabold text-emerald-300">
              {qty(summary.totalPrepared)}
            </div>
          </div>
          <div>
            <div className="text-xs text-white/60 font-bold">{t("picking.approved")}</div>
            <div dir="ltr" className="text-xl font-extrabold text-emerald-300">
              {qty(summary.totalApproved)}
            </div>
          </div>
          <div>
            <div className="text-xs text-white/60 font-bold">{t("picking.loaded")}</div>
            <div dir="ltr" className="text-xl font-extrabold text-emerald-300">
              {qty(summary.totalLoaded)}
            </div>
          </div>
          <div>
            <div className="text-xs text-white/60 font-bold">{t("picking.remaining")}</div>
            <div
              dir="ltr"
              className={`text-xl font-extrabold ${
                summary.totalRemaining > 0
                  ? "text-amber-300"
                  : "text-emerald-300"
              }`}
            >
              {qty(summary.totalRemaining)}
            </div>
          </div>
        </div>
      )}

      {/* Product cards */}
      <div className="flex flex-col gap-3">
        {filteredLines.map((line) => {
          const remaining = line.totalRequired - line.totalLoaded;
          const prepPct =
            line.totalRequired > 0
              ? Math.round(
                  (line.totalPrepared / line.totalRequired) * 100
                )
              : 0;
          const isExpanded = expandedProduct === line.productName;
          const allocationSet = new Set(
            line.allocations.map((a) => a.orderId)
          );

          return (
            <div
              key={line.productName}
              className={`card p-4 border-2 ${
                line.totalRemaining > 0
                  ? "border-amber-200"
                  : "border-emerald-200"
              } print:border-gray-300 print:shadow-none print:break-inside-avoid`}
            >
              {/* Product header */}
              <button
                className="w-full text-start flex items-center justify-between gap-2"
                onClick={() =>
                  setExpandedProduct(
                    isExpanded ? null : line.productName
                  )
                }
              >
                <div>
                  <span className="text-lg font-extrabold text-united-dark">
                    {line.productName}
                  </span>
                  <span className="text-xs text-united-muted ms-2">
                    {unitLabel(line.unit)}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  {/* Mini quantity summary */}
                  <div className="flex gap-3 text-xs font-bold print:hidden">
                    {line.totalPrepared > 0 && (
                      <span className="inline-flex items-center gap-1 text-united-green">
                        <Check size={13} aria-hidden /> {qty(line.totalPrepared)}
                      </span>
                    )}
                    {line.totalRejected > 0 && (
                      <span className="inline-flex items-center gap-1 text-united-danger">
                        <Ban size={13} aria-hidden /> {qty(line.totalRejected)}
                      </span>
                    )}
                    <span className={remaining > 0 ? "text-amber-600" : "text-emerald-600"}>
                      {t("picking.remaining-qty", { qty: qty(remaining) })}
                    </span>
                  </div>
                  <span className="text-sm font-bold text-united-muted">
                    {t("picking.customers-count", { count: allocationSet.size })}
                  </span>
                  <span className="text-united-muted">
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </div>
              </button>

              {/* Progress bar */}
              <div className="h-2 rounded-full bg-united-dark/10 overflow-hidden mt-2 mb-2">
                <div
                  className={`h-full ${
                    prepPct >= 100
                      ? "bg-emerald-500"
                      : "bg-amber-500"
                  }`}
                  style={{ width: `${Math.min(100, prepPct)}%` }}
                />
              </div>

              {/* Expanded per-customer allocations */}
              {isExpanded && (
                <div className="mt-3 border-t border-united-dark/5 pt-3 space-y-2">
                  {line.allocations.length === 0 && (
                    <p className="text-sm text-united-dark/40">
                      {t("picking.no-allocations")}
                    </p>
                  )}

                  {/* Column headers */}
                  <div className="grid grid-cols-7 gap-1 text-[11px] font-bold text-united-muted px-2 print:text-gray-500">
                    <span className="col-span-2">{t("picking.col.customer")}</span>
                    <span>{t("picking.col.required")}</span>
                    <span>{t("picking.prepared")}</span>
                    <span>{t("picking.loaded")}</span>
                    <span>{t("picking.remaining")}</span>
                    <span>{t("picking.col.status")}</span>
                  </div>

                  {line.allocations.map((a) => {
                    const allocatedRemaining = Math.max(
                      0,
                      a.requiredQuantity -
                        (a.loadedQuantity ?? a.preparedQuantity ?? 0)
                    );
                    return (
                      <div
                        key={`${a.orderId}-${line.productName}`}
                        className={`rounded-xl p-2 ${
                          a.rejected
                            ? "bg-red-50 border border-red-200"
                            : allocatedRemaining > 0
                            ? "bg-amber-50/50"
                            : "bg-emerald-50/50"
                        }`}
                      >
                        {/* Compact row */}
                        <div className="grid grid-cols-7 gap-1 text-sm items-center">
                          <Link
                            href={`/orders/${a.orderId}`}
                            className="col-span-2 font-bold text-united-dark truncate hover:underline"
                          >
                            {a.customerName}
                          </Link>
                          <span
                            dir="ltr"
                            className="font-bold text-united-dark text-center"
                          >
                            {qty(a.requiredQuantity)}
                          </span>
                          <span
                            dir="ltr"
                            className={`font-bold text-center ${
                              a.preparedQuantity != null
                                ? a.rejected
                                  ? "text-red-500 line-through"
                                  : "text-emerald-600"
                                : "text-united-dark/30"
                            }`}
                          >
                            {a.preparedQuantity != null
                              ? qty(a.preparedQuantity)
                              : "—"}
                          </span>
                          <span
                            dir="ltr"
                            className={`font-bold text-center ${
                              a.loadedQuantity != null
                                ? "text-emerald-600"
                                : "text-united-dark/30"
                            }`}
                          >
                            {a.loadedQuantity != null
                              ? qty(a.loadedQuantity)
                              : "—"}
                          </span>
                          <span
                            dir="ltr"
                            className={`font-bold text-center ${
                              allocatedRemaining > 0
                                ? "text-amber-600"
                                : "text-emerald-600"
                            }`}
                          >
                            {qty(allocatedRemaining)}
                          </span>
                          <span className="text-center">
                            {a.rejected ? (
                              <span className="text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">
                                {t("picking.rejected-badge")}
                              </span>
                            ) : (
                              <span
                                className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                  STATUS_COLOR[a.status] ??
                                  "text-gray-500 bg-gray-50"
                                }`}
                              >
                                {STATUS_LABEL[a.status] ? t(STATUS_LABEL[a.status]) : a.status}
                              </span>
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Print footer */}
      <div className="hidden print:block text-xs text-gray-400 mt-4 text-center">
        {t("picking.footer", { date })}
      </div>
    </div>
  );
}