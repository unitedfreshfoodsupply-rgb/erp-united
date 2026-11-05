"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Info } from "lucide-react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { formatNumber } from "@/lib/format";
import { todayLocalISO } from "@/lib/localDate";
import { usePermissions } from "@/lib/use-session";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorState, LoadingState } from "@/components/States";

type Profit = { revenue: string; costOfSales: string; grossProfit: string; operatingExpenses: string; otherIncome: string; netProfit: string; grossMarginPct: string | null };
type Produce = { receivedKg: string; goodKg: string; gradeBKg: string; wasteKg: string; wastePct: string | null; wasteValue: string | null };
type CC = {
  period: { from: string; to: string; prevFrom: string; prevTo: string };
  profit?: { current: Profit; previous: Profit };
  purchases?: { current: string; previous: string };
  receivables?: { total: string; overdue: string };
  payables?: { total: string; overdue: string };
  upcomingPayments?: { bills: number; total: string; until: string };
  cash?: { cash: string; bank: string; total: string };
  openingBalancesComplete?: boolean;
  produce?: { current: Produce; previous: Produce };
  inventory?: { value: string | null; lowStock: number; expiringLots: number; openExceptions: number };
  orders?: { byStatus: Record<string, number>; late: number; needsReview: number; dispatchedInPeriod: number };
  approvals: Record<string, number>;
};

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const STAGES = ["new", "preparing", "ready_for_loading", "loading", "loaded"] as const;

/**
 * Management command center (maturity 2026-11): the business for a period on one page —
 * profit from the ledger, money position, operations, produce, stock and approvals —
 * each figure defined, compared with the previous period of the same length, and linked
 * to the records behind it.
 */
export function CommandCenter() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const qs = sp.toString();
  const q = useQuery({ queryKey: ["command-center", qs], queryFn: () => apiFetch<CC>(`/api/management/command-center${qs ? `?${qs}` : ""}`), placeholderData: keepPreviousData, refetchInterval: 120_000 });
  const today = todayLocalISO();
  const setPeriod = (from: string, to: string) => router.replace(`${pathname}?${new URLSearchParams({ from, to })}`, { scroll: false });
  const money = (v: string | number | null | undefined) => `${formatNumber(v ?? 0, { maxDp: 0 })} ${locale === "en" ? "EGP" : "ج.م"}`;
  const d = q.data;
  const per = d ? `from=${d.period.from}&to=${d.period.to}` : "";
  const [y, m] = today.split("-").map(Number);
  const lastMonth = [new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10)];

  return (
    <div className="page-container">
      <PageHeader title={t("cc.title")} description={t("cc.description")} />
      <section className="flex flex-wrap items-end gap-2" aria-label={t("reports.presets")}>
        {([[t("reports.preset.this-month"), `${today.slice(0, 7)}-01`, today], [t("reports.preset.last-month"), lastMonth[0], lastMonth[1]], [t("reports.preset.last-30"), new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10), today], [t("reports.preset.this-year"), `${today.slice(0, 4)}-01-01`, today]] as const).map(([label, from, to]) => (
          <button key={label} type="button" className="chip !min-h-[36px] text-xs" aria-pressed={d?.period.from === from && d?.period.to === to} onClick={() => setPeriod(from, to)}>{label}</button>
        ))}
        {/* Each date range is its own left-to-right run (LRI…PDI), so in Arabic neither range is
            reordered by the words around it; the line itself follows the page direction. */}
        {d && <span className="ms-auto text-xs text-united-muted"><bdi dir="ltr">{d.period.from} → {d.period.to}</bdi> · {t("cc.compared", { range: `\u2066${d.period.prevFrom} → ${d.period.prevTo}\u2069` })}</span>}
      </section>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {d && (
        <div className="flex flex-col gap-4">
          {d.openingBalancesComplete === false && (
            <p className="card flex items-start gap-2 border-s-4 !border-s-united-warn p-3 text-sm font-semibold text-united-warn" role="status"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {t("cc.opening-incomplete")}</p>
          )}
          {d.profit && (
            <section aria-labelledby="cc-pl">
              <h2 id="cc-pl" className="section-title mb-2">{t("cc.pl")}</h2>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Tile label={t("cc.revenue")} def={t("cc.def.revenue")} value={money(d.profit.current.revenue)} cur={n(d.profit.current.revenue)} prev={n(d.profit.previous.revenue)} href={`/reports/sales-by-period?${per}`} />
                <Tile label={t("cc.gross-profit")} def={t("cc.def.gross-profit")} value={money(d.profit.current.grossProfit)} sub={[t("cc.cost-of-sales", { amount: money(d.profit.current.costOfSales) }), d.profit.current.grossMarginPct ? t("cc.margin", { pct: d.profit.current.grossMarginPct }) : null].filter(Boolean).join(" · ")} cur={n(d.profit.current.grossProfit)} prev={n(d.profit.previous.grossProfit)} href={`/reports/sales-by-product?${per}`} />
                <Tile label={t("cc.opex")} def={t("cc.def.opex")} value={money(d.profit.current.operatingExpenses)} cur={n(d.profit.current.operatingExpenses)} prev={n(d.profit.previous.operatingExpenses)} upIsBad href={`/management?${per}`} />
                <Tile label={t("cc.net-profit")} def={t("cc.def.net-profit")} value={money(d.profit.current.netProfit)} cur={n(d.profit.current.netProfit)} prev={n(d.profit.previous.netProfit)} strong href={`/management?${per}`} />
              </div>
              {Number(d.profit.current.otherIncome) !== 0 && <p className="mt-2 text-xs text-united-muted">{t("cc.other-income", { amount: money(d.profit.current.otherIncome) })}</p>}
            </section>
          )}
          {(d.cash || d.receivables) && (
            <section aria-labelledby="cc-money">
              <h2 id="cc-money" className="section-title mb-2">{t("cc.money")}</h2>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {d.purchases && <Tile label={t("cc.purchases")} def={t("cc.def.purchases")} value={money(d.purchases.current)} cur={n(d.purchases.current)} prev={n(d.purchases.previous)} upIsBad href={`/reports/purchases-by-supplier?${per}`} />}
                {d.cash && <Tile label={t("home.money.cash-bank")} def={t("home.def.cash")} value={money(d.cash.total)} sub={`${t("home.money.cash")} ${money(d.cash.cash)} · ${t("home.money.bank")} ${money(d.cash.bank)}`} href="/reports/cash-movements" />}
                {d.receivables && <Tile label={t("mgmt.overview.receivables")} def={t("home.def.receivables")} value={money(d.receivables.total)} sub={n(d.receivables.overdue) > 0 ? `${t("home.sales.overdue")} ${money(d.receivables.overdue)}` : undefined} tone={n(d.receivables.overdue) > 0 ? "danger" : undefined} href="/reports/outstanding-invoices" />}
                {d.payables && <Tile label={t("home.money.payables")} def={t("home.def.payables")} value={money(d.payables.total)} sub={[n(d.payables.overdue) > 0 ? `${t("home.sales.overdue")} ${money(d.payables.overdue)}` : null, d.upcomingPayments && d.upcomingPayments.bills > 0 ? t("cc.due-week", { amount: money(d.upcomingPayments.total), count: String(d.upcomingPayments.bills) }) : null].filter(Boolean).join(" · ") || undefined} tone={n(d.payables.overdue) > 0 ? "warn" : undefined} href="/purchasing?tab=bills&btab=payables" />}
              </div>
            </section>
          )}
          <div className="grid gap-4 lg:grid-cols-3">
            {d.orders && (
              <section className="card flex flex-col gap-3 p-4" aria-labelledby="cc-ops">
                {/* The board and these reports are reports.view's: anyone else (an accountant, who reads
                    orders) sees the counts without links that would only say "access denied". */}
                <Head id="cc-ops" title={t("cc.operations")} href={can("reports.view") ? "/supervisor" : undefined} />
                <ol className="grid grid-cols-5 gap-1 text-center">
                  {STAGES.map((s) => (
                    <li key={s} className="rounded-lg bg-united-subtle px-1 py-2">
                      <span className="num block text-lg font-bold" dir="ltr" style={{ textAlign: "center" }}>{d.orders!.byStatus[s] ?? 0}</span>
                      <span className="block text-[11px] leading-tight text-united-muted">{t(`orders.status.${s}`)}</span>
                    </li>
                  ))}
                </ol>
                <ul className="flex flex-col divide-y divide-united-border text-sm">
                  <Row label={t("cc.dispatched")} value={d.orders.dispatchedInPeriod} href={can("reports.view") ? `/reports/dispatch-activity?${per}` : undefined} />
                  {/* Late is "as of now" (any open order past its date), so the link covers every date up to today, not the period. */}
                  <Row label={t("cc.late")} value={d.orders.late} hot href={can("reports.view") ? `/reports/delayed-orders?from=2000-01-01&to=${today}` : undefined} />
                  <Row label={t("cc.review")} value={d.orders.needsReview} hot href={can("reports.view") ? "/supervisor/exceptions" : undefined} />
                </ul>
              </section>
            )}
            {d.produce && (() => {
              const c = d.produce!.current;
              const total = n(c.goodKg) + n(c.gradeBKg) + n(c.wasteKg);
              const parts = [{ k: "good", v: n(c.goodKg), cls: "bg-[var(--viz-good)]" }, { k: "gradeB", v: n(c.gradeBKg), cls: "bg-[var(--viz-gradeb)]" }, { k: "waste", v: n(c.wasteKg), cls: "bg-[var(--viz-waste)]" }];
              return (
                <section className="viz card flex flex-col gap-3 p-4" aria-labelledby="cc-produce">
                  <Head id="cc-produce" title={t("cc.produce")} href={`/reports/waste-trend?${per}&group_by=week`} />
                  <p className="text-sm text-united-muted">{t("cc.received-kg", { kg: formatNumber(c.receivedKg, { maxDp: 0 }) })}</p>
                  {total > 0 && <div className="flex h-3 overflow-hidden rounded-full bg-united-subtle" role="img" aria-label={parts.map((p) => `${t(`home.produce.${p.k}`)} ${formatNumber(p.v, { maxDp: 1 })}`).join("، ")}>{parts.map((p) => p.v > 0 && <span key={p.k} className={p.cls} style={{ width: `${(p.v / total) * 100}%` }} />)}</div>}
                  <ul className="flex flex-col divide-y divide-united-border text-sm">
                    <Row label={t("cc.waste-rate")} value={c.wastePct === null ? "—" : `${c.wastePct}%`} hot={n(c.wastePct) > 5} sub={d.produce!.previous.wastePct ? t("cc.prev", { v: `${d.produce!.previous.wastePct}%` }) : undefined} href={`/reports/goods-received?${per}`} />
                    {c.wasteValue !== null && <Row label={t("cc.waste-value")} value={money(c.wasteValue)} href={`/reports/supplier-performance?${per}`} />}
                  </ul>
                </section>
              );
            })()}
            {d.inventory && (
              <section className="card flex flex-col gap-3 p-4" aria-labelledby="cc-stock">
                <Head id="cc-stock" title={t("cc.stock")} href="/reports/stock-by-product" />
                {d.inventory.value !== null && <p className="num whitespace-normal break-words text-xl font-bold sm:text-2xl" dir="ltr" style={{ textAlign: "start" }}>{money(d.inventory.value)}</p>}
                <ul className="flex flex-col divide-y divide-united-border text-sm">
                  <Row label={t("home.stock.low")} value={d.inventory.lowStock} hot href="/reports/low-stock" />
                  <Row label={t("cc.expiring")} value={d.inventory.expiringLots} hot href="/reports/expiry?days=3" />
                  {/* Every open exception, whenever it was raised: the inventory screen's list of them. */}
                  <Row label={t("home.stock.exceptions")} value={d.inventory.openExceptions} hot href="/stock/inventory?tab=exceptions" />
                </ul>
              </section>
            )}
          </div>
          {Object.keys(d.approvals).length > 0 && (
            <section className="card flex flex-col gap-2 p-4" aria-labelledby="cc-appr">
              <Head id="cc-appr" title={t("cc.approvals")} href="/approvals" />
              <ul className="flex flex-wrap gap-2">
                {Object.entries(d.approvals).map(([type, count]) => (
                  <li key={type}><Link href={`/approvals?type=${encodeURIComponent(type)}`} className="filter-pill-inactive">{t(`approvals.type.${type}`) === `approvals.type.${type}` ? t("cc.approval.other") : t(`approvals.type.${type}`)} <span className="num rounded-full bg-united-warn/10 px-2 text-united-warn" dir="ltr">{count}</span></Link></li>
                ))}
              </ul>
            </section>
          )}
          <p className="inline-flex items-start gap-1.5 text-xs text-united-muted"><Info size={14} className="mt-0.5 shrink-0" aria-hidden /> {t("cc.notes")}</p>
        </div>
      )}
    </div>
  );
}

function Head({ id, title, href }: { id: string; title: string; href?: string }) {
  const { t } = useLocale();
  return (
    <header className="flex items-center justify-between">
      <h2 id={id} className="section-title">{title}</h2>
      {href && <Link href={href} className="inline-flex items-center gap-1 text-xs font-semibold text-united-green hover:underline">{t("cc.details")} <ArrowLeft size={12} className="ltr:rotate-180" aria-hidden /></Link>}
    </header>
  );
}

/** A count and what it is; a link to its records when the viewer can open them, plain otherwise. */
function Row({ label, value, href, hot, sub }: { label: string; value: string | number; href?: string; hot?: boolean; sub?: string }) {
  const on = hot && typeof value === "number" ? value > 0 : !!hot;
  const body = (
    <>
      <span className="text-united-muted">{label}{sub && <span className="block text-xs">{sub}</span>}</span>
      <span className={`num rounded-full px-2.5 py-0.5 font-semibold ${on ? "bg-united-warn/10 text-united-warn" : "bg-united-subtle text-united-dark"}`} dir="ltr">{typeof value === "number" ? value.toLocaleString("en-US") : value}</span>
    </>
  );
  return (
    <li>
      {href
        ? <Link href={href} className="flex min-h-[44px] items-center justify-between gap-2 py-2 hover:text-united-green">{body}</Link>
        : <div className="flex min-h-[44px] items-center justify-between gap-2 py-2">{body}</div>}
    </li>
  );
}

/** A KPI: its value, what it means (title + screen-reader text), the change on the previous period, and where its records are. */
function Tile({ label, def, value, sub, cur, prev, href, upIsBad, strong, tone }: { label: string; def?: string; value: string; sub?: string; cur?: number; prev?: number; href: string; upIsBad?: boolean; strong?: boolean; tone?: "danger" | "warn" }) {
  const { t } = useLocale();
  const change = cur !== undefined && prev !== undefined && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
  const good = change === null ? null : upIsBad ? change <= 0 : change >= 0;
  return (
    <Link href={href} title={def} className={`card-hoverable flex min-w-0 flex-col gap-1 p-4 ${strong ? "border-united-green/40" : ""}`}>
      <span className="text-xs font-medium text-united-muted">{label}{def && <span className="sr-only"> — {def}</span>}</span>
      {/* Smaller below sm and free to wrap between the amount and the currency, so a 7-digit figure stays inside a phone-width tile. */}
      <span className={`num whitespace-normal break-words text-xl font-bold sm:text-2xl ${tone === "danger" ? "text-united-danger" : tone === "warn" ? "text-united-warn" : "text-united-dark"}`} dir="ltr" style={{ textAlign: "start" }}>{value}</span>
      {sub && <span className="text-xs text-united-muted">{sub}</span>}
      {change !== null && <span className={`text-xs font-semibold ${good ? "text-united-green" : "text-united-danger"}`} dir="ltr" style={{ textAlign: "start" }}>{`${change >= 0 ? "+" : ""}${change.toFixed(1)}%`} <span className="font-normal text-united-muted">{t("cc.vs-prev")}</span></span>}
    </Link>
  );
}
