"use client";

import Link from "next/link";
import { ArrowRight, Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import type { DailyReportDTO } from "@/lib/client-types";
import { LoadingState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { STATUS_LABEL, STATUS_LABEL_EN } from "@/lib/orderPresentation";
import { ORDER_DOT } from "@/components/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { qty } from "@/lib/format";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/types";
import { useLocale } from "@/lib/locale";
import { OperationalHealthBanner } from "./OperationalHealthBanner";
import { NeedsAttentionQueue } from "./NeedsAttentionQueue";

const OPEN_ORDER: OrderStatus[] = ["new", "preparing", "ready_for_loading", "loading", "loaded"];

export function DailyReportView() {
  const { t, locale } = useLocale();
  const label = (s: OrderStatus) => (locale === "en" ? STATUS_LABEL_EN[s] : STATUS_LABEL[s]);
  const Dot = ({ s, top }: { s: OrderStatus; top?: boolean }) => <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${top ? "mt-1" : ""} ${ORDER_DOT[s]}`} />;
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["report", "daily"],
    queryFn: () => apiFetch<DailyReportDTO>("/api/reports/daily"),
    refetchInterval: 8000,
  });

  return (
    <div className="page-narrow">
      <PageHeader
        back={{ href: "/supervisor", label: t("supervisor.back-to-dashboard") }}
        title={t("supervisor.daily-title")}
        description={data ? <span dir="ltr">{data.date}</span> : undefined}
        actions={
          <>
            <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
            {data && (
              <a href={`/supervisor/report/print${locale === "en" ? "?lang=en" : ""}`} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm no-print gap-1.5">
                <Printer size={16} aria-hidden />{t("supervisor.print-report")}
              </a>
            )}
          </>
        }
      />

      {isLoading && <LoadingState />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}

      {data && (
        <>
          <OperationalHealthBanner health={data.health} />

          {/* Five figures in one row from tablet up — no orphan tile on its own line. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="card p-4">
              <div className="text-2xl font-bold text-united-dark">{data.ordersReceivedToday}</div>
              <div className="mt-1 text-xs font-medium leading-snug text-united-muted">{t("supervisor.orders-received-today")}</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-united-green">{data.dispatchedToday}</div>
              <div className="mt-1 text-xs font-medium leading-snug text-united-muted">{t("supervisor.dispatched-today")}</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-united-danger">{data.exceptionsActive}</div>
              <div className="mt-1 text-xs font-medium leading-snug text-united-muted">{t("supervisor.exceptions-needing-attention")}</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-united-dark">
                {data.completionPct != null ? `${data.completionPct}%` : "—"}
              </div>
              <div className="mt-1 text-xs font-medium leading-snug text-united-muted">{t("supervisor.completion-rate")}</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-united-warn">{data.stalledCount}</div>
              <div className="mt-1 text-xs font-medium leading-snug text-united-muted">{t("supervisor.stalled-orders")}</div>
            </div>
          </div>

          <div className="card p-5">
            <h2 className="section-title mb-3">{t("supervisor.active-pipeline-all-days")}</h2>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {OPEN_ORDER.map((s) => (
                <div key={s} className="border border-united-border rounded-lg p-2 text-center">
                  <div className="text-xl font-bold text-united-dark">{data.pipelineNow[s] ?? 0}</div>
                  <div className="flex items-start justify-center gap-1.5 text-xs font-medium leading-snug text-united-muted">
                    <Dot s={s} top /> {label(s)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {data.bottleneck.byStage.length > 0 && (
            <div className="card p-5">
              <h2 className="section-title mb-1">{t("supervisor.bottleneck-location")}</h2>
              <p className="text-xs text-united-muted mb-3">
                {t("supervisor.bottleneck-calc-note")}
              </p>
              <div className="flex flex-col gap-2">
                {data.bottleneck.byStage.map((b) => (
                  <div
                    key={b.status}
                    className={`flex items-center justify-between rounded-lg border p-2 ${
                      b.status === data.bottleneck.currentBottleneckStage
                        ? "border-[#F3D9AE] bg-[#FFFBF3]"
                        : "border-united-border"
                    }`}
                  >
                    <span className="font-bold text-united-dark flex items-center gap-1.5">
                      <Dot s={b.status} />
                      {label(b.status)}
                      {b.status === data.bottleneck.currentBottleneckStage && (
                        <span className="text-xs font-bold text-united-warn">{t("supervisor.current-bottleneck-hint")}</span>
                      )}
                    </span>
                    <span className="text-sm text-united-muted font-bold">
                      <span dir="ltr">{b.count}</span> {t("supervisor.bottleneck-stats-order")} · {t("supervisor.bottleneck-stats-avg")}{" "}
                      <span dir="ltr">{b.avgMinutes}</span> {t("supervisor.bottleneck-stats-minutes")} · {t("supervisor.bottleneck-stats-longest")}{" "}<span dir="ltr">{b.maxMinutes}</span> {t("supervisor.bottleneck-stats-minutes")}
                    </span>
                  </div>
                ))}
              </div>
              {data.bottleneck.mostStalledOrder && (
                <Link
                  href={`/orders/${data.bottleneck.mostStalledOrder.id}`}
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-united-green hover:underline"
                >
                  {t("supervisor.most-stalled-prefix")} {data.bottleneck.mostStalledOrder.customerName} ({data.bottleneck.mostStalledOrder.orderNumber}) —{" "}<span dir="ltr">{data.bottleneck.mostStalledOrder.minutesInStage}</span> {t("supervisor.most-stalled-suffix")}
                  <ArrowRight size={15} className="rtl:rotate-180" aria-hidden />
                </Link>
              )}
            </div>
          )}

          <div>
            <NeedsAttentionQueue items={data.needsAttention} />
            {data.needsAttentionTotal > data.needsAttention.length && (
              <p className="text-xs text-united-muted mt-2">
                + {data.needsAttentionTotal - data.needsAttention.length} {t("supervisor.needs-attention-extra")}{" "}<Link href="/supervisor" className="text-united-green font-bold">{t("supervisor.see-all-link")}</Link>
              </p>
            )}
          </div>

          <div className="card p-5">
            <h2 className="section-title mb-3">{t("supervisor.today-status-title")}</h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {ORDER_STATUSES.map((s) => (
                <div key={s} className="border border-united-border rounded-lg p-2 text-center">
                  <div className="text-xl font-bold text-united-dark">{data.byStatusToday[s] ?? 0}</div>
                  <div className="flex items-start justify-center gap-1.5 text-xs font-medium leading-snug text-united-muted">
                    <Dot s={s} top /> {label(s)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <h2 className="section-title mb-3">{t("supervisor.quantities-title")}</h2>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div dir="ltr" className="text-2xl font-bold text-united-dark">{qty(data.quantitiesToday.required)}</div>
                <div className="text-xs font-medium text-united-muted">{t("supervisor.qty-required")}</div>
              </div>
              <div className="text-center">
                <div dir="ltr" className="text-2xl font-bold text-united-dark">{qty(data.quantitiesToday.prepared)}</div>
                <div className="text-xs font-medium text-united-muted">{t("supervisor.qty-prepared")}</div>
              </div>
              <div className="text-center">
                <div dir="ltr" className="text-2xl font-bold text-united-dark">{qty(data.quantitiesToday.loaded)}</div>
                <div className="text-xs font-medium text-united-muted">{t("supervisor.qty-loaded")}</div>
              </div>
            </div>
            <p className="mt-2 text-xs text-united-muted">
              {t("supervisor.qty-footer")}
            </p>
          </div>

          {data.exceptionsInformational > 0 && (
            <p className="text-sm text-united-muted mb-2">
              + {data.exceptionsInformational} {t("supervisor.info-exceptions-existing")}{" "}
              <Link href="/supervisor/exceptions" className="text-united-green font-bold">{t("supervisor.info-exceptions-link")}</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
