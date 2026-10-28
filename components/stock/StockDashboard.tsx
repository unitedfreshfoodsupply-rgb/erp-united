"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { StatTile } from "@/components/stock/StatTile";
import { YieldMeter } from "@/components/stock/YieldMeter";
import { QuickIntakeForm } from "@/components/stock/QuickIntakeForm";
import { MovementRow } from "@/components/stock/MovementRow";
import { todayLocalISO } from "@/lib/localDate";
import { fmtKg, fmtYield, YIELD_TONE_CLASS, yieldTone } from "@/lib/stockPresentation";
import type { StockDashboardDTO } from "@/lib/stock-client-types";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

export function StockDashboard() {
  const { t, locale } = useLocale();

  // The tablet's own calendar day, not the server's — a shift that starts before
  // midnight UTC must still file its receipts under the day the operator is living in.
  const today = todayLocalISO();

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["stock", "dashboard", today],
    queryFn: () => apiFetch<StockDashboardDTO>(`/api/stock/dashboard?date=${today}`),
    refetchInterval: 15_000,
  });

  return (
    <div className="page-container max-w-3xl">
      <div className="page-header">
        <h1 className="page-title">{t("stock.page-title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>

      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {[
          { href: "/stock/entries", label: t("stock.nav-intake-list") },
          { href: "/stock/ledger", label: t("stock.nav-ledger") },
          { href: "/stock/setup", label: t("stock.nav-suppliers-products") },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="filter-pill-inactive"
          >
            {l.label}
          </Link>
        ))}
      </div>

      {isLoading && <LoadingState />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}

      {data && (
        <>
          <section className="kpi-grid">
            <StatTile label={t("stock.stat-today-received")} value={fmtKg(data.today.receivedKg)} unit={t("stock.unit-kg")} sub={`${data.today.intakeCount} ${t("stock.stat-intake-count")}`} />
            <StatTile label={t("stock.stat-net-good")} value={fmtKg(data.today.goodKg)} unit={t("stock.unit-kg")} tone="good" />
            <StatTile label={t("stock.stat-sort-rejected")} value={fmtKg(data.today.rejectedKg)} unit={t("stock.unit-kg")} tone={data.today.rejectedKg > 0 ? "warn" : "muted"} />
            <StatTile
              label={t("stock.stat-yield-pct")}
              value={fmtYield(data.today.yieldPct)}
              tone={({ good: "good", warn: "warn", bad: "bad", none: "muted" } as const)[yieldTone(data.today.yieldPct)]}
              sub={data.today.crates > 0 ? `${data.today.crates} ${t("stock.stat-crates")}` : undefined}
            />
          </section>

          <QuickIntakeForm date={today} />

          <section className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-extrabold text-united-dark">{t("stock.current-balance-title")}</h2>
              <span dir="ltr" className="text-lg font-extrabold text-united-green">
                {fmtKg(data.totalStockKg)} {t("stock.unit-kg")}
              </span>
            </div>
            {data.currentStock.length === 0 ? (
              <EmptyState icon="📦" title={t("stock.empty-no-stock-recorded")} />
            ) : (
              <ul className="flex flex-col divide-y divide-united-border">
                {data.currentStock.map((s) => (
                  <li key={s.productId} className="flex items-center justify-between py-2.5">
                    <span className="font-bold text-united-dark">
                      {localName({ name: s.productName, nameAr: s.productNameAr }, locale)}
                      {!s.active && <span className="text-xs font-bold text-united-muted ms-2">{t("stock.suspended-badge")}</span>}
                    </span>
                    <span dir="ltr" className={`font-extrabold ${s.balanceKg > 0 ? "text-united-dark" : "text-united-muted"}`}>
                      {fmtKg(s.balanceKg)} {s.unit}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] font-bold text-united-muted mt-3">
              {t("stock.balance-explanation")}
            </p>
          </section>

          {data.todayByProduct.length > 0 && (
            <section className="card p-4">
              <h2 className="text-lg font-extrabold text-united-dark mb-3">{t("stock.products-today-title")}</h2>
              <ul className="flex flex-col gap-3">
                {data.todayByProduct.map((p) => (
                  <li key={p.productId}>
                    <div className="flex items-center justify-between text-sm font-bold mb-1">
                      <span className="text-united-dark">{localName({ name: p.productName, nameAr: p.productNameAr }, locale)}</span>
                      <span dir="ltr" className="text-united-muted">
                        {fmtKg(p.goodKg)} / {fmtKg(p.receivedKg)} {t("stock.unit-kg")}
                      </span>
                    </div>
                    <YieldMeter pct={p.yieldPct} label={`${p.intakeCount} ${t("stock.stat-intake-count")}`} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="grid sm:grid-cols-2 gap-3">
            <PeriodCard title={t("stock.period-last-7days")} totals={data.week} />
            <PeriodCard title={t("stock.period-this-month")} totals={data.month} />
          </section>

          <section className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-extrabold text-united-dark">{t("stock.supplier-perf-title")}</h2>
              <span className="text-xs font-bold text-united-muted">{t("stock.period-this-month")}</span>
            </div>
            {data.supplierPerformance.length === 0 ? (
              <EmptyState icon="🚚" title={t("stock.empty-no-supplies-month")} />
            ) : (
              <ul className="flex flex-col divide-y divide-united-border">
                {data.supplierPerformance.map((s) => (
                  <li key={s.supplierId} className="py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-extrabold text-united-dark">{localName({ name: s.supplierName, nameAr: s.supplierNameAr }, locale)}</span>
                      <span dir="ltr" className={`font-extrabold ${YIELD_TONE_CLASS[yieldTone(s.yieldPct)]}`}>
                        {fmtYield(s.yieldPct)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs font-bold text-united-muted" dir="ltr">
                      <span>{s.intakeCount} {t("stock.supplier-delivery-unit")}</span>
                      <span>· {fmtKg(s.receivedKg)} {t("stock.supplier-received-unit")}</span>
                      <span>· {fmtKg(s.rejectedKg)} {t("stock.supplier-rejected-unit")}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] font-bold text-united-muted mt-3">
              {t("stock.supplier-perf-note")}
            </p>
          </section>

          <section className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-extrabold text-united-dark">{t("stock.last-movements-title")}</h2>
              <Link href="/stock/ledger" className="text-sm font-extrabold text-united-green">
                {t("stock.full-ledger-link")}
              </Link>
            </div>
            {data.recentMovements.length === 0 ? (
              <EmptyState icon="🧾" title={t("stock.empty-no-movements-yet")} />
            ) : (
              <ul className="flex flex-col divide-y divide-united-border">
                {data.recentMovements.slice(0, 8).map((m) => (
                  <MovementRow key={m.id} movement={m} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function PeriodCard({ title, totals }: { title: string; totals: StockDashboardDTO["week"] }) {
  const { t } = useLocale();
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-extrabold text-united-dark">{title}</h3>
        <span className="text-xs font-bold text-united-muted">{totals.intakeCount} {t("stock.stat-intake-count")}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Metric label={t("stock.stat-label-received")} value={fmtKg(totals.receivedKg)} />
        <Metric label={t("stock.stat-label-good")} value={fmtKg(totals.goodKg)} tone="text-united-green" />
        <Metric label={t("stock.stat-label-rejected")} value={fmtKg(totals.rejectedKg)} tone={totals.rejectedKg > 0 ? "text-united-warn" : "text-united-muted"} />
      </div>
      <YieldMeter pct={totals.yieldPct} />
    </div>
  );
}

function Metric({ label, value, tone = "text-united-dark" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div dir="ltr" className={`text-lg font-extrabold ${tone}`}>
        {value}
      </div>
      <div className="text-[11px] font-bold text-united-muted">{label}</div>
    </div>
  );
}
