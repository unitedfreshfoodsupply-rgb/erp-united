"use client";

import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Calculator, ChevronDown, ChevronUp, FileSpreadsheet, Plus, Send, ShieldCheck } from "lucide-react";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { Modal, useDialogs } from "@/components/ui/Dialog";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { PaymentsPanel, PostingPanel } from "@/components/hr/PayrollPosting";

/**
 * The payroll run workspace (docs/erp/DESIGN_SYSTEM.md §8.4): one month's run, its blocking
 * issues, every payslip with the formula behind each line, holds and recoveries, one-off
 * adjustments, and the approval steps. What a button may do is decided by the server (`run.can`).
 */

type Exception = { severity: "error" | "warning"; code: string; params?: Record<string, string | number>; employees?: number };
type Line = { id: string; code: string; nameAr: string; nameEn: string | null; kind: string; quantity: string | null; rate: string | null; amount: string; sourceType: string; explanation: string | null; ruleSetVersion: number | null };
type Slip = {
  id: string; employeeId: string; inclusion: string; holdReason: string | null; advanceRecoveryRequested: string; gross: string; employeeDeductions: string; employerContributions: string;
  netEntitlement: string; advanceRecovery: string; netPayable: string; exceptions: Exception[] | null; lines: Line[];
  employee: { id: string; code: string; name: string; jobTitle: string | null; department: { name: string } | null };
};
type RunSummary = { id: string; number: string; period: string; status: string; netPayable: string; headcount: number; preparedBy: string; approvedBy: string | null };
type Run = RunSummary & {
  gross: string; employeeDeductions: string; employerContributions: string; advanceRecovery: string; submittedBy: string | null; approvalRequestId: string | null; calculatedAt: string | null;
  calculationHash: string | null; exceptions: Exception[] | null; cancelledReason: string | null; employees: Slip[];
  postedBy: string | null; postingDate: string | null; reversedBy: string | null; reversalReason: string | null;
  snapshots: { sequence: number; calculationHash: string; calculatedBy: string; calculatedAt: string; totals: Record<string, unknown> }[];
  can: { edit: boolean; calculate: boolean; submit: boolean; withdraw: boolean; decide: boolean; reopen: boolean; cancel: boolean; post: boolean; reverse: boolean; pay: boolean; bankFile: boolean };
};

const RUN_TONE: Record<string, Tone> = { draft: "neutral", calculated: "info", pending_approval: "warn", approved: "success", posted: "success", reversed: "danger", cancelled: "neutral" };
const fail = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));

export function PayrollRuns() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "payroll", "runs"], queryFn: () => apiFetch<{ runs: RunSummary[] }>("/api/hr/payroll/runs").then((r) => r.runs) });
  const [open, setOpen] = useState<string | null>(null);
  const [period, setPeriod] = useState(todayLocalISO().slice(0, 7));
  const create = async () => {
    try {
      const r = await apiPost<{ run: { id: string } }>("/api/hr/payroll/runs", { period });
      void qc.invalidateQueries({ queryKey: ["hr", "payroll"] });
      setOpen(r.run.id);
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  if (open) return <RunDetail id={open} onBack={() => setOpen(null)} />;
  return (
    <section className="card overflow-hidden">
      <div className="card-header flex-wrap gap-3">
        <div><h2 className="section-title">{t("pay.runs")}</h2><p className="text-sm text-united-muted">{t("pay.runs_hint")}</p></div>
        {can("hr.payroll.prepare") && (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input type="month" className="field w-auto" max={todayLocalISO().slice(0, 7)} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label={t("pay.period")} />
            <button type="submit" className="btn-primary btn-sm gap-1.5" disabled={!period}><Plus size={16} aria-hidden />{t("pay.run_new")}</button>
          </form>
        )}
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data!.length ? <EmptyState title={t("pay.runs_empty")} /> : (
        <table className="data-table">
          <thead><tr><th>{t("pay.period")}</th><th>{t("pay.number")}</th><th>{t("pay.state")}</th><th className="num">{t("pay.headcount")}</th><th className="num">{t("pay.net_payable")}</th><th>{t("pay.prepared_by")}</th></tr></thead>
          <tbody>
            {q.data!.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-united-subtle" onClick={() => setOpen(r.id)}>
                <td className="font-semibold" dir="ltr">{r.period}</td>
                <td dir="ltr">{r.number}</td>
                <td><StatusPill tone={RUN_TONE[r.status] ?? "neutral"}>{t(`pay.run.${r.status}`)}</StatusPill></td>
                <td className="num" dir="ltr">{r.headcount}</td>
                <td className="num font-semibold" dir="ltr">{fmtMoney(r.netPayable)}</td>
                <td>{r.preparedBy}{r.approvedBy ? ` · ${t("pay.approved_by")} ${r.approvedBy}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function exceptionText(t: (k: string, p?: Record<string, string | number>) => string, e: Exception) {
  const p = { ...(e.params ?? {}) };
  if (p.rule) p.rule = t(`pay.rule.${p.rule}`);
  if (p.role) p.role = t(`pay.role.${p.role}`);
  return t(`pay.ex.${e.code}`, p);
}

function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "payroll", "run", id], queryFn: () => apiFetch<Run>(`/api/hr/payroll/runs/${id}`) });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr"] });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.show(ok, "success"); refresh(); } catch (err) { toast.show(fail(t, err), "error"); } finally { setBusy(false); }
  };
  const withReason = async (title: string, fn: (reason: string) => Promise<unknown>, ok: string) => {
    const reason = await dialogs.prompt({ title, label: t("pay.reason"), required: true });
    if (reason) await act(() => fn(reason), ok);
  };
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const run = q.data;
  const errors = (run.exceptions ?? []).filter((e) => e.severity === "error");
  const warnings = (run.exceptions ?? []).filter((e) => e.severity === "warning");
  const nm = (l: { nameAr: string; nameEn: string | null }) => (isEN ? l.nameEn || l.nameAr : l.nameAr);
  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <div className="card-header flex-wrap gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={onBack}>{t("pay.all_runs")}</button>
            <h2 className="section-title" dir="ltr">{run.number} · {run.period}</h2>
            <StatusPill tone={RUN_TONE[run.status] ?? "neutral"} size="md">{t(`pay.run.${run.status}`)}</StatusPill>
          </div>
          <div className="flex flex-wrap gap-2">
            {run.can.calculate && <button type="button" className="btn-secondary btn-sm gap-1.5" disabled={busy} onClick={() => act(() => apiPost(`/api/hr/payroll/runs/${id}/calculate`, {}), t("pay.calculated"))}><Calculator size={16} aria-hidden />{run.status === "draft" ? t("pay.calculate") : t("pay.recalculate")}</button>}
            {run.can.edit && <button type="button" className="btn-secondary btn-sm" onClick={() => setAdjusting(true)}>{t("pay.adjustments")}</button>}
            {run.can.submit && <button type="button" className="btn-primary btn-sm gap-1.5" disabled={busy} onClick={async () => { if (await dialogs.confirm({ title: t("pay.submit"), body: t("pay.submit_confirm") })) void act(() => apiPost(`/api/hr/payroll/runs/${id}/submit`, {}), t("pay.submitted")); }}><Send size={16} aria-hidden />{t("pay.submit")}</button>}
            {run.can.withdraw && <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => withReason(t("pay.withdraw_run"), (reason) => apiPost(`/api/hr/payroll/runs/${id}/withdraw`, { reason }), t("pay.saved"))}>{t("pay.withdraw_run")}</button>}
            {run.can.decide && run.approvalRequestId && <>
              <button type="button" className="btn-primary btn-sm gap-1.5" disabled={busy} onClick={async () => { if (await dialogs.confirm({ title: t("pay.approve"), body: t("pay.approve_run_confirm", { number: run.number, net: fmtMoney(run.netPayable) }) })) void act(() => apiPost(`/api/approvals/${run.approvalRequestId}/decide`, { decision: "approve" }), t("pay.approved")); }}><ShieldCheck size={16} aria-hidden />{t("pay.approve")}</button>
              <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={() => withReason(t("pay.return"), (comment) => apiPost(`/api/approvals/${run.approvalRequestId}/decide`, { decision: "reject", comment }), t("pay.returned"))}>{t("pay.return")}</button>
            </>}
            {run.can.reopen && <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => withReason(t("pay.reopen"), (reason) => apiPost(`/api/hr/payroll/runs/${id}/reopen`, { reason }), t("pay.saved"))}>{t("pay.reopen")}</button>}
            {run.status !== "draft" && run.status !== "cancelled" && <a className="btn-ghost btn-sm gap-1.5" href={`/api/hr/payroll/runs/${id}/register`}><FileSpreadsheet size={16} aria-hidden />{t("pay.register")}</a>}
            {run.can.cancel && <button type="button" className="btn-ghost btn-sm text-united-danger" disabled={busy} onClick={() => withReason(t("pay.cancel_run"), (reason) => apiPost(`/api/hr/payroll/runs/${id}/cancel`, { reason }), t("pay.saved"))}>{t("pay.cancel_run")}</button>}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-px bg-united-border sm:grid-cols-6">
          {([["pay.headcount", String(run.headcount)], ["pay.gross", fmtMoney(run.gross)], ["pay.deductions", fmtMoney(run.employeeDeductions)], ["pay.employer", fmtMoney(run.employerContributions)], ["pay.recovery", fmtMoney(run.advanceRecovery)], ["pay.net_payable", fmtMoney(run.netPayable)]] as const).map(([k, v]) => (
            <div key={k} className="bg-white px-4 py-3"><dt className="text-xs text-united-muted">{t(k)}</dt><dd className="mt-0.5 text-lg font-bold text-united-dark" dir="ltr">{v}</dd></div>
          ))}
        </dl>
        <div className="px-5 py-2 text-xs text-united-muted">
          {t("pay.prepared_by")} {run.preparedBy}{run.submittedBy ? ` · ${t("pay.submitted_by")} ${run.submittedBy}` : ""}{run.approvedBy ? ` · ${t("pay.approved_by")} ${run.approvedBy}` : ""}
          {run.calculationHash ? <> · <span dir="ltr">#{run.calculationHash.slice(0, 12)}</span></> : null}{run.cancelledReason ? ` · ${run.cancelledReason}` : ""}
        </div>
        {!["approved", "posted", "reversed"].includes(run.status) && <p className="border-t border-united-border bg-united-subtle px-5 py-2 text-xs text-united-muted">{t("pay.no_posting_note")}</p>}
      </section>

      <PostingPanel run={run} />
      <PaymentsPanel run={run} />

      {(errors.length > 0 || warnings.length > 0) && (
        <section className="card p-4">
          <h3 className="mb-2 flex items-center gap-1.5 font-semibold text-united-dark"><AlertTriangle size={16} aria-hidden />{t("pay.issues")}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {errors.map((e, i) => <li key={`e${i}`} className="text-united-danger">● {exceptionText(t, e)}{e.employees ? ` (${t("pay.employees_n", { n: e.employees })})` : ""}</li>)}
            {warnings.map((e, i) => <li key={`w${i}`} className="text-united-warn">● {exceptionText(t, e)}{e.employees ? ` (${t("pay.employees_n", { n: e.employees })})` : ""}</li>)}
          </ul>
        </section>
      )}

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table min-w-[900px]">
            <thead><tr><th className="sticky start-0 z-10 bg-united-subtle">{t("pay.employee")}</th><th className="num">{t("pay.gross")}</th><th className="num">{t("pay.deductions")}</th><th className="num">{t("pay.employer")}</th><th className="num">{t("pay.recovery")}</th><th className="num">{t("pay.net_payable")}</th><th>{t("pay.state")}</th><th /></tr></thead>
            <tbody>
              {run.employees.map((s) => {
                const ex = s.exceptions ?? [];
                const blocked = ex.some((e) => e.severity === "error");
                return (
                  <Fragment key={s.id}>
                    <tr className={s.inclusion === "on_hold" ? "opacity-60" : ""}>
                      <td className="sticky start-0 z-10 bg-white"><div className="font-semibold">{s.employee.name}</div><div className="text-xs text-united-muted"><span dir="ltr">{s.employee.code}</span>{s.employee.department ? ` · ${s.employee.department.name}` : ""}</div></td>
                      <td className="num" dir="ltr">{fmtMoney(s.gross)}</td>
                      <td className="num" dir="ltr">{fmtMoney(s.employeeDeductions)}</td>
                      <td className="num" dir="ltr">{fmtMoney(s.employerContributions)}</td>
                      <td className="num" dir="ltr">{fmtMoney(s.advanceRecovery)}</td>
                      <td className={`num font-semibold ${Number(s.netPayable) < 0 ? "text-united-danger" : ""}`} dir="ltr">{fmtMoney(s.netPayable)}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {s.inclusion === "on_hold" ? <StatusPill tone="warn">{t("pay.on_hold")}</StatusPill> : blocked ? <StatusPill tone="danger">{t("pay.blocked")}</StatusPill> : ex.length ? <StatusPill tone="warn">{t("pay.warnings_n", { n: ex.length })}</StatusPill> : <StatusPill tone="success">{t("pay.ok")}</StatusPill>}
                        </div>
                      </td>
                      <td><button type="button" className="btn-ghost btn-sm" aria-expanded={expanded === s.id} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>{expanded === s.id ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}{t("pay.details")}</button></td>
                    </tr>
                    {expanded === s.id && (
                      <tr>
                        <td colSpan={8} className="bg-united-subtle/40">
                          <SlipDetail runId={id} slip={s} canEdit={run.can.edit} nm={nm} onChanged={refresh} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {run.snapshots.length > 0 && (
        <section className="card p-4 text-sm">
          <h3 className="mb-2 font-semibold text-united-dark">{t("pay.calculations")}</h3>
          <ul className="flex flex-col gap-0.5 text-xs text-united-muted">
            {run.snapshots.map((s) => <li key={s.sequence}>#{s.sequence} · <span dir="ltr">{new Date(s.calculatedAt).toLocaleString("en-GB")} · {s.calculationHash.slice(0, 12)} · {fmtMoney(String(s.totals.netPayable ?? 0))}</span> · {s.calculatedBy}</li>)}
          </ul>
        </section>
      )}
      {adjusting && <AdjustmentsDialog period={run.period} onClose={() => setAdjusting(false)} />}
    </div>
  );
}

function SlipDetail({ runId, slip, canEdit, nm, onChanged }: { runId: string; slip: Slip; canEdit: boolean; nm: (l: { nameAr: string; nameEn: string | null }) => string; onChanged: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const [recovery, setRecovery] = useState(slip.advanceRecoveryRequested);
  const patch = async (body: Record<string, unknown>) => {
    try { await apiPatch(`/api/hr/payroll/runs/${runId}/employees/${slip.employeeId}`, body); toast.show(t("pay.saved_recalc"), "info"); onChanged(); } catch (err) { toast.show(fail(t, err), "error"); }
  };
  return (
    <div className="flex flex-col gap-3 py-2">
      {(slip.exceptions ?? []).length > 0 && (
        <ul className="text-sm">{slip.exceptions!.map((e, i) => <li key={i} className={e.severity === "error" ? "text-united-danger" : "text-united-warn"}>● {exceptionText(t, e)}</li>)}</ul>
      )}
      {slip.lines.length > 0 ? (
        <table className="data-table">
          <thead><tr><th>{t("pay.component")}</th><th>{t("pay.kind")}</th><th className="num">{t("pay.quantity")}</th><th className="num">{t("pay.amount")}</th><th>{t("pay.formula")}</th></tr></thead>
          <tbody>
            {slip.lines.map((l) => (
              <tr key={l.id}>
                <td><span className="font-medium">{nm(l)}</span> <span className="text-xs text-united-muted" dir="ltr">{l.code}</span></td>
                <td>{t(`pay.line.${l.kind}`)}</td>
                <td className="num" dir="ltr">{l.quantity ? Number(l.quantity).toLocaleString("en-US", { maximumFractionDigits: 2 }) : ""}</td>
                <td className={`num font-semibold ${l.kind === "earning" ? "" : "text-united-danger"}`} dir="ltr">{l.kind === "earning" || l.kind === "employer_contribution" ? "" : "−"}{fmtMoney(l.amount)}</td>
                <td className="text-xs text-united-muted" dir="ltr">{l.explanation}{l.ruleSetVersion ? ` · v${l.ruleSetVersion}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="text-sm text-united-muted">{t("pay.no_lines")}</p>}
      {canEdit && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("pay.recovery_requested")} hint={t("pay.recovery_hint")}>
            <input type="number" min={0} step="0.01" className="field w-[160px]" dir="ltr" value={recovery} onChange={(e) => setRecovery(e.target.value)} />
          </Field>
          <button type="button" className="btn-secondary btn-sm" onClick={() => patch({ advance_recovery_requested: Number(recovery) || 0 })}>{t("ui.save")}</button>
          {slip.inclusion === "included"
            ? <button type="button" className="btn-secondary btn-sm" onClick={async () => { const reason = await dialogs.prompt({ title: t("pay.hold"), label: t("pay.reason"), required: true }); if (reason) void patch({ inclusion: "on_hold", hold_reason: reason }); }}>{t("pay.hold")}</button>
            : <button type="button" className="btn-secondary btn-sm" onClick={() => patch({ inclusion: "included" })}>{t("pay.include")}</button>}
          {slip.holdReason && <span className="text-xs text-united-muted">{slip.holdReason}</span>}
        </div>
      )}
    </div>
  );
}

function AdjustmentsDialog({ period, onClose }: { period: string; onClose: () => void }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["hr", "payroll", "adjustments", period], queryFn: () => apiFetch<{ adjustments: { id: string; number: string; amount: string; reason: string; status: string; employee: { name: string }; payComponent: { code: string; nameAr: string; nameEn: string | null; kind: string } }[] }>(`/api/hr/payroll/adjustments?period=${period}`).then((r) => r.adjustments) });
  const comps = useQuery({ queryKey: ["hr", "payroll", "components"], queryFn: () => apiFetch<{ components: { id: string; code: string; nameAr: string; nameEn: string | null; method: string; active: boolean; kind: string }[] }>("/api/hr/payroll/components").then((r) => r.components) });
  const emps = useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: { id: string; code: string; name: string; active: boolean }[] }>("/api/hr/employees") });
  const [f, setF] = useState({ employee_id: "", pay_component_id: "", amount: "", reason: "" });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr", "payroll"] });
  const add = async () => {
    try {
      await apiPost("/api/hr/payroll/adjustments", { ...f, target_period: period, amount: Number(f.amount) });
      setF({ employee_id: "", pay_component_id: "", amount: "", reason: "" });
      toast.show(t("pay.saved_recalc"), "info");
      refresh();
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  const nm = (x: { nameAr: string; nameEn: string | null }) => (isEN ? x.nameEn || x.nameAr : x.nameAr);
  return (
    <Modal open onClose={onClose} size="lg" title={`${t("pay.adjustments")} · ${period}`} description={t("pay.adjustments_hint")} footer={<button type="button" className="btn-primary" onClick={onClose}>{t("ui.close")}</button>}>
      <form className="grid gap-3 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); if (f.employee_id && f.pay_component_id && Number(f.amount) > 0 && f.reason.trim()) void add(); }}>
        <select className="field" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })} aria-label={t("pay.employee")}>
          <option value="">{t("pay.employee")}</option>
          {emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
        </select>
        <select className="field" value={f.pay_component_id} onChange={(e) => setF({ ...f, pay_component_id: e.target.value })} aria-label={t("pay.component")}>
          <option value="">{t("pay.component")}</option>
          {comps.data?.filter((c) => c.active && c.method === "input").map((c) => <option key={c.id} value={c.id}>{c.code} · {nm(c)}</option>)}
        </select>
        <input type="number" min={0} step="0.01" className="field" dir="ltr" placeholder={t("pay.amount")} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <input className="field" maxLength={500} placeholder={t("pay.reason")} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <button type="submit" className="btn-primary">{t("pay.add")}</button>
      </form>
      <ul className="mt-4 divide-y divide-united-border text-sm">
        {(list.data ?? []).map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span><span dir="ltr" className="text-united-muted">{a.number}</span> · {a.employee.name} · {nm(a.payComponent)} · <span dir="ltr" className="font-semibold">{fmtMoney(a.amount)}</span> · {a.reason}</span>
            <span className="flex items-center gap-2">
              <StatusPill tone={a.status === "reserved" ? "info" : a.status === "cancelled" ? "neutral" : "warn"}>{t(`pay.adj.${a.status}`)}</StatusPill>
              {["open", "reserved"].includes(a.status) && <button type="button" className="btn-ghost btn-sm" onClick={async () => { try { await apiPost(`/api/hr/payroll/adjustments/${a.id}/cancel`, {}); refresh(); } catch (err) { toast.show(fail(t, err), "error"); } }}>{t("pay.cancel_adj")}</button>}
            </span>
          </li>
        ))}
        {list.data && !list.data.length && <li className="py-2 text-united-muted">{t("pay.adjustments_empty")}</li>}
      </ul>
    </Modal>
  );
}
