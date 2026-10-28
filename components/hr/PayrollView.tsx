"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { Modal, useDialogs } from "@/components/ui/Dialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { PayrollRuns } from "@/components/hr/PayrollRuns";

/**
 * Payroll (docs/erp/DESIGN_SYSTEM.md §8.4): runs, salary packages, the pay-component
 * catalogue and the statutory rule sets. Each tab's data comes from an endpoint with its own
 * permission — salaries are never sent to someone who may not read them, whatever this screen shows.
 */

type Component = { id: string; code: string; nameAr: string; nameEn: string | null; kind: string; method: string; systemRole: string | null; taxable: boolean | null; insurable: boolean | null; expenseAccountId: string | null; liabilityAccountId: string | null; payslipOrder: number; active: boolean; version: number; expenseAccount: { code: string } | null; liabilityAccount: { code: string } | null };
type Package = {
  id: string; number: string; effectiveFrom: string; effectiveTo: string | null; insurableWage: string | null; reason: string; status: string; createdBy: string; decidedBy: string | null; decisionComment: string | null; approvalRequestId: string | null;
  employee: { id: string; code: string; name: string }; lines: { id: string; amount: string; payComponent: { code: string; nameAr: string; nameEn: string | null; kind: string } }[]; total: string; canDecide: boolean; canCancel: boolean;
};
type RuleSet = { id: string; code: string; effectiveFrom: string; effectiveTo: string | null; parameters: Record<string, unknown>; sourceReference: string; notes: string | null; status: string; createdBy: string; verifiedBy: string | null; version: number };
type Tab = "runs" | "packages" | "components" | "rules";

const PKG_TONE: Record<string, Tone> = { pending: "warn", approved: "success", rejected: "danger", cancelled: "neutral", superseded: "neutral" };
const RULE_TONE: Record<string, Tone> = { draft: "warn", verified: "success", retired: "neutral" };
const fail = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));
const nm = (isEN: boolean, x: { nameAr: string; nameEn: string | null }) => (isEN ? x.nameEn || x.nameAr : x.nameAr);
const useComponents = (enabled = true) => useQuery({ queryKey: ["hr", "payroll", "components"], enabled, queryFn: () => apiFetch<{ components: Component[] }>("/api/hr/payroll/components").then((r) => r.components) });

export function PayrollView() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const runs = can("hr.payroll.prepare") || can("hr.payroll.view") || can("hr.payroll.approve");
  const salaries = can("hr.compensation.view");
  const components = salaries || can("hr.compensation.manage") || runs;
  const rules = can("hr.statutory.manage") || runs;
  const items = [
    ...(runs ? [{ key: "runs" as Tab, label: t("pay.tab.runs") }] : []),
    ...(salaries ? [{ key: "packages" as Tab, label: t("pay.tab.packages") }] : []),
    ...(components ? [{ key: "components" as Tab, label: t("pay.tab.components") }] : []),
    ...(rules ? [{ key: "rules" as Tab, label: t("pay.tab.rules") }] : []),
  ];
  const [tab, setTab] = useState<Tab>(items[0]?.key ?? "rules");
  return (
    <div className="page-container">
      <PageHeader back={{ href: "/hr", label: t("hr.profile.back") }} title={t("pay.title")} description={t("pay.description")} />
      <Tabs value={tab} onChange={setTab} items={items} />
      {tab === "runs" && runs && <PayrollRuns />}
      {tab === "packages" && salaries && <PackagesTab canPropose={can("hr.compensation.manage")} />}
      {tab === "components" && components && <ComponentsTab canManage={can("hr.compensation.manage")} />}
      {tab === "rules" && rules && <RulesTab canManage={can("hr.statutory.manage")} />}
    </div>
  );
}

// ── Packages ───────────────────────────────────────────────────────────────

function PackagesTab({ canPropose }: { canPropose: boolean }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"pending" | "approved" | "all">("approved");
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ["hr", "payroll", "packages", filter], queryFn: () => apiFetch<{ packages: Package[] }>(`/api/hr/compensation${filter === "all" ? "" : `?status=${filter}`}`).then((r) => r.packages) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr", "payroll"] });
  const decide = async (p: Package, decision: "approve" | "reject") => {
    let comment: string | null | undefined;
    if (decision === "reject") {
      comment = await dialogs.prompt({ title: t("pay.reject"), label: t("pay.reason"), required: true });
      if (!comment) return;
    } else if (!(await dialogs.confirm({ title: t("pay.approve"), body: t("pay.approve_package_confirm", { number: p.number, from: p.effectiveFrom }) }))) return;
    try {
      await apiPost(`/api/approvals/${p.approvalRequestId}/decide`, { decision, comment: comment ?? undefined });
      toast.show(t("pay.saved"), "success");
      refresh();
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <Segmented value={filter} onChange={setFilter} items={[{ key: "approved", label: t("pay.filter.in_force") }, { key: "pending", label: t("pay.filter.pending") }, { key: "all", label: t("pay.filter.all") }]} />
        {canPropose && <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />{t("pay.package_new")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data!.length ? <EmptyState title={t("pay.packages_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data!.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-united-dark">{p.employee.name}</span>
                  <StatusPill tone={PKG_TONE[p.status] ?? "neutral"}>{t(`pay.pkg.${p.status}`)}</StatusPill>
                  <span className="text-xs text-united-muted" dir="ltr">{p.number} · {p.effectiveFrom} → {p.effectiveTo ?? "…"}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {p.lines.map((l) => <span key={l.id} className="rounded bg-united-subtle px-1.5 py-0.5">{nm(isEN, l.payComponent)} <span dir="ltr" className="font-semibold">{fmtMoney(l.amount)}</span></span>)}
                  {p.insurableWage && <span className="rounded bg-united-info/10 px-1.5 py-0.5">{t("pay.insurable_wage")} <span dir="ltr">{fmtMoney(p.insurableWage)}</span></span>}
                </div>
                <div className="mt-0.5 text-xs text-united-muted">{p.reason} · {p.createdBy}{p.decidedBy ? ` · ${t("pay.decided_by")} ${p.decidedBy}` : ""}{p.decisionComment ? `: ${p.decisionComment}` : ""}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-united-dark" dir="ltr">{fmtMoney(p.total)}</span>
                {p.canDecide && p.approvalRequestId && <>
                  <button type="button" className="btn-primary btn-sm" onClick={() => decide(p, "approve")}>{t("pay.approve")}</button>
                  <button type="button" className="btn-danger btn-sm" onClick={() => decide(p, "reject")}>{t("pay.reject")}</button>
                </>}
                {p.canCancel && <button type="button" className="btn-secondary btn-sm" onClick={async () => { if (await dialogs.confirm({ title: t("pay.withdraw"), body: p.number })) { try { await apiPost(`/api/hr/compensation/${p.id}/cancel`, {}); refresh(); } catch (err) { toast.show(fail(t, err), "error"); } } }}>{t("pay.withdraw")}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && <PackageDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

function PackageDialog({ onClose }: { onClose: () => void }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const comps = useComponents();
  const emps = useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: { id: string; code: string; name: string; active: boolean }[] }>("/api/hr/employees") });
  const [f, setF] = useState({ employee_id: "", effective_from: todayLocalISO().slice(0, 8) + "01", insurable_wage: "", reason: "" });
  const [lines, setLines] = useState<{ pay_component_id: string; amount: string }[]>([{ pay_component_id: "", amount: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fixed = (comps.data ?? []).filter((c) => c.active && c.method === "fixed");
  const ready = f.employee_id && f.reason.trim() && lines.every((l) => l.pay_component_id && Number(l.amount) > 0);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/hr/compensation", { employee_id: f.employee_id, effective_from: f.effective_from, insurable_wage: f.insurable_wage === "" ? null : Number(f.insurable_wage), reason: f.reason.trim(), lines: lines.map((l) => ({ pay_component_id: l.pay_component_id, amount: Number(l.amount) })) });
      toast.show(t("pay.package_sent"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "payroll"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("pay.package_new")} description={t("pay.package_hint")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="pkg-form" className="btn-primary" disabled={busy || !ready}>{busy ? t("ui.saving") : t("pay.send_for_approval")}</button></>}>
      <form id="pkg-form" className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("pay.employee")} required>
            <select className="field" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
              <option value="">{t("pay.choose")}</option>
              {emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
            </select>
          </Field>
          <Field label={t("pay.effective_from")} required><input type="date" className="field" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
          <Field label={t("pay.insurable_wage")} hint={t("pay.insurable_hint")}><input type="number" min={0} step="0.01" className="field" dir="ltr" value={f.insurable_wage} onChange={(e) => setF({ ...f, insurable_wage: e.target.value })} /></Field>
        </div>
        {!fixed.length && <p className="rounded-lg bg-united-warn/10 px-3 py-2 text-sm text-united-warn">{t("pay.no_fixed_components")}</p>}
        <table className="data-table">
          <thead><tr><th>{t("pay.component")}</th><th className="num">{t("pay.monthly_amount")}</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="field" value={l.pay_component_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, pay_component_id: e.target.value } : x)))} aria-label={t("pay.component")}>
                    <option value="">{t("pay.choose")}</option>
                    {fixed.map((c) => <option key={c.id} value={c.id}>{c.code} · {nm(isEN, c)}</option>)}
                  </select>
                </td>
                <td><input type="number" min={0} step="0.01" className="field text-end" dir="ltr" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={t("pay.monthly_amount")} /></td>
                <td>{lines.length > 1 && <button type="button" className="btn-ghost btn-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn-secondary btn-sm self-start" onClick={() => setLines([...lines, { pay_component_id: "", amount: "" }])}>{t("pay.line_add")}</button>
        <Field label={t("pay.reason")} required><input className="field" maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {error && <p role="alert" className="text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Components ─────────────────────────────────────────────────────────────

const SYSTEM_ROLES = ["overtime_day", "overtime_night", "overtime_rest_day", "overtime_holiday", "unpaid_absence", "partial_leave", "social_insurance_employee", "social_insurance_employer", "income_tax", "other_levy_employee", "other_levy_employer", "advance_recovery", "rounding"];

function ComponentsTab({ canManage }: { canManage: boolean }) {
  const { t, isEN } = useLocale();
  const q = useComponents();
  const [editing, setEditing] = useState<Component | "new" | null>(null);
  const yn = (v: boolean | null) => (v === null ? t("pay.undecided") : v ? t("pay.yes") : t("pay.no"));
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div><h2 className="section-title">{t("pay.components")}</h2><p className="text-sm text-united-muted">{t("pay.components_hint")}</p></div>
        {canManage && <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setEditing("new")}><Plus size={16} aria-hidden />{t("pay.component_add")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState title={t("pay.components_empty")} /> : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[760px]">
            <thead><tr><th>{t("pay.component")}</th><th>{t("pay.kind")}</th><th>{t("pay.method")}</th><th>{t("pay.taxable")}</th><th>{t("pay.insurable")}</th><th>{t("pay.accounts")}</th><th>{t("pay.state")}</th><th /></tr></thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                  <td><div className="font-semibold">{nm(isEN, c)}</div><div className="text-xs text-united-muted" dir="ltr">{c.code}</div></td>
                  <td>{t(`pay.kind.${c.kind}`)}</td>
                  <td>{t(`pay.method.${c.method}`)}{c.systemRole ? <div className="text-xs text-united-muted">{t(`pay.role.${c.systemRole}`)}</div> : null}</td>
                  <td className={c.taxable === null ? "text-united-warn" : ""}>{yn(c.taxable)}</td>
                  <td className={c.insurable === null ? "text-united-warn" : ""}>{yn(c.insurable)}</td>
                  <td className="text-xs" dir="ltr">{c.expenseAccount?.code ?? "—"} / {c.liabilityAccount?.code ?? "—"}</td>
                  <td><StatusPill tone={c.active ? "success" : "neutral"}>{c.active ? t("pay.active") : t("pay.inactive")}</StatusPill></td>
                  <td>{canManage && <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(c)}>{t("ui.edit")}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ComponentDialog component={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ComponentDialog({ component, onClose }: { component: Component | null; onClose: () => void }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounting", "accounts"], enabled: can("accounting.view"), queryFn: () => apiFetch<{ accounts: { id: string; code: string; name: string; nameAr: string; type: string }[] }>("/api/accounting/accounts").then((r) => r.accounts) });
  const tri = (v: boolean | null | undefined) => (v === null || v === undefined ? "" : v ? "yes" : "no");
  const [f, setF] = useState({
    code: component?.code ?? "", name_ar: component?.nameAr ?? "", name_en: component?.nameEn ?? "", kind: component?.kind ?? "earning", method: component?.method ?? "fixed",
    system_role: component?.systemRole ?? "", taxable: tri(component?.taxable), insurable: tri(component?.insurable), expense_account_id: component?.expenseAccountId ?? "",
    liability_account_id: component?.liabilityAccountId ?? "", payslip_order: String(component?.payslipOrder ?? 100), active: component?.active ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromTri = (v: string) => (v === "" ? null : v === "yes");
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      code: f.code, name_ar: f.name_ar, name_en: f.name_en.trim() || null, kind: f.kind, method: f.method, system_role: f.method === "system" ? f.system_role || null : null,
      taxable: fromTri(f.taxable), insurable: fromTri(f.insurable), expense_account_id: f.expense_account_id || null, liability_account_id: f.liability_account_id || null,
      payslip_order: Number(f.payslip_order) || 0, active: f.active, ...(component ? { expected_version: component.version } : {}),
    };
    try {
      if (component) await apiPatch(`/api/hr/payroll/components/${component.id}`, body);
      else await apiPost("/api/hr/payroll/components", body);
      toast.show(t("pay.saved"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "payroll"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  const triSelect = (key: "taxable" | "insurable") => (
    <select className="field" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
      <option value="">{t("pay.undecided")}</option><option value="yes">{t("pay.yes")}</option><option value="no">{t("pay.no")}</option>
    </select>
  );
  return (
    <Modal open onClose={onClose} size="lg" title={component ? t("pay.component_edit") : t("pay.component_add")} description={t("pay.component_hint")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="comp-form" className="btn-primary" disabled={busy || !f.code || !f.name_ar.trim()}>{busy ? t("ui.saving") : t("ui.save")}</button></>}>
      <form id="comp-form" className="grid gap-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
        <Field label={t("att.code")} required><input className="field" dir="ltr" maxLength={30} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label={t("att.name_ar")} required><input className="field" maxLength={100} value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
        <Field label={t("att.name_en")}><input className="field" dir="ltr" maxLength={100} value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
        <Field label={t("pay.kind")} required>
          <select className="field" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["earning", "deduction", "employer_contribution", "information"].map((k) => <option key={k} value={k}>{t(`pay.kind.${k}`)}</option>)}</select>
        </Field>
        <Field label={t("pay.method")} required>
          <select className="field" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{["fixed", "input", "system"].map((k) => <option key={k} value={k}>{t(`pay.method.${k}`)}</option>)}</select>
        </Field>
        {f.method === "system" ? (
          <Field label={t("pay.system_role")} required>
            <select className="field" value={f.system_role} onChange={(e) => setF({ ...f, system_role: e.target.value })}>
              <option value="">{t("pay.choose")}</option>{SYSTEM_ROLES.map((k) => <option key={k} value={k}>{t(`pay.role.${k}`)}</option>)}
            </select>
          </Field>
        ) : <div />}
        <Field label={t("pay.taxable")} hint={t("pay.accountant_decides")}>{triSelect("taxable")}</Field>
        <Field label={t("pay.insurable")} hint={t("pay.accountant_decides")}>{triSelect("insurable")}</Field>
        <Field label={t("pay.payslip_order")}><input type="number" className="field" dir="ltr" value={f.payslip_order} onChange={(e) => setF({ ...f, payslip_order: e.target.value })} /></Field>
        <Field label={t("pay.expense_account")} hint={t("pay.accounts_hint")}>
          <select className="field" value={f.expense_account_id} onChange={(e) => setF({ ...f, expense_account_id: e.target.value })}>
            <option value="">—</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.nameAr}</option>)}
          </select>
        </Field>
        <Field label={t("pay.liability_account")}>
          <select className="field" value={f.liability_account_id} onChange={(e) => setF({ ...f, liability_account_id: e.target.value })}>
            <option value="">—</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.nameAr}</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 self-end text-sm font-medium"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t("pay.active")}</label>
        {error && <p role="alert" className="sm:col-span-3 text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Statutory rule sets ────────────────────────────────────────────────────

/** The shape of each rule — keys only, every value left empty for the person entering it. */
const RULE_TEMPLATES: Record<string, unknown> = {
  eg_social_insurance: { employee_rate: null, employer_rate: null, min_insurable_wage: null, max_insurable_wage: null },
  eg_salary_income_tax: { taxable_base: "taxable_gross_minus_employee_insurance", period_method: "annualised_monthly", annual_exemption: null, brackets: [{ up_to: null, rate: null }], high_income_tables: [] },
  eg_other_levies: { levies: [{ code: null, name_ar: null, base: "gross", rate: null, payer: "employee" }] },
  eg_overtime: { day_multiplier: null, night_multiplier: null, rest_day_multiplier: null, holiday_multiplier: null, monthly_divisor_days: null, hours_per_day: null, base_components: [], minimum_minutes_per_day: null },
  pay_proration: { method: "fixed_divisor", divisor_days: null, base_components: [] },
};

function RulesTab({ canManage }: { canManage: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "payroll", "rules"], queryFn: () => apiFetch<{ ruleSets: RuleSet[] }>("/api/hr/statutory").then((r) => r.ruleSets) });
  const [editing, setEditing] = useState<RuleSet | "new" | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); toast.show(t("pay.saved"), "success"); void qc.invalidateQueries({ queryKey: ["hr", "payroll"] }); } catch (err) { toast.show(fail(t, err), "error"); } };
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div><h2 className="section-title">{t("pay.rules")}</h2><p className="text-sm text-united-muted">{t("pay.rules_hint")}</p></div>
        {canManage && <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setEditing("new")}><Plus size={16} aria-hidden />{t("pay.rule_add")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState title={t("pay.rules_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-united-dark">{t(`pay.rule.${r.code}`)}</span>
                  <StatusPill tone={RULE_TONE[r.status] ?? "neutral"}>{t(`pay.rule_status.${r.status}`)}</StatusPill>
                  <span className="text-xs text-united-muted" dir="ltr">{r.code} · {r.effectiveFrom} → {r.effectiveTo ?? "…"}</span>
                </div>
                <pre dir="ltr" className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap rounded bg-united-subtle px-2 py-1 text-xs">{JSON.stringify(r.parameters)}</pre>
                <div className="mt-0.5 text-xs text-united-muted">{t("pay.source")}: {r.sourceReference} · {r.createdBy}{r.verifiedBy ? ` · ${t("pay.verified_by")} ${r.verifiedBy}` : ""}</div>
              </div>
              {canManage && (
                <div className="flex gap-2">
                  {r.status === "draft" && <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(r)}>{t("ui.edit")}</button>}
                  {r.status === "draft" && <button type="button" className="btn-primary btn-sm gap-1" onClick={async () => { if (await dialogs.confirm({ title: t("pay.verify"), body: t("pay.verify_confirm") })) void act(() => apiPost(`/api/hr/statutory/${r.id}/verify`, {})); }}><ShieldCheck size={15} aria-hidden />{t("pay.verify")}</button>}
                  {r.status !== "retired" && <button type="button" className="btn-secondary btn-sm" onClick={async () => { const reason = await dialogs.prompt({ title: r.status === "draft" ? t("pay.discard") : t("pay.retire"), label: t("pay.reason"), required: true }); if (reason) void act(() => apiPost(`/api/hr/statutory/${r.id}/retire`, { reason })); }}>{r.status === "draft" ? t("pay.discard") : t("pay.retire")}</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function RuleDialog({ rule, onClose }: { rule: RuleSet | null; onClose: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ code: rule?.code ?? "eg_social_insurance", effective_from: rule?.effectiveFrom ?? `${todayLocalISO().slice(0, 4)}-01-01`, effective_to: rule?.effectiveTo ?? "", source_reference: rule?.sourceReference ?? "", notes: rule?.notes ?? "" });
  const [json, setJson] = useState(JSON.stringify(rule?.parameters ?? RULE_TEMPLATES["eg_social_insurance"], null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    let parameters: unknown;
    try { parameters = JSON.parse(json); } catch { setError(t("pay.json_invalid")); return; }
    setBusy(true);
    const body = { ...f, effective_to: f.effective_to || null, notes: f.notes.trim() || null, parameters };
    try {
      if (rule) await apiPatch(`/api/hr/statutory/${rule.id}`, body);
      else await apiPost("/api/hr/statutory", body);
      toast.show(t("pay.saved"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "payroll"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={rule ? t("pay.rule_edit") : t("pay.rule_add")} description={t("pay.rule_dialog_hint")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="rule-form" className="btn-primary" disabled={busy || !f.source_reference.trim()}>{busy ? t("ui.saving") : t("pay.save_draft")}</button></>}>
      <form id="rule-form" className="grid gap-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
        <Field label={t("pay.rule_code")} required>
          <select className="field" value={f.code} disabled={!!rule} onChange={(e) => { setF({ ...f, code: e.target.value }); setJson(JSON.stringify(RULE_TEMPLATES[e.target.value], null, 2)); }}>
            {Object.keys(RULE_TEMPLATES).map((c) => <option key={c} value={c}>{t(`pay.rule.${c}`)}</option>)}
          </select>
        </Field>
        <Field label={t("pay.effective_from")} required><input type="date" className="field" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
        <Field label={t("pay.effective_to")}><input type="date" className="field" value={f.effective_to} onChange={(e) => setF({ ...f, effective_to: e.target.value })} /></Field>
        <div className="sm:col-span-3"><Field label={t("pay.source")} required hint={t("pay.source_hint")}><input className="field" maxLength={500} value={f.source_reference} onChange={(e) => setF({ ...f, source_reference: e.target.value })} /></Field></div>
        <div className="sm:col-span-3"><Field label={t("pay.parameters")} required hint={t("pay.parameters_hint")}><textarea className="field min-h-[220px] font-mono text-sm" dir="ltr" spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} /></Field></div>
        <div className="sm:col-span-3"><Field label={t("pay.notes")}><input className="field" maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></div>
        {error && <p role="alert" className="sm:col-span-3 text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}
