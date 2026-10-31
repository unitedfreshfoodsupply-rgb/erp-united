"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, errorMessage } from "@/lib/api-client";
import { ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { fmtMoney } from "@/components/stock/inventory/shared";

/**
 * Months and fiscal years: close a month, close a year (its result moves to retained
 * earnings), and ask for a closed month or year to be reopened — a request a different
 * person approves from the approvals inbox, with the reason kept in the audit log.
 */

type Period = { id: string; code: string; status: string; closedBy: string | null; reopenCount: number; reopenedBy: string | null; reopenReason: string | null };
type Year = { code: string; startDate: string; endDate: string; status: string; closedBy: string | null; netIncome: string | null; closeCount: number; reopenedBy: string | null; reopenReason: string | null };
type Preview = { code: string; netIncome: string; revenue: string; expenses: string; lines: { code: string; name: string; nameAr: string; balance: string }[]; problems: { code: string; params?: Record<string, string> }[]; warnings: { code: string; params?: Record<string, string> }[] };

export function PeriodsView() {
  const { can } = usePermissions();
  const { t } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [previewOf, setPreviewOf] = useState<string | null>(null);
  const periods = useQuery({ queryKey: ["acc", "periods"], queryFn: () => apiFetch<{ periods: Period[] }>("/api/accounting/periods").then((r) => r.periods) });
  const years = useQuery({ queryKey: ["acc", "fiscal-years"], queryFn: () => apiFetch<{ years: Year[] }>("/api/accounting/fiscal-years").then((r) => r.years) });
  const preview = useQuery({ queryKey: ["acc", "fiscal-year", previewOf], queryFn: () => apiFetch<{ year: Preview }>(`/api/accounting/fiscal-years/${previewOf}`).then((r) => r.year), enabled: !!previewOf });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["acc"] });
  const run = async (path: string, body: unknown, done: string) => {
    try { await apiPost(path, body); toast.show(done, "success"); refresh(); return true; }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); return false; }
  };
  const askReopen = async (path: string, title: string) => {
    const reason = await dialogs.prompt({ title, label: t("periods.reopen-reason"), required: true, multiline: true, tone: "danger", confirmLabel: t("periods.request-reopen") });
    if (reason) await run(path, { reason }, t("periods.toast-reopen-requested"));
  };
  if (periods.isLoading || years.isLoading) return <LoadingState />;
  if (periods.isError || years.isError) return <ErrorState message={errorMessage(periods.error ?? years.error)} onRetry={() => { void periods.refetch(); void years.refetch(); }} />;
  const p = preview.data;
  return (
    <div className="flex flex-col gap-4">
      {can("accounting.manage") && (
        <section className="card p-4 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => run("/api/accounting/stock-valuation", {}, t("accounting-toast-stock-valued"))}>{t("accounting.button.post-stock-val")}</button>
          <button type="button" className="btn-secondary" onClick={() => run("/api/accounting/sync", {}, t("accounting-toast-docs-synced"))}>{t("accounting.button.sync-docs")}</button>
        </section>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="fy-title">
        <h2 id="fy-title" className="section-title">{t("periods.years-title")}</h2>
        <ul className="flex flex-col gap-2">
          {(years.data ?? []).map((y) => (
            <li key={y.code} className="card p-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-extrabold"><bdi dir="ltr">{y.code}</bdi> <span className="text-sm font-bold text-united-muted"><bdi dir="ltr">{y.startDate} – {y.endDate}</bdi></span></div>
                {y.status === "closed" ? <div className="text-sm text-united-muted">{t("periods.year-closed-by", { by: y.closedBy ?? "" })} · {t("periods.net-result")} <bdi dir="ltr">{fmtMoney(y.netIncome ?? "0")}</bdi></div>
                  : y.reopenedBy ? <div className="text-sm text-united-muted">{t("periods.reopened-by", { by: y.reopenedBy })}{y.reopenReason ? ` — ${y.reopenReason}` : ""}</div> : null}
              </div>
              <div className="flex items-center gap-2">
                <StatusPill tone={y.status === "closed" ? "neutral" : "success"}>{t(y.status === "closed" ? "periods.status.closed" : "periods.status.open")}</StatusPill>
                {y.status === "open" && can("accounting.periods.close") && <button type="button" className="btn-secondary btn-sm" onClick={() => setPreviewOf(previewOf === y.code ? null : y.code)}>{t("periods.close-year")}</button>}
                {y.status === "closed" && can("accounting.periods.close") && <button type="button" className="btn-danger btn-sm" onClick={() => askReopen(`/api/accounting/fiscal-years/${y.code}/reopen`, t("periods.reopen-year-title", { code: y.code }))}>{t("periods.request-reopen")}</button>}
              </div>
              {previewOf === y.code && (
                <div className="basis-full flex flex-col gap-2 border-t border-united-border pt-2">
                  {preview.isLoading || !p ? <LoadingState /> : (
                    <>
                      <dl className="grid grid-cols-3 gap-2 text-sm">
                        <div><dt className="font-bold text-united-muted">{t("periods.revenue")}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(p.revenue)}</dd></div>
                        <div><dt className="font-bold text-united-muted">{t("periods.expenses")}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(p.expenses)}</dd></div>
                        <div><dt className="font-bold text-united-muted">{t("periods.net-result")}</dt><dd className={`font-extrabold ${Number(p.netIncome) < 0 ? "text-united-danger" : ""}`} dir="ltr">{fmtMoney(p.netIncome)}</dd></div>
                      </dl>
                      <p className="text-sm text-united-muted">{t("periods.close-explain")}</p>
                      {p.warnings.length > 0 && <ul className="text-sm font-bold text-united-warn">{p.warnings.map((x) => <li key={x.code}>{t(`periods.problem.${x.code}`, x.params ?? {})}</li>)}</ul>}
                      {p.problems.length > 0 && <ul className="text-sm font-bold text-united-danger">{p.problems.map((x) => <li key={x.code}>{t(`periods.problem.${x.code}`, x.params ?? {})}</li>)}</ul>}
                      <div><button type="button" className="btn-danger" disabled={p.problems.length > 0} onClick={async () => {
                        if (!(await dialogs.confirm({ title: t("periods.confirm-close-year", { code: y.code }), body: t("periods.confirm-close-year-body", { net: fmtMoney(p.netIncome) }), tone: "danger", confirmLabel: t("periods.close-year") }))) return;
                        if (await run(`/api/accounting/fiscal-years/${y.code}/close`, {}, t("periods.toast-year-closed", { code: y.code }))) setPreviewOf(null);
                      }}>{t("periods.close-year")}</button></div>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="months-title">
        <h2 id="months-title" className="section-title">{t("periods.months-title")}</h2>
        <ul className="flex flex-col gap-2">
          {(periods.data ?? []).map((m) => (
            <li key={m.id} className="card p-3 flex flex-wrap justify-between items-center gap-2 font-bold">
              <span dir="ltr">{m.code}</span>
              <span className={m.status === "open" ? "text-united-green" : "text-united-muted"}>
                {m.status === "open" ? t("accounting.period.open") : t("accounting.period.closed", { by: m.closedBy ?? "" })}
                {m.reopenCount > 0 && <span className="block text-xs font-normal text-united-muted">{t("periods.reopened-times", { n: String(m.reopenCount), by: m.reopenedBy ?? "" })}</span>}
              </span>
              {m.status === "open" && can("accounting.periods.close") && <button type="button" className="btn-danger btn-sm" onClick={() => run(`/api/accounting/periods/${m.code}/close`, {}, t("accounting-toast-period-closed", { code: m.code }))}>{t("accounting.button.close")}</button>}
              {m.status === "closed" && can("accounting.periods.close") && <button type="button" className="btn-secondary btn-sm" onClick={() => askReopen(`/api/accounting/periods/${m.code}/reopen`, t("periods.reopen-month-title", { code: m.code }))}>{t("periods.request-reopen")}</button>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
