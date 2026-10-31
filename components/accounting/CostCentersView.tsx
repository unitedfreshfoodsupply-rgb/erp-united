"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";

/**
 * Cost centers: the warehouses, transport, vehicles, operations and departments that
 * expenses are analysed by, and the report of revenue and expenses per center (its totals
 * are the P&L's; what carries no center is shown as unallocated).
 */

type CostCenter = { id: string; code: string; name: string; nameAr: string; kind: string; parentId: string | null; active: boolean; version: number };
const KINDS = ["warehouse", "transport", "vehicle", "operations", "department", "administration", "sales", "other"] as const;

export function useCostCenters() {
  return useQuery({ queryKey: ["cost-centers"], queryFn: () => apiFetch<{ costCenters: CostCenter[] }>("/api/accounting/cost-centers").then((r) => r.costCenters), staleTime: 60_000 });
}

/** Optional cost center for an expense line: "none" unless the setting requires one (the server decides). */
export function CostCenterSelect({ value, onChange, className = "field", ariaLabel }: { value: string; onChange: (id: string) => void; className?: string; ariaLabel?: string }) {
  const { t, locale } = useLocale();
  const q = useCostCenters();
  return (
    <select className={className} aria-label={ariaLabel ?? t("cc.field")} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("cc.none")}</option>
      {(q.data ?? []).filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{localName(c, locale)}</option>)}
    </select>
  );
}

export function CostCentersView() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["acc", "cost-centers", "all"], queryFn: () => apiFetch<{ costCenters: CostCenter[] }>("/api/accounting/cost-centers?all=1").then((r) => r.costCenters) });
  const [f, setF] = useState({ code: "", name: "", name_ar: "", kind: "warehouse", parent_id: "" });
  const [range, setRange] = useState({ from: `${todayLocalISO().slice(0, 7)}-01`, to: todayLocalISO() });
  const report = useQuery({ queryKey: ["acc", "cost-center-report", range], queryFn: () => apiFetch<{ report: { centers: { costCenter: { id: string; code: string; name: string; nameAr: string; kind: string } | null; revenue: string; expenses: string; net: string; lines: { accountId: string; code: string; name: string; nameAr: string; type: string; amount: string }[] }[]; totals: { revenue: string; expenses: string; unallocatedExpenses: string } } }>(`/api/accounting/cost-centers/report?from=${range.from}&to=${range.to}`).then((r) => r.report) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["acc"] }); void qc.invalidateQueries({ queryKey: ["cost-centers"] }); };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-united-muted">{t("cc.explain")}</p>
      {can("accounting.manage") && (
        <form className="card p-4 grid grid-cols-1 gap-2 sm:grid-cols-5" onSubmit={async (e) => {
          e.preventDefault();
          try { await apiPost("/api/accounting/cost-centers", { ...f, parent_id: f.parent_id || null }); toast.show(t("cc.toast-created"), "success"); setF({ code: "", name: "", name_ar: "", kind: f.kind, parent_id: "" }); refresh(); }
          catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
        }}>
          <Field label={t("chart.col.code")} required><input className="field" dir="ltr" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label={t("treasury.field.name-ar")} required><input className="field" required value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
          <Field label={t("treasury.field.name-en")} required><input className="field" dir="ltr" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t("cc.kind")}><select className="field" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{t(`cc.kind.${k}`)}</option>)}</select></Field>
          <Field label={t("cc.parent")}><select className="field" value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}><option value="">—</option>{list.data?.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{localName(c, locale)}</option>)}</select></Field>
          <div><button type="submit" className="btn-primary">{t("cc.add")}</button></div>
        </form>
      )}
      {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} /> : !list.data?.length ? <EmptyState icon="🏷️" title={t("cc.empty")} /> : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("chart.col.code")}</th><th>{t("cc.field")}</th><th>{t("cc.kind")}</th><th>{t("treasury.col.status")}</th>{can("accounting.manage") && <th><span className="sr-only">{t("treasury.col.actions")}</span></th>}</tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                  <td><bdi dir="ltr">{c.code}</bdi></td><td>{localName(c, locale)}</td><td>{t(`cc.kind.${c.kind}`)}</td>
                  <td>{c.active ? <StatusPill tone="success">{t("cc.active")}</StatusPill> : <StatusPill tone="neutral">{t("treasury.inactive")}</StatusPill>}</td>
                  {can("accounting.manage") && <td><button type="button" className={c.active ? "btn-danger btn-sm" : "btn-secondary btn-sm"} onClick={async () => {
                    try { await apiPatch(`/api/accounting/cost-centers/${c.id}`, { active: !c.active, version: c.version }); refresh(); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
                  }}>{t(c.active ? "treasury.deactivate" : "treasury.activate")}</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="flex flex-col gap-2" aria-labelledby="cc-report">
        <h2 id="cc-report" className="section-title">{t("cc.report")}</h2>
        <div className="card p-3 flex flex-wrap gap-2 items-end">
          <Field label={t("vat.period-from")}><input type="date" className="field" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label={t("vat.period-to")}><input type="date" className="field" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        </div>
        {report.isLoading ? <LoadingState /> : report.isError ? <ErrorState message={errorMessage(report.error)} onRetry={() => report.refetch()} /> : !report.data?.centers.length ? <EmptyState icon="📊" title={t("cc.report-empty")} /> : (
          <div className="card overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>{t("cc.field")}</th><th className="num">{t("periods.revenue")}</th><th className="num">{t("periods.expenses")}</th><th className="num">{t("periods.net-result")}</th></tr></thead>
              <tbody>
                {report.data.centers.map((g) => (
                  <tr key={g.costCenter?.id ?? "none"}>
                    <td>{g.costCenter ? localName(g.costCenter, locale) : <span className="text-united-warn font-bold">{t("cc.unallocated")}</span>}</td>
                    <td className="num" dir="ltr">{fmtMoney(g.revenue)}</td><td className="num" dir="ltr">{fmtMoney(g.expenses)}</td><td className="num" dir="ltr">{fmtMoney(g.net)}</td>
                  </tr>
                ))}
                <tr className="font-extrabold"><td>{t("mgmt.cf.table.row.total")}</td><td className="num" dir="ltr">{fmtMoney(report.data.totals.revenue)}</td><td className="num" dir="ltr">{fmtMoney(report.data.totals.expenses)}</td><td /></tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
