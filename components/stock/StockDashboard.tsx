"use client";

import { unitLabel } from "@/lib/format";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
    // A new day is a new key: the last figures stay on screen until the new day's arrive
    // instead of the page blanking at midnight (UXO-9).
    placeholderData: keepPreviousData,
  });

  return (
    <div className="page-container max-w-3xl">
      <div className="page-header">
        <h1 className="page-title">{t("stock.page-title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} stale={isError && !!data} />
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

      {/* The receiving form loads its own lists: it is there at once, and stays usable when
          the dashboard figures are slow or fail (UXO-9). */}
      <QuickIntakeForm date={today} />

      {isLoading && <LoadingState />}
      {isError && !data && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}

      {data && (
        <>
          <section className="kpi-grid">
            <UnitStatTile label={t("stock.stat-today-received")} byUnit={data.today.byUnit} pick={(u) => u.received} sub={`${data.today.intakeCount} ${t("stock.stat-intake-count")}`} />
            <UnitStatTile label={t("stock.stat-net-good")} byUnit={data.today.byUnit} pick={(u) => u.good} tone="good" />
            <UnitStatTile label={t("stock.stat-sort-rejected")} byUnit={data.today.byUnit} pick={(u) => u.rejected} tone={data.today.rejectedKg > 0 ? "warn" : "muted"} />
            <YieldStatTile label={t("stock.stat-yield-pct")} byUnit={data.today.byUnit} sub={data.today.crates > 0 ? `${data.today.crates} ${t("stock.stat-crates")}` : undefined} />
          </section>

          <section className="card p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="text-lg font-extrabold text-united-dark">{t("stock.current-balance-title")}</h2>
              {/* One total per unit (UXO-10): kg and pieces are never added together. */}
              <span dir="ltr" className="text-lg font-extrabold text-united-green text-end">
                {data.stockTotalsByUnit.length > 0 ? perUnit(data.stockTotalsByUnit, (u) => u.balance) : `0 ${unitLabel("KG")}`}
              </span>
            </div>
            {data.currentStock.length === 0 ? (
              <EmptyState icon="📦" title={t("stock.empty-no-stock-recorded")} />
            ) : (
              <ul className="flex flex-col divide-y divide-united-border">
                {data.currentStock.map((s) => {
                  // ARC-5: what can be sold is the main figure (the inventory module's rule);
                  // the ledger balance, and what it holds that is not for sale, under it.
                  const sell = data.sellable?.[s.productId];
                  const differs = !!sell && sell.available !== s.balanceKg;
                  return (
                    <li key={s.productId} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="font-bold text-united-dark">
                        {localName({ name: s.productName, nameAr: s.productNameAr }, locale)}
                        {!s.active && <span className="text-xs font-bold text-united-muted ms-2">{t("stock.suspended-badge")}</span>}
                      </span>
                      {sell ? (
                        <span className="flex flex-col items-end text-end">
                          <span className="font-extrabold">
                            <span className="text-xs font-bold text-united-muted">{t("stock.available-label")} </span>
                            <span dir="ltr" className={sell.available > 0 ? "text-united-dark" : "text-united-muted"}>
                              {fmtKg(sell.available)} {unitLabel(s.unit)}
                            </span>
                          </span>
                          {differs && (
                            <span className="text-xs font-bold text-united-muted">
                              {[
                                t("stock.balance-on-hand", { qty: fmtKg(s.balanceKg) }),
                                sell.reserved !== 0 ? t("stock.balance-reserved", { qty: fmtKg(sell.reserved) }) : null,
                                sell.unsellable !== 0 ? t("stock.balance-unsellable", { qty: fmtKg(sell.unsellable) }) : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span dir="ltr" className={`font-extrabold ${s.balanceKg > 0 ? "text-united-dark" : "text-united-muted"}`}>
                          {fmtKg(s.balanceKg)} {unitLabel(s.unit)}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[11px] font-bold text-united-muted mt-3">
              {t("stock.balance-explanation")}
            </p>
            {data.sellable && (
              <p className="text-[11px] font-bold text-united-muted mt-1">
                {t("stock.available-explanation")}{" "}
                <Link href="/stock/inventory" className="inline-flex min-h-10 items-center font-extrabold text-united-green">
                  {t("stock.available-details-link")}
                </Link>
              </p>
            )}
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
                        {fmtKg(p.goodKg)} / {fmtKg(p.receivedKg)} {unitLabel(p.unit)}
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
              <Link href="/stock/ledger" className="inline-flex min-h-10 items-center text-sm font-extrabold text-united-green">
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
        <Metric label={t("stock.stat-label-received")} value={perUnitOrZero(totals.byUnit, (u) => u.received)} />
        <Metric label={t("stock.stat-label-good")} value={perUnitOrZero(totals.byUnit, (u) => u.good)} tone="text-united-green" />
        <Metric label={t("stock.stat-label-rejected")} value={perUnitOrZero(totals.byUnit, (u) => u.rejected)} tone={totals.rejectedKg > 0 ? "text-united-warn" : "text-united-muted"} />
      </div>
      {/* Yield per unit (UXO-10): one ratio over kg and pieces together means nothing. */}
      {totals.byUnit.length > 1 ? (
        totals.byUnit.map((u) => <YieldMeter key={u.unit} pct={u.yieldPct} label={`${t("stock.yield-percentage")} · ${unitLabel(u.unit)}`} />)
      ) : (
        <YieldMeter pct={totals.byUnit[0]?.yieldPct ?? null} />
      )}
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

type UnitRow = StockDashboardDTO["today"]["byUnit"][number];

/** "300 كجم · 200 قطعة": one figure per unit, never one sum across units (UXO-10). */
function perUnit<U extends { unit: string }>(rows: readonly U[], pick: (u: U) => number) {
  return rows.map((u) => `${fmtKg(pick(u))} ${unitLabel(u.unit)}`).join(" · ");
}

function perUnitOrZero(rows: readonly UnitRow[], pick: (u: UnitRow) => number) {
  return rows.length > 0 ? perUnit(rows, pick) : `0 ${unitLabel("KG")}`;
}

/** Yield per unit, like the other tiles: the first unit's ratio as the figure (with its unit
 * when there are several), the others under it — never one ratio over kg and pieces (UXO-10). */
function YieldStatTile({ label, byUnit, sub }: { label: string; byUnit: readonly UnitRow[]; sub?: string }) {
  const [first, ...rest] = byUnit;
  const pct = first?.yieldPct ?? null;
  const units = rest.length > 0 ? [unitLabel(first.unit), ...rest.map((u) => `${unitLabel(u.unit)} ${fmtYield(u.yieldPct)}`)].join(" · ") : "";
  return (
    <StatTile
      label={label}
      value={fmtYield(pct)}
      tone={({ good: "good", warn: "warn", bad: "bad", none: "muted" } as const)[yieldTone(pct)]}
      sub={[units, sub].filter(Boolean).join(" · ") || undefined}
    />
  );
}

/** A KPI tile per unit: the first unit (kg when there is any) as the figure, the others under it. */
function UnitStatTile({ label, byUnit, pick, sub, tone }: { label: string; byUnit: readonly UnitRow[]; pick: (u: UnitRow) => number; sub?: string; tone?: "default" | "good" | "warn" | "bad" | "muted" }) {
  const [first, ...rest] = byUnit;
  const others = rest.length > 0 ? perUnit(rest, pick) : "";
  return (
    <StatTile
      label={label}
      value={fmtKg(first ? pick(first) : 0)}
      unit={first?.unit ?? "KG"}
      sub={[others, sub].filter(Boolean).join(" · ") || undefined}
      tone={tone}
    />
  );
}
