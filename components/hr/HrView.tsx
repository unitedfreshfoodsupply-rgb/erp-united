"use client";

import { useMemo, useState } from "react";
import { CashAccountSelect } from "@/components/accounting/CashAccountSelect";
import { systemText } from "@/lib/locale/system-text";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, FileText, Pencil, Plus, Search } from "lucide-react";
import { newClientKey } from "@/lib/clientKey";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Dialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName, namesForEdit, namesForSave } from "@/lib/locale/names";

/**
 * HR and expenses on today's schema: expenses (above the threshold they wait for approval),
 * the employee register (add, edit, deactivate), departments, and each employee's money
 * with the company — advances, reimbursements, returns and the statement behind the balance.
 *
 * What a user sees is decided by the server: someone who only records expenses gets names
 * to choose from, never balances or phone numbers (lib/hr/service.ts listEmployees).
 */

type Dept = { id: string; code: string; name: string; nameAr?: string | null; active: boolean; activeEmployees?: number };
type Emp = {
  id: string; code: string; name: string; nameAr?: string | null; active: boolean; department: { id: string; name: string; nameAr?: string | null } | null;
  // HR/finance only:
  jobTitle?: string | null; phone?: string | null; hireDate?: string | null; departmentId?: string | null; userId?: string | null; version?: number; balance?: string;
};
type Tab = "expenses" | "employees" | "departments";

const useEmployees = () =>
  useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: Emp[]; departments: Dept[] }>("/api/hr/employees") });

export function HrView() {
  const { can } = usePermissions();
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("expenses");
  const manage = can("hr.employees.manage");
  return (
    <div className="page-container">
      <PageHeader title={t("hr.title")} description={manage ? t("hr.page.description") : t("hr.page.description_expenses")} />
      {manage && (
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { key: "expenses", label: t("hr.expenses") },
            { key: "employees", label: t("hr.employees") },
            { key: "departments", label: t("hr.departments") },
          ]}
        />
      )}
      {tab === "expenses" || !manage ? <Expenses /> : tab === "employees" ? <Employees /> : <Departments />}
    </div>
  );
}

const failMsg = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));

const EXPENSE_TONE: Record<string, Tone> = { pending_approval: "warn", approved: "success", rejected: "danger" };

// ── Expenses ───────────────────────────────────────────────────────────────

function Expenses() {
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const emps = useEmployees();
  const accounts = useQuery({ queryKey: ["hr", "expense-accounts"], queryFn: () => apiFetch<{ accounts: { id: string; code: string; name: string; nameAr: string }[] }>("/api/hr/expense-accounts").then((r) => r.accounts) });
  const list = useQuery({ queryKey: ["hr", "expenses"], queryFn: () => apiFetch<{ expenses: { id: string; number: string; date: string; amount: string; description: string; paymentMode: string; status: string; createdBy: string; employee: { name: string } | null; account: { code: string; name: string; nameAr: string } | null }[] }>("/api/hr/expenses") });
  const blank = { date: todayLocalISO(), account_id: "", amount: "", description: "", payment_mode: "cash", cash_account_id: "cash_main", employee_id: "" };
  const [f, setF] = useState(blank);
  const [fKey, setFKey] = useState(newClientKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"all" | "pending_approval" | "approved" | "rejected">("all");

  const MODE: Record<string, string> = useMemo(() => ({ cash: t("hr.mode.cash"), reimburse: t("hr.mode.reimburse"), advance: t("hr.mode.advance") }), [t]);
  const needsEmployee = f.payment_mode !== "cash";
  const ready = !!f.account_id && /^\d+(\.\d{1,2})?$/.test(f.amount.trim()) && Number(f.amount) > 0 && !!f.description.trim() && (!needsEmployee || !!f.employee_id);
  const rows = (list.data?.expenses ?? []).filter((e) => status === "all" || e.status === status);
  const counts = (s: string) => (list.data?.expenses ?? []).filter((e) => e.status === s).length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ expense: { number: string; status: string } }>("/api/hr/expenses", { ...f, employee_id: needsEmployee ? f.employee_id : undefined, cash_account_id: needsEmployee ? undefined : f.cash_account_id, idempotency_key: fKey });
      setFKey(newClientKey());
      toast.show(`${r.expense.number} · ${t(`hr.status.${r.expense.status}`)}`, "success");
      setF({ ...blank, date: f.date, payment_mode: f.payment_mode, cash_account_id: f.cash_account_id });
      void qc.invalidateQueries({ queryKey: ["hr"] });
    } catch (err) {
      setError(failMsg(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="card" aria-labelledby="exp-form">
        <div className="card-header">
          <h2 id="exp-form" className="section-title">{t("hr.expense.form_title")}</h2>
          <span className="text-xs text-united-muted">{t("hr.expense.form_hint")}</span>
        </div>
        <form
          className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void submit();
          }}
        >
          <Field label={t("hr.label.account")} required>
            <select className="field" required value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
              <option value="">{t("hr.placeholder.choose")}</option>
              {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} · {localName(a, locale)}</option>)}
            </select>
          </Field>
          <Field label={t("hr.label.amount")} required hint={t("hr.amount.hint")}>
            <input className="field" required dir="ltr" inputMode="decimal" autoComplete="off" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          <Field label={t("hr.label.date")} required>
            <input type="date" className="field" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value || todayLocalISO() })} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-1">
            <Field label={t("hr.label.description")} required>
              <input className="field" required maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </Field>
          </div>
          <Field label={t("hr.label.payment_mode")} required>
            <select className="field" value={f.payment_mode} onChange={(e) => setF({ ...f, payment_mode: e.target.value })}>
              {Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          {needsEmployee ? (
            <Field label={t("hr.label.employee")} required>
              <select className="field" required value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
                <option value="">{t("hr.placeholder.choose")}</option>
                {emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{localName(e, locale)}</option>)}
              </select>
            </Field>
          ) : (
            <Field label={t("hr.label.cash_register")} required>
              <CashAccountSelect value={f.cash_account_id} onChange={(id) => setF({ ...f, cash_account_id: id })} />
            </Field>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3 sm:col-span-2 lg:col-span-3">
            {error && <p role="alert" className="me-auto text-sm font-medium text-united-danger">{error}</p>}
            <button type="button" className="btn-secondary" onClick={() => { setF({ ...blank, date: f.date }); setError(null); }} disabled={busy}>{t("hr.clear")}</button>
            <button type="submit" className="btn-primary" disabled={!ready || busy}>{busy ? t("ui.saving") : t("hr.expense_submit_button")}</button>
          </div>
        </form>
      </section>

      <section className="card overflow-hidden" aria-labelledby="exp-list">
        <div className="card-header flex-wrap">
          <h2 id="exp-list" className="section-title">{t("hr.expense.list_title")}</h2>
          <Segmented
            label={t("hr.expense.filter")}
            value={status}
            onChange={setStatus}
            items={[
              { key: "all", label: t("hr.filter.all") },
              { key: "pending_approval", label: t("hr.status.pending_approval"), count: counts("pending_approval") },
              { key: "approved", label: t("hr.status.approved") },
              { key: "rejected", label: t("hr.status.rejected") },
            ]}
          />
        </div>
        {list.isLoading && <LoadingState />}
        {list.isError && <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />}
        {list.data && rows.length === 0 && <EmptyState icon="🧾" title={t("hr.empty_expenses")} />}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("hr.col.number")}</th>
                  <th>{t("hr.label.date")}</th>
                  <th>{t("hr.label.description")}</th>
                  <th>{t("hr.label.account")}</th>
                  <th>{t("hr.label.payment_mode")}</th>
                  <th>{t("hr.col.status")}</th>
                  <th className="num">{t("hr.label.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td dir="ltr" className="whitespace-nowrap text-united-muted">{e.number}</td>
                    <td dir="ltr" className="whitespace-nowrap">{e.date}</td>
                    <td className="min-w-[12rem]">
                      <div className="font-medium text-united-dark">{e.description}</div>
                      <div className="text-xs text-united-muted">{e.employee ? `${localName(e.employee, locale)} · ` : ""}{e.createdBy}</div>
                    </td>
                    <td className="whitespace-nowrap">{e.account ? <><span dir="ltr" className="text-united-muted">{e.account.code}</span> · {localName(e.account, locale)}</> : "—"}</td>
                    <td className="whitespace-nowrap">{MODE[e.paymentMode] ?? e.paymentMode}</td>
                    <td><StatusPill tone={EXPENSE_TONE[e.status] ?? "neutral"}>{t(`hr.status.${e.status}`)}</StatusPill></td>
                    <td className="num font-semibold" dir="ltr">{fmtMoney(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Employees ──────────────────────────────────────────────────────────────

function Employees() {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const q = useEmployees();
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"active" | "inactive" | "all">("active");
  const [editing, setEditing] = useState<Emp | "new" | null>(null);
  const [paying, setPaying] = useState<Emp | null>(null);
  const [statementOf, setStatementOf] = useState<Emp | null>(null);
  const canPay = can("hr.advances.manage");
  const canOpen = can("hr.employees.view");

  const all = q.data?.employees ?? [];
  const needle = search.trim().toLowerCase();
  const rows = all.filter(
    (e) =>
      (show === "all" || (show === "active") === e.active) &&
      (!needle || e.name.toLowerCase().includes(needle) || e.code.toLowerCase().includes(needle) || (e.jobTitle ?? "").toLowerCase().includes(needle) || (e.phone ?? "").includes(needle)),
  );
  const totalAdvances = all.reduce((s, e) => s + Math.max(0, Number(e.balance ?? 0)), 0);
  const totalOwed = all.reduce((s, e) => s + Math.max(0, -Number(e.balance ?? 0)), 0);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label={t("hr.metric.active")} value={String(all.filter((e) => e.active).length)} />
        <Metric label={t("hr.metric.departments")} value={String((q.data?.departments ?? []).filter((d) => d.active).length)} />
        <Metric label={t("hr.metric.advances_held")} value={fmtMoney(totalAdvances)} ltr tone={totalAdvances > 0 ? "text-united-warn" : undefined} />
        <Metric label={t("hr.metric.owed_to_staff")} value={fmtMoney(totalOwed)} ltr tone={totalOwed > 0 ? "text-united-danger" : undefined} />
      </dl>

      <section className="card overflow-hidden" aria-label={t("hr.employees")}>
        <div className="flex flex-wrap items-center gap-3 border-b border-united-border px-5 py-3">
          <div className="relative min-w-[12rem] flex-1">
            <Search size={16} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-united-muted" />
            <input type="search" className="field field-sm ps-9" placeholder={t("hr.search")} aria-label={t("hr.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Segmented label={t("hr.filter.status")} value={show} onChange={setShow} items={[{ key: "active", label: t("hr.filter.active") }, { key: "inactive", label: t("hr.filter.inactive") }, { key: "all", label: t("hr.filter.all") }]} />
          <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setEditing("new")}>
            <Plus size={16} aria-hidden />
            {t("hr.employee.add")}
          </button>
        </div>
        {q.isLoading && <LoadingState />}
        {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
        {q.data && rows.length === 0 && <EmptyState icon="👥" title={all.length === 0 ? t("hr.empty_employees") : needle ? t("hr.empty_filter") : show === "inactive" ? t("hr.empty_inactive") : t("hr.empty_active")} />}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("hr.col.employee")}</th>
                  <th>{t("hr.placeholder.department")}</th>
                  <th>{t("hr.placeholder.phone")}</th>
                  <th>{t("hr.col.hire_date")}</th>
                  <th className="num">
                    <span title={t("hr.balance_tooltip")}>{t("hr.col.balance")}</span>
                  </th>
                  <th><span className="sr-only">{t("hr.col.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const bal = Number(e.balance ?? 0);
                  return (
                    <tr key={e.id} className={e.active ? undefined : "text-united-muted"}>
                      <td className="min-w-[12rem]">
                        <div className="flex flex-wrap items-center gap-2">
                          {canOpen ? (
                            <Link href={`/hr/employees/${e.id}`} className="font-medium text-united-dark hover:text-united-green hover:underline">{localName(e, locale)}</Link>
                          ) : (
                            <span className="font-medium text-united-dark">{localName(e, locale)}</span>
                          )}
                          {!e.active && <StatusPill tone="neutral">{t("hr.status.inactive")}</StatusPill>}
                        </div>
                        <div className="text-xs text-united-muted"><span dir="ltr">{e.code}</span>{e.jobTitle ? ` · ${e.jobTitle}` : ""}</div>
                      </td>
                      <td className="whitespace-nowrap">{(e.department ? localName(e.department, locale) : "—")}</td>
                      <td dir="ltr" className="whitespace-nowrap">{e.phone || "—"}</td>
                      <td dir="ltr" className="whitespace-nowrap">{e.hireDate || "—"}</td>
                      <td className={`num font-semibold ${bal > 0 ? "text-united-warn" : bal < 0 ? "text-united-danger" : ""}`} dir="ltr">
                        {fmtMoney(e.balance ?? "0")}
                        <span className="sr-only"> {bal > 0 ? t("hr.balance.advance") : bal < 0 ? t("hr.balance.owed") : ""}</span>
                      </td>
                      <td className="whitespace-nowrap text-end">
                        <div className="inline-flex gap-1">
                          <IconButton label={t("hr.action.statement")} onClick={() => setStatementOf(e)}><FileText size={16} /></IconButton>
                          {canPay && e.active && <IconButton label={t("hr.action.pay")} onClick={() => setPaying(e)}><Banknote size={16} /></IconButton>}
                          <IconButton label={t("hr.action.edit")} onClick={() => setEditing(e)}><Pencil size={16} /></IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && <p className="border-t border-united-border px-5 py-2.5 text-xs text-united-muted">{t("hr.balance_tooltip")}</p>}
      </section>

      {editing && <EmployeeDialog employee={editing === "new" ? null : editing} departments={q.data?.departments ?? []} onClose={() => setEditing(null)} />}
      {paying && <MoneyDialog employee={paying} onClose={() => setPaying(null)} />}
      {statementOf && <StatementDialog employee={statementOf} onClose={() => setStatementOf(null)} />}
    </div>
  );
}

function Metric({ label, value, ltr, tone }: { label: string; value: string; ltr?: boolean; tone?: string }) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs font-medium text-united-muted">{label}</dt>
      <dd className={`mt-1 text-lg font-bold ${tone ?? "text-united-dark"}`}>{ltr ? <span dir="ltr">{value}</span> : value}</dd>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="grid h-9 w-9 place-items-center rounded-lg text-united-muted hover:bg-united-subtle hover:text-united-dark">
      {children}
    </button>
  );
}

function EmployeeDialog({ employee, departments, onClose }: { employee: Emp | null; departments: Dept[]; onClose: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    ...(() => { const n = namesForEdit(employee ?? {}); return { name: n.en, name_ar: n.ar }; })(),
    job_title: employee?.jobTitle ?? "",
    phone: employee?.phone ?? "",
    department_id: employee?.department?.id ?? employee?.departmentId ?? "",
    hire_date: employee?.hireDate ?? "",
    active: employee?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An inactive department stays selectable only for the employee already in it.
  const options = departments.filter((d) => d.active || d.id === f.department_id);

  const save = async () => {
    setBusy(true);
    setError(null);
    // Only the fields this form shows are sent; the linked user account is left as it is.
    const body = { ...namesForSave(f.name, f.name_ar), job_title: f.job_title.trim() || null, phone: f.phone.trim() || null, department_id: f.department_id || null, hire_date: f.hire_date || undefined, active: f.active };
    try {
      if (employee) await apiPatch(`/api/hr/employees/${employee.id}`, { ...body, expected_version: employee.version });
      else await apiPost("/api/hr/employees", body);
      toast.show(employee ? t("hr.employee.saved") : t("hr.employee.created"), "success");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      onClose();
    } catch (err) {
      setError(failMsg(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={employee ? t("hr.employee.edit_title") : t("hr.employee.add_title")}
      description={employee ? `${employee.code}` : t("hr.employee.add_desc")}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
          <button type="submit" form="emp-form" className="btn-primary" disabled={busy || !(f.name.trim() || f.name_ar.trim())}>{busy ? t("ui.saving") : t("ui.save")}</button>
        </>
      }
    >
      <form id="emp-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if ((f.name.trim() || f.name_ar.trim()) && !busy) void save(); }}>
        <Field label={t("names.arabic")} hint={t("names.one_required")}>
          <input className="field" dir="rtl" lang="ar" autoFocus maxLength={100} value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} />
        </Field>
        <Field label={t("names.english")}>
          <input className="field" dir="ltr" lang="en" maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t("hr.placeholder.job_title")}>
          <input className="field" maxLength={100} value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} />
        </Field>
        <Field label={t("hr.placeholder.department")}>
          <select className="field" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
            <option value="">{t("hr.department.none")}</option>
            {options.map((d) => <option key={d.id} value={d.id}>{localName(d, locale)}</option>)}
          </select>
        </Field>
        <Field label={t("hr.placeholder.phone")}>
          <input className="field" dir="ltr" inputMode="tel" maxLength={30} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label={t("hr.col.hire_date")}>
          <input type="date" className="field" value={f.hire_date} onChange={(e) => setF({ ...f, hire_date: e.target.value })} />
        </Field>
        {employee && (
          <label className="flex items-start gap-3 rounded-lg border border-united-border p-3 sm:col-span-2">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-united-green" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium text-united-dark">{t("hr.employee.active_label")}</span>
              <span className="block text-xs text-united-muted">{t("hr.employee.active_hint")}</span>
            </span>
          </label>
        )}
        {error && <p role="alert" className="text-sm font-medium text-united-danger sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
}

function MoneyDialog({ employee, onClose }: { employee: Emp; onClose: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ type: "advance", amount: "", cash_account_id: "cash_main", date: todayLocalISO(), notes: "", payroll_period: todayLocalISO().slice(0, 7) });
  const [key, setKey] = useState(newClientKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bal = Number(employee.balance ?? 0);
  const ready = /^\d+(\.\d{1,2})?$/.test(f.amount.trim()) && Number(f.amount) > 0;
  const effect: Record<string, string> = { advance: t("hr.money.effect.advance"), reimbursement: t("hr.money.effect.reimbursement"), advance_return: t("hr.money.effect.advance_return"), salary_on_account: t("hr.money.effect.salary_on_account") };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/hr/transactions", { employee_id: employee.id, type: f.type, amount: f.amount.trim(), cash_account_id: f.cash_account_id, date: f.date, notes: f.notes.trim() || undefined, ...(f.type === "salary_on_account" ? { payroll_period: f.payroll_period } : {}), idempotency_key: key });
      setKey(newClientKey());
      toast.show(t("hr.registered"), "success");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      onClose();
    } catch (err) {
      setError(failMsg(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("hr.money.title")}
      description={`${localName(employee, locale)} · ${bal > 0 ? `${t("hr.balance.advance")} ${fmtMoney(bal)}` : bal < 0 ? `${t("hr.balance.owed")} ${fmtMoney(-bal)}` : t("hr.balance.settled")}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
          <button type="submit" form="money-form" className="btn-primary" disabled={busy || !ready}>{busy ? t("ui.saving") : t("hr.record_button")}</button>
        </>
      }
    >
      <form id="money-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <div className="sm:col-span-2">
          <Field label={t("hr.money.type")} required>
            <select className="field" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="advance">{t("hr.transaction_type.advance")}</option>
              <option value="reimbursement">{t("hr.transaction_type.reimbursement")}</option>
              <option value="advance_return">{t("hr.transaction_type.advance_return")}</option>
              <option value="salary_on_account">{t("hr.transaction_type.salary_on_account")}</option>
            </select>
          </Field>
          <p className="mt-1.5 text-xs text-united-muted">{effect[f.type]}</p>
        </div>
        {f.type === "salary_on_account" && (
          <Field label={t("hr.money.payroll_period")} required>
            <input type="month" className="field" value={f.payroll_period} onChange={(e) => setF({ ...f, payroll_period: e.target.value })} />
          </Field>
        )}
        <Field label={t("hr.label.amount")} required>
          <input className="field" required autoFocus dir="ltr" inputMode="decimal" autoComplete="off" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label={t("hr.label.cash_register")} required>
          <CashAccountSelect value={f.cash_account_id} onChange={(id) => setF({ ...f, cash_account_id: id })} />
        </Field>
        <Field label={t("hr.label.date")} required>
          <input type="date" className="field" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value || todayLocalISO() })} />
        </Field>
        <Field label={t("hr.money.notes")}>
          <input className="field" maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {error && <p role="alert" className="text-sm font-medium text-united-danger sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
}

function StatementDialog({ employee, onClose }: { employee: Emp; onClose: () => void }) {
  const { t, locale } = useLocale();
  const q = useQuery({
    queryKey: ["hr", "statement", employee.id],
    queryFn: () => apiFetch<{ statement: { rows: { date: string; number: string; description: string; account: string; debit: string; credit: string }[]; advancesHeld: string; owedToEmployee: string } }>(`/api/hr/employees/${employee.id}/statement`).then((r) => r.statement),
  });
  return (
    <Modal open onClose={onClose} size="xl" title={t("hr.statement.title")} description={localName(employee, locale)} footer={<button type="button" className="btn-secondary" onClick={onClose}>{t("ui.close")}</button>}>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-3">
            <Metric label={t("hr.statement.advances_held")} value={fmtMoney(q.data.advancesHeld)} ltr tone={Number(q.data.advancesHeld) > 0 ? "text-united-warn" : undefined} />
            <Metric label={t("hr.statement.owed")} value={fmtMoney(q.data.owedToEmployee)} ltr tone={Number(q.data.owedToEmployee) > 0 ? "text-united-danger" : undefined} />
          </dl>
          {q.data.rows.length === 0 ? (
            <EmptyState icon="📄" title={t("hr.statement.empty")} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-united-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("hr.label.date")}</th>
                    <th>{t("hr.col.number")}</th>
                    <th>{t("hr.label.description")}</th>
                    <th>{t("hr.statement.account")}</th>
                    <th className="num">{t("hr.statement.debit")}</th>
                    <th className="num">{t("hr.statement.credit")}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.rows.map((r, i) => (
                    <tr key={`${r.number}-${i}`}>
                      <td dir="ltr" className="whitespace-nowrap">{r.date}</td>
                      <td dir="ltr" className="whitespace-nowrap text-united-muted">{r.number}</td>
                      <td className="min-w-[12rem]">{systemText(r.description, locale)}</td>
                      <td className="whitespace-nowrap">{r.account === "employee_advances" ? t("hr.statement.acc_advances") : t("hr.statement.acc_payable")}</td>
                      <td className="num" dir="ltr">{Number(r.debit) ? fmtMoney(r.debit) : ""}</td>
                      <td className="num" dir="ltr">{Number(r.credit) ? fmtMoney(r.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Departments ────────────────────────────────────────────────────────────

function Departments() {
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useEmployees();
  const [n, setN] = useState({ code: "", name: "", name_ar: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Dept | null>(null);
  const deps = q.data?.departments ?? [];

  const save = async (body: { code: string; name: string; name_ar?: string | null; active?: boolean }, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/hr/departments", body);
      toast.show(done, "success");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      return true;
    } catch (err) {
      const m = failMsg(t, err);
      setError(m);
      toast.show(m, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="card" aria-labelledby="dep-form">
        <div className="card-header">
          <h2 id="dep-form" className="section-title">{t("hr.department.add_title")}</h2>
        </div>
        <form
          className="grid gap-4 p-5 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!n.code.trim() || !(n.name.trim() || n.name_ar.trim())) return;
            if (deps.some((d) => d.code === n.code.trim().toUpperCase())) { setError(t("hr.department.code_taken")); return; }
            if (await save({ code: n.code.trim(), ...namesForSave(n.name, n.name_ar) }, t("hr.department.created"))) setN({ code: "", name: "", name_ar: "" });
          }}
        >
          <Field label={t("hr.department.code")} required>
            <input className="field uppercase" dir="ltr" required maxLength={20} placeholder="OPS" aria-describedby="dep-code-hint" value={n.code} onChange={(e) => setN({ ...n, code: e.target.value })} />
          </Field>
          <Field label={t("names.arabic")}>
            <input className="field" dir="rtl" lang="ar" maxLength={100} value={n.name_ar} onChange={(e) => setN({ ...n, name_ar: e.target.value })} />
          </Field>
          <Field label={t("names.english")}>
            <input className="field" dir="ltr" lang="en" maxLength={100} value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} />
          </Field>
          <button type="submit" className="btn-primary gap-1.5" disabled={busy || !n.code.trim() || !(n.name.trim() || n.name_ar.trim())}>
            <Plus size={16} aria-hidden />
            {t("hr.department.add")}
          </button>
          <p id="dep-code-hint" className="-mt-2 text-xs text-united-muted sm:col-span-4">{t("hr.department.code_hint")}</p>
          {error && <p role="alert" className="text-sm font-medium text-united-danger sm:col-span-4">{error}</p>}
        </form>
      </section>

      <section className="card overflow-hidden" aria-label={t("hr.departments")}>
        {q.isLoading && <LoadingState />}
        {q.data && deps.length === 0 && <EmptyState icon="🏢" title={t("hr.department.empty")} />}
        {deps.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("hr.department.code")}</th>
                <th>{t("hr.department.name")}</th>
                <th className="num">{t("hr.department.active_count")}</th>
                <th>{t("hr.col.status")}</th>
                <th><span className="sr-only">{t("hr.col.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {deps.map((d) => (
                <tr key={d.id} className={d.active ? undefined : "text-united-muted"}>
                  <td dir="ltr" className="whitespace-nowrap">{d.code}</td>
                  <td className="font-medium">{localName(d, locale)}</td>
                  <td className="num">{d.activeEmployees ?? 0}</td>
                  <td><StatusPill tone={d.active ? "success" : "neutral"}>{d.active ? t("hr.status.active") : t("hr.status.closed")}</StatusPill></td>
                  <td className="whitespace-nowrap text-end">
                    <div className="inline-flex gap-2">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setRenaming(d)}>{t("hr.action.rename")}</button>
                      {d.active ? (
                        <button
                          type="button"
                          className="btn-ghost btn-sm text-united-danger hover:bg-[#FDECEA] disabled:opacity-40"
                          disabled={busy || (d.activeEmployees ?? 0) > 0}
                          title={(d.activeEmployees ?? 0) > 0 ? t("hr.department.close_blocked") : undefined}
                          onClick={() => void save({ code: d.code, name: d.name, name_ar: d.nameAr ?? null, active: false }, t("hr.department.closed"))}
                        >
                          {t("hr.action.close")}
                        </button>
                      ) : (
                        <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void save({ code: d.code, name: d.name, name_ar: d.nameAr ?? null, active: true }, t("hr.department.reopened"))}>{t("hr.action.reopen")}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {renaming && <RenameDialog dept={renaming} onClose={() => setRenaming(null)} onSave={async (names) => (await save({ code: renaming.code, ...names, active: renaming.active }, t("hr.department.renamed"))) && setRenaming(null)} busy={busy} />}
    </div>
  );
}

function RenameDialog({ dept, onClose, onSave, busy }: { dept: Dept; onClose: () => void; onSave: (names: { name: string; name_ar: string | null }) => void; busy: boolean }) {
  const { t } = useLocale();
  const initial = namesForEdit(dept);
  const [name, setName] = useState(initial.en);
  const [nameAr, setNameAr] = useState(initial.ar);
  const unchanged = name.trim() === initial.en && nameAr.trim() === initial.ar;
  return (
    <Modal
      open
      onClose={onClose}
      title={t("hr.department.rename_title")}
      description={dept.code}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
          <button type="submit" form="dep-rename" className="btn-primary" disabled={busy || !(name.trim() || nameAr.trim()) || unchanged}>{t("ui.save")}</button>
        </>
      }
    >
      <form id="dep-rename" className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() || nameAr.trim()) onSave(namesForSave(name, nameAr)); }}>
        <Field label={t("names.arabic")} hint={t("names.one_required")}>
          <input className="field" dir="rtl" lang="ar" autoFocus maxLength={100} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </Field>
        <Field label={t("names.english")}>
          <input className="field" dir="ltr" lang="en" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
