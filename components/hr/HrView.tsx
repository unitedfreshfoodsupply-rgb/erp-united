"use client";

import { useState, useMemo } from "react";
import { newClientKey } from "@/lib/clientKey";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { EmptyState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

/** Expenses (record; above the threshold they wait for approval) and employees (advances, reimbursements, balances). */

// ── Reusable helpers ────────────────────────────────────────

const fail = (t: (k: string) => string, toast: ReturnType<typeof useToast>, err: unknown) =>
  toast.show(err instanceof ApiClientError ? err.message : t("hr.error"), "error");

type FormConfig = { fields: Array<{ key: string; labelKey: string }>; cols: number; btnCls: string };

const FORM_CONFIG: Record<string, FormConfig> = {
  expenses: {
    cols: 3,
    btnCls: "btn-primary col-span-full",
    fields: [
      { key: "account_id", labelKey: "hr.label.account" },
      { key: "amount", labelKey: "hr.label.amount" },
      { key: "date", labelKey: "hr.label.date" },
      { key: "description", labelKey: "hr.label.description" },
      { key: "payment_mode", labelKey: "hr.label.payment_mode" },
      { key: "_cash_cond", labelKey: "hr.label.cash_register" },
      { key: "_emp_cond", labelKey: "hr.label.employee" },
    ],
  },
  employees: {
    cols: 5,
    btnCls: "btn-secondary",
    fields: [
      { key: "name", labelKey: "hr.placeholder.name" },
      { key: "job_title", labelKey: "hr.placeholder.job_title" },
      { key: "phone", labelKey: "hr.placeholder.phone" },
      { key: "department_id", labelKey: "hr.placeholder.department" },
      { key: "_add_btn", labelKey: "hr.add_employee_button" },
    ],
  },
  transactions: {
    cols: 5,
    btnCls: "btn-primary",
    fields: [
      { key: "employee_id", labelKey: "hr.label.employee" },
      { key: "type", labelKey: "hr.advances" },
      { key: "amount", labelKey: "hr.label.amount" },
      { key: "cash_account_id", labelKey: "hr.label.cash_register" },
      { key: "_rec_btn", labelKey: "hr.record_button" },
    ],
  },
};

type Emp = { id: string; code: string; name: string; jobTitle: string | null; active: boolean; balance: string; department: { name: string } | null };

export function HrView() {
  const { can } = usePermissions();
  const { t } = useLocale();
  const [tab, setTab] = useState<"expenses" | "employees">("expenses");
  return (
    <div className="p-4 max-w-5xl mx-auto pb-10 flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-united-dark">{t("hr.title")}</h1>
      {can("hr.employees.manage") && <Tabs value={tab} onChange={setTab} items={[{ key: "expenses", label: t("hr.expenses") }, { key: "employees", label: t("hr.employees") }]} />}
      {tab === "expenses" ? <Expenses /> : <Employees />}
    </div>
  );
}

const useEmployees = () => useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: Emp[]; departments: { id: string; code: string; name: string }[] }>("/api/hr/employees") });

function Expenses() {
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const emps = useEmployees();
  const accounts = useQuery({ queryKey: ["hr", "expense-accounts"], queryFn: () => apiFetch<{ accounts: { id: string; code: string; name: string; nameAr: string; type: string; postable: boolean }[] }>("/api/hr/expense-accounts").then((r) => r.accounts) });
  const list = useQuery({ queryKey: ["hr", "expenses"], queryFn: () => apiFetch<{ expenses: { id: string; number: string; date: string; amount: string; description: string; paymentMode: string; status: string; createdBy: string; employee: { name: string } | null; account: { code: string; name: string; nameAr: string } | null }[] }>("/api/hr/expenses") });
  const [f, setF] = useState({ date: todayLocalISO(), account_id: "", amount: "", description: "", payment_mode: "cash", cash_account_id: "cash_main", employee_id: "" });
  const [fKey, setFKey] = useState(newClientKey);

  const STATUS: Record<string, { label: string; cls: string }> = useMemo(() => ({
    pending_approval: { label: t("hr.status.pending_approval"), cls: "text-united-warn" },
    approved: { label: t("hr.status.approved"), cls: "text-united-green" },
    rejected: { label: t("hr.status.rejected"), cls: "text-united-danger" },
  }), [t]);

  const MODE: Record<string, string> = useMemo(() => ({
    cash: t("hr.mode.cash"),
    reimburse: t("hr.mode.reimburse"),
    advance: t("hr.mode.advance"),
  }), [t]);

  return (
    <div className="flex flex-col gap-3">
      <section className="card p-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Field label={t("hr.label.account")}><select className="field" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}><option value="">— {t("hr.placeholder.choose")} —</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} · {localName(a, locale)}</option>)}</select></Field>
        <Field label={t("hr.label.amount")}><input className="field" dir="ltr" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label={t("hr.label.date")}><input type="date" className="field" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={t("hr.label.description")}><input className="field" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label={t("hr.label.payment_mode")}><select className="field" value={f.payment_mode} onChange={(e) => setF({ ...f, payment_mode: e.target.value })}>{Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {f.payment_mode === "cash" ? (
          <Field label={t("hr.label.cash_register")}><select className="field" value={f.cash_account_id} onChange={(e) => setF({ ...f, cash_account_id: e.target.value })}><option value="cash_main">{t("hr.treasury.main")}</option><option value="bank_main">{t("hr.treasury.bank")}</option></select></Field>
        ) : (
          <Field label={t("hr.label.employee")}><select className="field" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}><option value="">— {t("hr.placeholder.choose")} —</option>{emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        )}
        <button type="button" className={FORM_CONFIG.expenses.btnCls} disabled={!f.account_id || !f.amount || !f.description} onClick={async () => {
          try {
            const r = await apiPost<{ expense: { number: string; status: string } }>("/api/hr/expenses", { ...f, employee_id: f.employee_id || undefined, cash_account_id: f.payment_mode === "cash" ? f.cash_account_id : undefined, idempotency_key: fKey });
            setFKey(newClientKey());
            toast.show(`${r.expense.number} · ${STATUS[r.expense.status].label}`, "success");
            setF({ ...f, amount: "", description: "" });
            void qc.invalidateQueries({ queryKey: ["hr"] });
          } catch (err) { fail(t, toast, err); }
        }}>{t("hr.expense_submit_button")}</button>
      </section>
      {list.isLoading && <LoadingState />}
      {list.data?.expenses.length === 0 && <EmptyState icon="🧾" title={t("hr.empty_expenses")} />}
      <ul className="flex flex-col gap-2">
        {list.data?.expenses.map((e) => (
          <li key={e.id} className="card p-3 flex justify-between gap-2 text-sm font-bold">
            <div>
              <div className="font-extrabold"><span dir="ltr">{e.number}</span> · {e.description}</div>
              <div className="text-xs text-united-muted">{e.date} · {e.account ? localName(e.account, locale) : "—"} · {MODE[e.paymentMode]}{e.employee ? ` · ${e.employee.name}` : ""} · {e.createdBy} · <span className={STATUS[e.status]?.cls}>{STATUS[e.status]?.label}</span></div>
            </div>
            <span dir="ltr" className="font-extrabold">{fmtMoney(e.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Employees() {
  const { can } = usePermissions();
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useEmployees();
  const [n, setN] = useState({ name: "", job_title: "", phone: "", department_id: "" });
  const [tx, setTx] = useState({ employee_id: "", type: "advance", amount: "", cash_account_id: "cash_main" });
  const [tKey, setTKey] = useState(newClientKey);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr"] });
  return (
    <div className="flex flex-col gap-3">
      <section className="card p-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <input className="field" placeholder={t("hr.placeholder.name")} value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} />
        <input className="field" placeholder={t("hr.placeholder.job_title")} value={n.job_title} onChange={(e) => setN({ ...n, job_title: e.target.value })} />
        <input className="field" dir="ltr" placeholder={t("hr.placeholder.phone")} value={n.phone} onChange={(e) => setN({ ...n, phone: e.target.value })} />
        <select className="field" value={n.department_id} onChange={(e) => setN({ ...n, department_id: e.target.value })}><option value="">{t("hr.placeholder.department")}</option>{q.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <button type="button" className={FORM_CONFIG.employees.btnCls} disabled={!n.name} onClick={async () => {
          try { await apiPost("/api/hr/employees", { name: n.name, job_title: n.job_title || null, phone: n.phone || null, department_id: n.department_id || null }); setN({ name: "", job_title: "", phone: "", department_id: "" }); refresh(); } catch (err) { fail(t, toast, err); }
        }}>{t("hr.add_employee_button")}</button>
      </section>
      {can("hr.advances.manage") && (
        <section className="card p-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
          <select className="field" value={tx.employee_id} onChange={(e) => setTx({ ...tx, employee_id: e.target.value })}><option value="">{t("hr.label.employee")}</option>{q.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <select className="field" value={tx.type} onChange={(e) => setTx({ ...tx, type: e.target.value })}>
            <option value="advance">{t("hr.transaction_type.advance")}</option>
            <option value="reimbursement">{t("hr.transaction_type.reimbursement")}</option>
            <option value="advance_return">{t("hr.transaction_type.advance_return")}</option>
          </select>
          <input className="field" dir="ltr" inputMode="decimal" placeholder={t("hr.label.amount")} value={tx.amount} onChange={(e) => setTx({ ...tx, amount: e.target.value })} />
          <select className="field" value={tx.cash_account_id} onChange={(e) => setTx({ ...tx, cash_account_id: e.target.value })}><option value="cash_main">{t("hr.label.cash_register")}</option><option value="bank_main">{t("hr.treasury.bank")}</option></select>
          <button type="button" className={FORM_CONFIG.transactions.btnCls} disabled={!tx.employee_id || !tx.amount} onClick={async () => {
            try { await apiPost("/api/hr/transactions", { ...tx, idempotency_key: tKey }); setTKey(newClientKey()); setTx({ ...tx, amount: "" }); refresh(); toast.show(t("hr.registered"), "success"); } catch (err) { fail(t, toast, err); }
          }}>{t("hr.record_button")}</button>
        </section>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        {q.data?.employees.map((e) => (
          <li key={e.id} className={`card p-3 flex justify-between text-sm font-bold ${e.active ? "" : "opacity-60"}`}>
            <span><span dir="ltr">{e.code}</span> · {e.name}{e.jobTitle ? ` · ${e.jobTitle}` : ""}{e.department ? ` · ${e.department.name}` : ""}</span>
            <span dir="ltr" className={Number(e.balance) > 0 ? "text-united-warn" : Number(e.balance) < 0 ? "text-united-danger" : ""} title={t("hr.balance_tooltip")}>{fmtMoney(e.balance)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
