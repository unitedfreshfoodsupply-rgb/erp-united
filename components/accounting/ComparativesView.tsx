"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";

/**
 * Comparative P&L and balance sheet (this range against the prior period or the same range
 * a year earlier) and the financial ratios at each range's end. The ratio basis is printed
 * under the table: the chart has no current/non-current split, so liabilities are all taken
 * as current and current assets are every asset except fixed assets.
 */

type Line = { accountId: string; code: string; name: string; nameAr: string; type: string; current: string; comparison: string; variance: string; variancePct: string | null };
type Ratios = Record<"grossMarginPct" | "netMarginPct" | "currentRatio" | "quickRatio" | "cashRatio" | "debtToEquity" | "workingCapital" | "receivableDays" | "inventoryDays" | "payableDays", string | null>;
type Report = {
  basis: string; current: { from: string; to: string }; comparison: { from: string; to: string };
  profitAndLoss: { lines: Line[]; current: Record<string, string>; comparison: Record<string, string> };
  balanceSheet: { lines: Line[]; current: Record<string, string | boolean>; comparison: Record<string, string | boolean> };
  ratios: { current: Ratios; comparison: Ratios };
};

const RATIO_KEYS: (keyof Ratios)[] = ["grossMarginPct", "netMarginPct", "currentRatio", "quickRatio", "cashRatio", "debtToEquity", "workingCapital", "receivableDays", "inventoryDays", "payableDays"];

export function ComparativesView() {
  const { t, locale } = useLocale();
  const today = todayLocalISO();
  const [f, setF] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today, compare: "prior_year" });
  const q = useQuery({ queryKey: ["acc", "comparatives", f], queryFn: () => apiFetch<{ report: Report }>(`/api/accounting/comparatives?from=${f.from}&to=${f.to}&compare=${f.compare}`).then((r) => r.report) });
  const r = q.data;
  const fmtRatio = (k: keyof Ratios, v: string | null) => (v === null ? "—" : k === "workingCapital" ? fmtMoney(v) : k.endsWith("Pct") ? `${v}%` : k.endsWith("Days") ? `${v} ${t("cmp.days")}` : v);
  const table = (lines: Line[], totals?: [string, string, string][]) => (
    <div className="card overflow-x-auto">
      <table className="data-table">
        <thead><tr><th>{t("chart.col.code")}</th><th>{t("mgmt.is.head.account")}</th><th className="num">{t("cmp.current")}</th><th className="num">{t("cmp.comparison")}</th><th className="num">{t("cmp.variance")}</th><th className="num">%</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.accountId}>
              <td><bdi dir="ltr">{l.code}</bdi></td><td>{localName(l, locale)}</td>
              <td className="num" dir="ltr">{fmtMoney(l.current)}</td><td className="num" dir="ltr">{fmtMoney(l.comparison)}</td>
              <td className={`num ${Number(l.variance) < 0 ? "text-united-danger" : ""}`} dir="ltr">{fmtMoney(l.variance)}</td><td className="num" dir="ltr">{l.variancePct === null ? "—" : `${l.variancePct}%`}</td>
            </tr>
          ))}
          {totals?.map(([label, a, b]) => (
            <tr key={label} className="font-extrabold"><td /><td>{label}</td><td className="num" dir="ltr">{fmtMoney(a)}</td><td className="num" dir="ltr">{fmtMoney(b)}</td><td className="num" dir="ltr">{fmtMoney(String(Number(a) - Number(b)))}</td><td /></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="card p-3 flex flex-wrap gap-2 items-end">
        <Field label={t("vat.period-from")}><input type="date" className="field" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label={t("vat.period-to")}><input type="date" className="field" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label={t("cmp.compare-with")}>
          <select className="field" value={f.compare} onChange={(e) => setF({ ...f, compare: e.target.value })}>
            <option value="prior_year">{t("cmp.prior_year")}</option>
            <option value="prior_period">{t("cmp.prior_period")}</option>
          </select>
        </Field>
        {r && <p className="text-xs text-united-muted">{t("cmp.ranges", { a: `${r.current.from} – ${r.current.to}`, b: `${r.comparison.from} – ${r.comparison.to}` })}</p>}
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !r ? <EmptyState icon="📊" title={t("cmp.empty")} /> : (
        <>
          <section className="flex flex-col gap-2" aria-labelledby="cmp-ratios">
            <h2 id="cmp-ratios" className="section-title">{t("cmp.ratios")}</h2>
            <div className="card overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>{t("cmp.ratio")}</th><th className="num">{t("cmp.current")}</th><th className="num">{t("cmp.comparison")}</th></tr></thead>
                <tbody>{RATIO_KEYS.map((k) => <tr key={k}><td>{t(`cmp.ratio.${k}`)}</td><td className="num" dir="ltr">{fmtRatio(k, r.ratios.current[k])}</td><td className="num" dir="ltr">{fmtRatio(k, r.ratios.comparison[k])}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="text-xs text-united-muted">{t("cmp.ratio-basis")}</p>
          </section>
          <section className="flex flex-col gap-2" aria-labelledby="cmp-pl">
            <h2 id="cmp-pl" className="section-title">{t("cmp.pl")}</h2>
            {table(r.profitAndLoss.lines, [[t("periods.revenue"), r.profitAndLoss.current.revenue, r.profitAndLoss.comparison.revenue], [t("cmp.gross-profit"), r.profitAndLoss.current.grossProfit, r.profitAndLoss.comparison.grossProfit], [t("periods.expenses"), r.profitAndLoss.current.expenses, r.profitAndLoss.comparison.expenses], [t("periods.net-result"), r.profitAndLoss.current.netIncome, r.profitAndLoss.comparison.netIncome]])}
          </section>
          <section className="flex flex-col gap-2" aria-labelledby="cmp-bs">
            <h2 id="cmp-bs" className="section-title">{t("cmp.bs", { a: r.current.to, b: r.comparison.to })}</h2>
            {table(r.balanceSheet.lines, [[t("cmp.assets"), String(r.balanceSheet.current.assets), String(r.balanceSheet.comparison.assets)], [t("cmp.liabilities"), String(r.balanceSheet.current.liabilities), String(r.balanceSheet.comparison.liabilities)], [t("cmp.equity"), String(r.balanceSheet.current.equity), String(r.balanceSheet.comparison.equity)]])}
          </section>
        </>
      )}
    </div>
  );
}
