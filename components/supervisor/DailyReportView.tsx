"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import type { DailyReportDTO } from "@/lib/client-types";
import { LoadingState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { STATUS_LABEL, STATUS_DOT } from "@/lib/orderPresentation";
import { qty } from "@/lib/format";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/types";
import { useLocale } from "@/lib/locale";
import { OperationalHealthBanner } from "./OperationalHealthBanner";
import { NeedsAttentionQueue } from "./NeedsAttentionQueue";

const OPEN_ORDER: OrderStatus[] = ["new", "preparing", "ready_for_loading", "loading", "loaded"];

export function DailyReportView() {
  const { t, locale } = useLocale();
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["report", "daily"],
    queryFn: () => apiFetch<DailyReportDTO>("/api/reports/daily"),
    refetchInterval: 8000,
  });

  return (
    <div className="p-4 max-w-3xl mx-auto pb-10">
      <Link href="/supervisor" className="inline-flex items-center gap-1 text-united-muted font-bold mb-3">
        <span>→</span>{t("supervisor.back-to-dashboard")}
      </Link>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold text-united-dark">{t("supervisor.daily-title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>
      {data && <p className="text-united-muted font-bold mb-4">{data.date}</p>}

      {isLoading && <LoadingState />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}

      {data && (
        <>
          <div className="no-print flex justify-end mb-3">
            <a
              href={`/supervisor/report/print${locale === "en" ? "?lang=en" : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-sm px-4 py-2"
            >
              🖨️{t("supervisor.print-report")}
            </a>
          </div>

          <div className="mb-5">
            <OperationalHealthBanner health={data.health} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="card p-4 text-center">
              <div className="text-3xl font-extrabold text-united-dark">{data.ordersReceivedToday}</div>
              <div className="text-xs font-bold text-united-muted mt-1">{t("supervisor.orders-received-today")}</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-3xl font-extrabold text-united-green">{data.dispatchedToday}</div>
              <div className="text-xs font-bold text-united-muted mt-1">{t("supervisor.dispatched-today")}</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-3xl font-extrabold text-united-danger">{data.exceptionsActive}</div>
              <div className="text-xs font-bold text-united-muted mt-1">{t("supervisor.exceptions-needing-attention")}</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-3xl font-extrabold text-united-dark">
                {data.completionPct != null ? `${data.completionPct}%` : "—"}
              </div>
              <div className="text-xs font-bold text-united-muted mt-1">{t("supervisor.completion-rate")}</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-3xl font-extrabold text-united-warn">{data.stalledCount}</div>
              <div className="text-xs font-bold text-united-muted mt-1">{t("supervisor.stalled-orders")}</div>
            </div>
          </div>

          <div className="card p-5 mb-4">
            <h2 className="font-extrabold text-united-dark mb-3">{t("supervisor.active-pipeline-all-days")}</h2>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {OPEN_ORDER.map((s) => (
                <div key={s} className="border border-united-border rounded-lg p-2 text-center">
                  <div className="text-xl font-extrabold text-united-dark">{data.pipelineNow[s] ?? 0}</div>
                  <div className="text-xs font-bold text-united-muted flex items-center justify-center gap-1">
                    <span>{STATUS_DOT[s]}</span> {STATUS_LABEL[s]}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {data.bottleneck.byStage.length > 0 && (
            <div className="card p-5 mb-4">
              <h2 className="font-extrabold text-united-dark mb-1">{t("supervisor.bottleneck-location")}</h2>
              <p className="text-xs text-united-muted mb-3">
                {t("supervisor.bottleneck-calc-note")}
              </p>
              <div className="flex flex-col gap-2">
                {data.bottleneck.byStage.map((b) => (
                  <div
                    key={b.status}
                    className={`flex items-center justify-between rounded-lg border p-2 ${
                      b.status === data.bottleneck.currentBottleneckStage
                        ? "border-united-warn/40 bg-amber-50/50"
                        : "border-united-border"
                    }`}
                  >
                    <span className="font-bold text-united-dark flex items-center gap-1.5">
                      <span>{STATUS_DOT[b.status]}</span>
                      {STATUS_LABEL[b.status]}
                      {b.status === data.bottleneck.currentBottleneckStage && (
                        <span className="text-xs font-bold text-united-warn">{t("supervisor.current-bottleneck-hint")}</span>
                      )}
                    </span>
                    <span className="text-sm text-united-muted font-bold">
                      <span dir="ltr">{b.count}</span>{t("supervisor.bottleneck-stats-order")} · {t("supervisor.bottleneck-stats-avg")}{" "}
                      <span dir="ltr">{b.avgMinutes}</span> {t("supervisor.bottleneck-stats-minutes")} · {t("supervisor.bottleneck-stats-longest")}{" "}<span dir="ltr">{b.maxMinutes}</span> {t("supervisor.bottleneck-stats-minutes")}
                    </span>
                  </div>
                ))}
              </div>
              {data.bottleneck.mostStalledOrder && (
                <Link
                  href={`/orders/${data.bottleneck.mostStalledOrder.id}`}
                  className="text-sm font-bold text-united-green mt-3 inline-block"
                >
                  ⏸️{t("supervisor.most-stalled-prefix")} {data.bottleneck.mostStalledOrder.customerName} ({data.bottleneck.mostStalledOrder.orderNumber}) —{" "}<span dir="ltr">{data.bottleneck.mostStalledOrder.minutesInStage}</span> {t("supervisor.most-stalled-suffix")}
                </Link>
              )}
            </div>
          )}

          <div className="mb-4">
            <NeedsAttentionQueue items={data.needsAttention} />
            {data.needsAttentionTotal > data.needsAttention.length && (
              <p className="text-xs text-united-muted mt-2">
                + {data.needsAttentionTotal - data.needsAttention.length}{t("supervisor.needs-attention-extra")}{" "}<Link href="/supervisor" className="text-united-green font-bold">{t("supervisor.see-all-link")}</Link>
              </p>
            )}
          </div>

          <div className="card p-5 mb-4">
            <h2 className="font-extrabold text-united-dark mb-3">{t("supervisor.today-status-title")}</h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {ORDER_STATUSES.map((s) => (
                <div key={s} className="border border-united-border rounded-lg p-2 text-center">
                  <div className="text-xl font-extrabold text-united-dark">{data.byStatusToday[s] ?? 0}</div>
                  <div className="text-xs font-bold text-united-muted flex items-center justify-center gap-1">
                    <span>{STATUS_DOT[s]}</span> {STATUS_LABEL[s]}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5 mb-4">
            <h2 className="font-extrabold text-united-dark mb-3">{t("supervisor.quantities-title")}</h2>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div dir="ltr" className="text-2xl font-extrabold text-united-dark">{qty(data.quantitiesToday.required)}</div>
                <div className="text-xs font-bold text-united-muted">{t("supervisor.qty-required")}</div>
              </div>
              <div className="text-center">
                <div dir="ltr" className="text-2xl font-extrabold text-united-dark">{qty(data.quantitiesToday.prepared)}</div>
                <div className="text-xs font-bold text-united-muted">{t("supervisor.qty-prepared")}</div>
              </div>
              <div className="text-center">
                <div dir="ltr" className="text-2xl font-extrabold text-united-dark">{qty(data.quantitiesToday.loaded)}</div>
                <div className="text-xs font-bold text-united-muted">{t("supervisor.qty-loaded")}</div>
              </div>
            </div>
            <p className="text-[11px] text-united-dark/40 mt-2">
              {t("supervisor.qty-footer")}
            </p>
          </div>

          {data.exceptionsInformational > 0 && (
            <p className="text-sm text-united-muted mb-2">
              + {data.exceptionsInformational}{t("supervisor.info-exceptions-existing")}{" "}
              <Link href="/supervisor/exceptions" className="text-united-green font-bold">{t("supervisor.info-exceptions-link")}</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
