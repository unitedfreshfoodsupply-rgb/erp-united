"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, ChartLine } from "lucide-react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { todayLocalISO } from "@/lib/localDate";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState, ErrorState } from "@/components/States";
import { SkeletonLine } from "@/components/Skeleton";
import { ManagementSwitch } from "@/components/management/ManagementSwitch";
import { BarList, ChartCard, ChartTable, ColumnChart, LineChart, ORDINAL, SERIES, useChartFormat } from "@/components/charts/Charts";
import type { ManagementOverview } from "@/lib/management/overview";

const RANGES = { "4w": 4, "12w": 12, "26w": 26 } as const;
type Range = keyof typeof RANGES;

function rangeDates(weeks: number) {
  const to = todayLocalISO();
  const d = new Date(`${to}T00:00:00Z`);
  const sat = new Date(d.getTime() - ((d.getUTCDay() + 1) % 7) * 86_400_000);
  const from = new Date(sat.getTime() - (weeks - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

const n = (v: string | null | undefined) => Number(v ?? 0);

/** Change against the previous period of the same length; `goodWhenUp` decides the tone. */
function Delta({ now, before, goodWhenUp }: { now: number; before: number; goodWhenUp?: boolean }) {
  const { t } = useLocale();
  if (!before) return <span className="text-xs text-united-muted">{t("mgmt.overview.no-previous")}</span>;
  const change = ((now - before) / Math.abs(before)) * 100;
  const up = change >= 0;
  const tone = goodWhenUp === undefined ? "text-united-muted" : up === goodWhenUp ? "text-united-green" : "text-united-danger";
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${tone}`}>
      <Icon size={14} aria-hidden className="rtl:-scale-x-100" />
      <span dir="ltr">{`${up ? "+" : ""}${change.toFixed(1)}%`}</span>
      <span className="font-normal text-united-muted">{t("mgmt.overview.vs-previous")}</span>
    </span>
  );
}

function Kpi({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="kpi-card min-w-0">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value truncate" dir="ltr">{value}</span>
      {children}
    </div>
  );
}

export function OverviewView() {
  const { t, locale } = useLocale();
  const f = useChartFormat();
  const [range, setRange] = useState<Range>("12w");
  const { from, to } = rangeDates(RANGES[range]);
  const q = useQuery({
    queryKey: ["management", "overview", from, to],
    queryFn: () => apiFetch<ManagementOverview>(`/api/management/overview?from=${from}&to=${to}`),
  });
  const egp = (v: number) => `${f.full(v)} ${t("mgmt.overview.egp")}`;
  const kg = (v: number) => `${f.full(v)} ${t("mgmt.overview.kg")}`;
  const BUCKET: Record<string, string> = {
    current: t("mgmt.overview.bucket.current"), d1_30: t("mgmt.overview.bucket.d1_30"), d31_60: t("mgmt.overview.bucket.d31_60"),
    d61_90: t("mgmt.overview.bucket.d61_90"), d90_plus: t("mgmt.overview.bucket.d90_plus"),
  };

  return (
    <div className="page-container">
      <PageHeader title={t("mgmt.overview.title")} description={t("mgmt.overview.description")} actions={<ManagementSwitch current="overview" />} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<Range> label={t("mgmt.overview.range")} value={range} onChange={setRange}
          items={[{ key: "4w", label: t("mgmt.overview.range.4w") }, { key: "12w", label: t("mgmt.overview.range.12w") }, { key: "26w", label: t("mgmt.overview.range.26w") }]} />
        <p className="text-xs text-united-muted" dir="auto">
          {t("mgmt.overview.period", { from: f.week(from), to: f.week(to) })}
        </p>
      </div>

      {q.isLoading && (
        <div aria-busy="true" className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <SkeletonLine key={i} className="h-24 rounded-xl" />)}</div>
          <SkeletonLine className="h-72 rounded-xl" />
          <div className="grid gap-4 lg:grid-cols-2"><SkeletonLine className="h-72 rounded-xl" /><SkeletonLine className="h-72 rounded-xl" /></div>
        </div>
      )}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}

      {q.data && (() => {
        const d = q.data;
        const cur = d.headline.current, prev = d.headline.previous;
        const labels = d.weekly.map((w) => f.week(w.week));
        const sales = d.weekly.map((w) => n(w.sales)), purchases = d.weekly.map((w) => n(w.purchases));
        const grading = [
          { key: "good", label: t("mgmt.overview.grade.good"), color: ORDINAL[0], values: d.weekly.map((w) => n(w.good)) },
          { key: "gradeB", label: t("mgmt.overview.grade.b"), color: ORDINAL[1], values: d.weekly.map((w) => n(w.gradeB)) },
          { key: "waste", label: t("mgmt.overview.grade.waste"), color: ORDINAL[2], values: d.weekly.map((w) => n(w.waste)) },
        ];
        const trend = [
          { key: "sales", label: t("mgmt.overview.sales"), color: SERIES[0], values: sales },
          { key: "purchases", label: t("mgmt.overview.purchases"), color: SERIES[1], values: purchases },
        ];
        const noTrade = sales.every((v) => !v) && purchases.every((v) => !v);
        const noIntake = grading.every((s) => s.values.every((v) => !v));
        return (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Kpi label={t("mgmt.overview.sales")} value={egp(n(cur.sales))}><Delta now={n(cur.sales)} before={n(prev.sales)} goodWhenUp /></Kpi>
              <Kpi label={t("mgmt.overview.purchases")} value={egp(n(cur.purchases))}><Delta now={n(cur.purchases)} before={n(prev.purchases)} /></Kpi>
              <Kpi label={t("mgmt.overview.collected")} value={egp(n(cur.collected))}><Delta now={n(cur.collected)} before={n(prev.collected)} goodWhenUp /></Kpi>
              <Kpi label={t("mgmt.overview.receivables")} value={egp(n(d.receivables.total))}>
                <span className="text-xs text-united-muted">{t("mgmt.overview.overdue")} <span dir="ltr" className={n(d.receivables.overdue) > 0 ? "font-semibold text-united-warn" : ""}>{f.full(n(d.receivables.overdue))}</span></span>
              </Kpi>
              <Kpi label={t("mgmt.overview.payables")} value={egp(n(d.payables.total))}>
                <span className="text-xs text-united-muted">{t("mgmt.overview.overdue")} <span dir="ltr" className={n(d.payables.overdue) > 0 ? "font-semibold text-united-warn" : ""}>{f.full(n(d.payables.overdue))}</span></span>
              </Kpi>
              <Kpi label={t("mgmt.overview.waste-rate")} value={cur.wastePct === null ? "—" : `${cur.wastePct}%`}>
                <span className="text-xs text-united-muted">{t("mgmt.overview.grade-b-rate")} <span dir="ltr">{cur.gradeBPct === null ? "—" : `${cur.gradeBPct}%`}</span></span>
              </Kpi>
            </div>

            <ChartCard title={t("mgmt.overview.trend.title")} subtitle={t("mgmt.overview.trend.subtitle")} legend={trend}
              table={<ChartTable caption={t("mgmt.overview.trend.title")} labels={labels} series={trend} format={f.full} total />}>
              {noTrade ? <EmptyState icon={ChartLine} title={t("mgmt.overview.empty.trade")} /> : <LineChart labels={labels} series={trend} format={egp} label={t("mgmt.overview.trend.title")} />}
            </ChartCard>

            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <ChartCard title={t("mgmt.overview.grading.title")} subtitle={t("mgmt.overview.grading.subtitle")} legend={grading}
                table={<ChartTable caption={t("mgmt.overview.grading.title")} labels={labels} series={grading} format={f.full} total />}>
                {noIntake ? <EmptyState icon={ChartLine} title={t("mgmt.overview.empty.intake")} /> : <ColumnChart stacked labels={labels} series={grading} format={kg} label={t("mgmt.overview.grading.title")} />}
              </ChartCard>
              <ChartCard title={t("mgmt.overview.customers.title")} subtitle={t("mgmt.overview.customers.subtitle")}
                table={
                  <table className="data-table">
                    <caption className="sr-only">{t("mgmt.overview.customers.title")}</caption>
                    <thead><tr><th scope="col">{t("mgmt.overview.customer")}</th><th scope="col" className="num">{t("mgmt.overview.invoices")}</th><th scope="col" className="num">{t("mgmt.overview.sales")}</th></tr></thead>
                    <tbody>{d.topCustomers.map((c) => <tr key={c.customerId}><th scope="row" className="font-medium">{localName({ name: c.nameEn, nameAr: c.nameAr, code: c.code }, locale)}</th><td className="num" dir="ltr">{c.invoices}</td><td className="num" dir="ltr">{f.full(n(c.net))}</td></tr>)}</tbody>
                  </table>
                }>
                {d.topCustomers.length === 0 ? <EmptyState icon={ChartLine} title={t("mgmt.overview.empty.customers")} /> : (
                  <BarList format={egp} rows={d.topCustomers.map((c) => ({ key: c.customerId, label: localName({ name: c.nameEn, nameAr: c.nameAr, code: c.code }, locale), value: n(c.net), hint: t("mgmt.overview.invoice-count", { count: c.invoices }) }))} />
                )}
              </ChartCard>
            </div>

            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              {([["receivables", d.receivables], ["payables", d.payables]] as const).map(([k, a]) => (
                <ChartCard key={k} title={t(`mgmt.overview.${k}.title`)} subtitle={t("mgmt.overview.aging.subtitle", { date: f.week(a.asOf) })}
                  table={
                    <table className="data-table">
                      <caption className="sr-only">{t(`mgmt.overview.${k}.title`)}</caption>
                      <thead><tr><th scope="col">{t("mgmt.overview.age")}</th><th scope="col" className="num">{t("mgmt.overview.amount")}</th></tr></thead>
                      <tbody>{a.buckets.map((b) => <tr key={b.bucket}><th scope="row" className="font-medium">{BUCKET[b.bucket]}</th><td className="num" dir="ltr">{f.full(n(b.amount))}</td></tr>)}</tbody>
                      <tfoot>
                        {n(a.onAccount) > 0 && <tr><th scope="row">{t(`mgmt.overview.on-account.${k}`)}</th><td className="num" dir="ltr">−{f.full(n(a.onAccount))}</td></tr>}
                        <tr><th scope="row">{t("viz.total")}</th><td className="num" dir="ltr">{f.full(n(a.total))}</td></tr>
                      </tfoot>
                    </table>
                  }
                  footer={
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-united-muted">
                      {n(a.onAccount) > 0 && <span>{t(`mgmt.overview.on-account.${k}`)}: <span dir="ltr" className="font-semibold text-united-dark">−{egp(n(a.onAccount))}</span></span>}
                      <span>{t("viz.total")}: <span dir="ltr" className="font-semibold text-united-dark">{egp(n(a.total))}</span></span>
                    </p>
                  }>
                  <BarList format={egp} rows={a.buckets.map((b) => ({ key: b.bucket, label: BUCKET[b.bucket], value: n(b.amount) }))} />
                </ChartCard>
              ))}
            </div>
          </>
        );
      })()}
    </div>
  );
}
