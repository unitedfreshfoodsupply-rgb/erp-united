"use client";

import { useState } from "react";
import { Ban, Check, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { todayLocalISO } from "@/lib/localDate";
import { qty, unitLabel } from "@/lib/format";
import type { DailySheetDTO } from "@/lib/picking-sheet";
import { useLocale } from "@/lib/locale";
import { localName, orderCustomerName } from "@/lib/locale/names";

// Dictionary keys, translated at render.
const STATUS_LABEL: Record<string, string> = {
  new: "picking.status.new",
  preparing: "picking.status.preparing",
  ready_for_loading: "picking.status.ready_for_loading",
  loading: "picking.status.loading",
};

// The order-status tones of StatusBadge, as the kit's pills (AA text on their fills).
const STATUS_COLOR: Record<string, string> = {
  new: "pill-info",
  preparing: "pill-warn",
  ready_for_loading: "pill-success",
  loading: "pill-warn",
};

export function PickingSheet() {
  const { t, locale } = useLocale();
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
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} stale={isError && !!data} />
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

        {/* Filter chips — the kit's chip: the pressed state is announced, not colour only (A11Y-7). */}
        <div className="flex flex-wrap gap-1">
          {(["all", "pending", "done", "rejected"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filterPrepStatus === f}
              onClick={() => setFilterPrepStatus(f)}
              className="chip"
            >
              {t(`picking.filter.${f}`)}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => window.print()}
          className="btn-secondary text-xs px-3 py-1.5 ms-auto"
        >
          {t("picking.print")}
        </button>
      </div>

      {isLoading && <LoadingState />}
      {isError && !data && (
        <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />
      )}
      {data && lines.length === 0 && (
        <EmptyState icon="📦" title={t("picking.empty")} />
      )}

      {/* Summary bar — per unit (UXO-10): kg and pieces are never added together. Printed in
          ink on white, since browsers leave background colours out of a printout. */}
      {summary && lines.length > 0 && (
        <div className="bg-united-dark text-white rounded-2xl p-4 mb-4 flex flex-wrap items-start gap-x-6 gap-y-3 print:bg-white print:text-united-dark print:border print:border-gray-300">
          <SummaryFigure label={t("picking.orders")} value={String(summary.orderCount)} />
          {summary.byUnit.map((u) => (
            <div key={u.unit} className="flex flex-wrap gap-x-6 gap-y-2">
              <SummaryFigure label={t("picking.required")} value={qty(u.totalRequired)} unit={u.unit} />
              <SummaryFigure label={t("picking.prepared")} value={qty(u.totalPrepared)} unit={u.unit} tone="text-emerald-300" />
              <SummaryFigure label={t("picking.approved")} value={qty(u.totalApproved)} unit={u.unit} tone="text-emerald-300" />
              <SummaryFigure label={t("picking.loaded")} value={qty(u.totalLoaded)} unit={u.unit} tone="text-emerald-300" />
              <SummaryFigure label={t("picking.remaining")} value={qty(u.totalRemaining)} unit={u.unit} tone={u.totalRemaining > 0 ? "text-amber-300" : "text-emerald-300"} />
            </div>
          ))}
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
          // Product and unit: the same product ordered in kg and in crates is two cards (UXO-13).
          const cardKey = `${line.productKey}__${line.unit}`;
          const isExpanded = expandedProduct === cardKey;
          const allocationSet = new Set(
            line.allocations.map((a) => a.orderId)
          );

          return (
            <div
              key={cardKey}
              className={`card p-4 border-2 ${
                line.totalRemaining > 0
                  ? "border-[#F3D9AE]"
                  : "border-[#C3E2CC]"
              } print:border-gray-300 print:shadow-none print:break-inside-avoid`}
            >
              {/* Product header */}
              <button
                type="button"
                aria-expanded={isExpanded}
                className="w-full text-start flex items-center justify-between gap-2"
                onClick={() =>
                  setExpandedProduct(
                    isExpanded ? null : cardKey
                  )
                }
              >
                <div>
                  <span className="text-lg font-extrabold text-united-dark">
                    {line.productNameEn ? localName({ name: line.productNameEn, nameAr: line.productNameAr }, locale) : line.productName}
                  </span>
                  <span className="text-xs text-united-muted ms-2">
                    {unitLabel(line.unit)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 min-w-0">
                  {/* Mini quantity summary — printed too: the required total is what the
                      picker works from (UXO-6). */}
                  <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs font-bold">
                    <span className="text-united-dark">
                      {t("picking.required-qty", { qty: qty(line.totalRequired) })}
                    </span>
                    {line.totalPrepared > 0 && (
                      <span className="inline-flex items-center gap-1 text-united-green">
                        <Check size={13} aria-hidden /><span className="sr-only">{t("picking.prepared")}</span> {qty(line.totalPrepared)}
                      </span>
                    )}
                    {line.totalRejected > 0 && (
                      <span className="inline-flex items-center gap-1 text-united-danger">
                        <Ban size={13} aria-hidden /><span className="sr-only">{t("picking.rejected-badge")}</span> {qty(line.totalRejected)}
                      </span>
                    )}
                    <span className={remaining > 0 ? "text-united-warn" : "text-united-green"}>
                      {t("picking.remaining-qty", { qty: qty(remaining) })}
                    </span>
                  </div>
                  <span className="text-sm font-bold text-united-muted">
                    {t("picking.customers-count", { count: allocationSet.size })}
                  </span>
                  <ChevronDown size={18} aria-hidden className={`shrink-0 text-united-muted transition-transform print:hidden ${isExpanded ? "rotate-180" : ""}`} />
                </div>
              </button>

              {/* Progress bar */}
              <div className="h-2 rounded-full bg-united-dark/10 overflow-hidden mt-2 mb-2">
                <div
                  className={`h-full ${
                    prepPct >= 100
                      ? "bg-united-green"
                      : "bg-united-warn"
                  }`}
                  style={{ width: `${Math.min(100, prepPct)}%` }}
                />
              </div>

              {/* Per-customer allocations: on screen for the expanded product, on paper for
                  every product (UXO-6) — a printed sheet is what the warehouse picks from. */}
                <div className={`mt-3 border-t border-united-dark/5 pt-3 space-y-2 ${isExpanded ? "" : "hidden print:block"}`}>
                  {line.allocations.length === 0 && (
                    <p className="text-sm text-united-muted">
                      {t("picking.no-allocations")}
                    </p>
                  )}

                  {/* Seven columns do not fit a phone: the grid keeps a
                      minimum width and scrolls sideways instead of
                      running the figures into each other. */}
                  <div className="overflow-x-auto">
                    <div className="min-w-[34rem] space-y-2">
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
                            key={`${a.orderId}-${line.productKey}`}
                            className={`rounded-xl p-2 ${
                              a.rejected
                                ? "bg-[#FDECEA] border border-[#F5C6C1]"
                                : allocatedRemaining > 0
                                ? "bg-[#FDF3E2]"
                                : "bg-[#E7F3EA]"
                            }`}
                          >
                            {/* Compact row */}
                            <div className="grid grid-cols-7 gap-1 text-sm items-center">
                              <Link
                                href={`/orders/${a.orderId}`}
                                className="col-span-2 font-bold text-united-dark truncate hover:underline"
                              >
                                {orderCustomerName(a, locale)}
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
                                      ? "text-united-danger line-through"
                                      : "text-united-green"
                                    : "text-united-muted"
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
                                    ? "text-united-green"
                                    : "text-united-muted"
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
                                    ? "text-united-warn"
                                    : "text-united-green"
                                }`}
                              >
                                {qty(allocatedRemaining)}
                              </span>
                              <span className="text-center">
                                {a.rejected ? (
                                  <span className="pill-danger">
                                    {t("picking.rejected-badge")}
                                  </span>
                                ) : (
                                  <span
                                    className={
                                      STATUS_COLOR[a.status] ??
                                      "pill-neutral"
                                    }
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
                  </div>
                </div>
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

function SummaryFigure({ label, value, unit, tone = "" }: { label: string; value: string; unit?: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs text-white/60 font-bold print:text-gray-600">{label}</div>
      <div dir="ltr" className={`text-xl font-extrabold ${tone} print:text-united-dark`}>
        {value}
        {unit && <span className="text-sm font-bold text-white/70 print:text-gray-600"> {unitLabel(unit)}</span>}
      </div>
    </div>
  );
}
