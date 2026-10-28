"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookCheck, Download, Landmark, Undo2, Wallet } from "lucide-react";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { todayLocalISO } from "@/lib/localDate";
import { newClientKey } from "@/lib/clientKey";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

/**
 * After approval (lib/hr/payroll-posting.ts): the entry posting would write and what blocks
 * it, posting and reversal, and payments against the posted run. The server decides what
 * each person may do (`can`); the screens only show it.
 */

type Problem = { code: string; params: Record<string, string>; message: string };
type PreviewLine = { side: "debit" | "credit"; role: "component" | "recovery" | "net"; accountCode: string | null; accountName: string | null; accountNameAr: string | null; amount: string; label: string; component: string | null };
type Preview = { posted: boolean; entry: { id: string; number: string; date: string; total: string } | null; date: string | null; lines: PreviewLine[]; totals: { debit: string; credit: string } | null; balanced: boolean; problems: Problem[] };
type Payment = { id: string; number: string; date: string; method: string; reference: string | null; amount: string; createdBy: string; reversedAt: string | null; reversalReason: string | null; cashAccount: { code: string; name: string }; journalEntry: { number: string } | null; reversalEntry: { number: string } | null; lines: { employeeId: string; amount: string }[] };
type Payments = { payments: Payment[]; slips: { employeeId: string; netPayable: string; paid: string; remaining: string }[]; totals: { netPayable: string; paid: string; remaining: string } };
export type PostingRun = { id: string; number: string; status: string; postedBy?: string | null; postingDate?: string | null; reversedBy?: string | null; reversalReason?: string | null; can: { post?: boolean; reverse?: boolean; pay?: boolean; bankFile?: boolean }; employees: { employeeId: string; inclusion: string; employee: { code: string; name: string } }[] };

const fail = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));
const METHODS = ["bank_transfer", "cash", "cheque", "wallet", "other"] as const;

export function PostingPanel({ run }: { run: PostingRun }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["hr", "payroll", "run", run.id, "journal"], queryFn: () => apiFetch<Preview>(`/api/hr/payroll/runs/${run.id}/journal`) });
  if (!["approved", "posted", "reversed"].includes(run.status)) return null;
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const p = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr"] });
  const post = async () => {
    if (!(await dialogs.confirm({ title: t("pay.post"), body: t("pay.post_confirm", { number: run.number, date: p.date ?? "" }) }))) return;
    setBusy(true);
    try { await apiPost(`/api/hr/payroll/runs/${run.id}/post`, {}); toast.show(t("pay.posted"), "success"); refresh(); } catch (err) { toast.show(fail(t, err), "error"); } finally { setBusy(false); }
  };
  const reverse = async () => {
    const reason = await dialogs.prompt({ title: t("pay.reverse_run"), body: t("pay.reverse_run_body"), label: t("pay.reason"), required: true, tone: "danger", confirmLabel: t("pay.reverse_run") });
    if (!reason) return;
    setBusy(true);
    try { await apiPost(`/api/hr/payroll/runs/${run.id}/reverse`, { reason }); toast.show(t("pay.reversed"), "success"); refresh(); } catch (err) { toast.show(fail(t, err), "error"); } finally { setBusy(false); }
  };
  return (
    <section className="card overflow-hidden">
      <div className="card-header flex-wrap gap-3">
        <div>
          <h3 className="section-title flex items-center gap-1.5"><BookCheck size={18} aria-hidden />{t("pay.journal")}</h3>
          <p className="text-sm text-united-muted">
            {p.posted && p.entry ? <>{t("pay.posted_as")} <span dir="ltr">{p.entry.number} · {p.entry.date} · {fmtMoney(p.entry.total)}</span>{run.postedBy ? ` · ${run.postedBy}` : ""}</> : t("pay.journal_hint", { date: p.date ?? "" })}
          </p>
          {run.status === "reversed" && <p className="text-sm text-united-danger">{t("pay.reversed_note", { by: run.reversedBy ?? "", reason: run.reversalReason ?? "" })}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {run.can.post && <button type="button" className="btn-primary btn-sm gap-1.5" disabled={busy || p.problems.length > 0} onClick={() => void post()}><BookCheck size={16} aria-hidden />{t("pay.post")}</button>}
          {run.can.reverse && <button type="button" className="btn-danger btn-sm gap-1.5" disabled={busy} onClick={() => void reverse()}><Undo2 size={16} aria-hidden />{t("pay.reverse_run")}</button>}
        </div>
      </div>
      {!p.posted && p.problems.length > 0 && (
        <div className="border-b border-united-border bg-united-danger/5 px-5 py-3 text-sm">
          <div className="font-semibold text-united-danger">{t("pay.post_blocked")}</div>
          <ul className="mt-1 list-disc ps-5 text-united-danger">{p.problems.map((x, i) => <li key={i}>{t(`pay.post_problem.${x.code}`, x.params)}</li>)}</ul>
          <p className="mt-1 text-xs text-united-muted">{t("pay.post_blocked_hint")}</p>
        </div>
      )}
      {!p.posted && p.lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("pay.journal_account")}</th><th>{t("pay.journal_line")}</th><th className="num">{t("pay.debit")}</th><th className="num">{t("pay.credit")}</th></tr></thead>
            <tbody>
              {p.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.accountCode ? <><span dir="ltr">{l.accountCode}</span> · {localName({ name: l.accountName ?? "", nameAr: l.accountNameAr }, locale)}</> : <StatusPill tone="danger">{t("pay.no_account")}</StatusPill>}</td>
                  <td className="text-xs">{l.component ? <span dir="ltr">{l.component}</span> : t(l.role === "net" ? "pay.net_line" : "pay.recovery_line")}</td>
                  <td className="num" dir="ltr">{l.side === "debit" ? fmtMoney(l.amount) : ""}</td>
                  <td className="num" dir="ltr">{l.side === "credit" ? fmtMoney(l.amount) : ""}</td>
                </tr>
              ))}
              {p.totals && <tr className="font-semibold"><td colSpan={2}>{t("pay.total")}</td><td className="num" dir="ltr">{fmtMoney(p.totals.debit)}</td><td className="num" dir="ltr">{fmtMoney(p.totals.credit)}</td></tr>}
            </tbody>
          </table>
          <p className="px-5 py-2 text-xs text-united-muted">{t("pay.journal_privacy")}</p>
        </div>
      )}
    </section>
  );
}

export function PaymentsPanel({ run }: { run: PostingRun }) {
  const { t } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "payroll", "run", run.id, "payments"], queryFn: () => apiFetch<Payments>(`/api/hr/payroll/runs/${run.id}/payments`), enabled: ["posted", "reversed"].includes(run.status) });
  const [f, setF] = useState({ date: todayLocalISO(), cash_account_id: "bank_main", method: "bank_transfer", reference: "" });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [key, setKey] = useState(newClientKey);
  const [busy, setBusy] = useState(false);
  if (!["posted", "reversed"].includes(run.status)) return null;
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const d = q.data;
  const nameOf = new Map(run.employees.map((e) => [e.employeeId, e.employee]));
  const explicit = Object.entries(amounts).filter(([, v]) => Number(v) > 0).map(([employee_id, amount]) => ({ employee_id, amount }));
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["hr", "payroll", "run", run.id] }); };
  const pay = async (all: boolean) => {
    const total = all ? d.totals.remaining : explicit.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
    if (!(await dialogs.confirm({ title: t("pay.record_payment"), body: t("pay.payment_confirm", { amount: fmtMoney(total), n: all ? d.slips.filter((s) => Number(s.remaining) > 0).length : explicit.length }) }))) return;
    setBusy(true);
    try {
      await apiPost(`/api/hr/payroll/runs/${run.id}/payments`, { ...f, reference: f.reference || undefined, ...(all ? { all_remaining: true } : { lines: explicit }), idempotency_key: key });
      toast.show(t("pay.payment_recorded"), "success");
      setAmounts({});
      setKey(newClientKey());
      refresh();
    } catch (err) { toast.show(fail(t, err), "error"); } finally { setBusy(false); }
  };
  const reverse = async (p: Payment) => {
    const reason = await dialogs.prompt({ title: t("pay.reverse_payment", { number: p.number }), label: t("pay.reason"), required: true, tone: "danger", confirmLabel: t("pay.reverse_payment_short") });
    if (!reason) return;
    try { await apiPost(`/api/hr/payroll/payments/${p.id}/reverse`, { reason }); toast.show(t("pay.payment_reversed"), "success"); refresh(); } catch (err) { toast.show(fail(t, err), "error"); }
  };
  const canPay = !!run.can.pay && Number(d.totals.remaining) > 0;
  return (
    <section className="card overflow-hidden">
      <div className="card-header flex-wrap gap-3">
        <div>
          <h3 className="section-title flex items-center gap-1.5"><Wallet size={18} aria-hidden />{t("pay.payments")}</h3>
          <p className="text-sm text-united-muted" dir="auto">{run.status === "reversed" ? t("pay.payments_reversed_run") : t("pay.payments_summary", { net: fmtMoney(d.totals.netPayable), paid: fmtMoney(d.totals.paid), remaining: fmtMoney(d.totals.remaining) })}</p>
        </div>
        {run.can.bankFile && <a className="btn-secondary btn-sm gap-1.5" href={`/api/hr/payroll/runs/${run.id}/bank-file`}><Landmark size={16} aria-hidden />{t("pay.bank_file")}</a>}
      </div>
      {canPay && (
        <div className="grid grid-cols-2 gap-3 border-b border-united-border px-5 py-4 sm:grid-cols-4">
          <Field label={t("pay.payment_date")}><input type="date" className="field" max={todayLocalISO()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label={t("accounting.form.account.label")}><select className="field" value={f.cash_account_id} onChange={(e) => setF({ ...f, cash_account_id: e.target.value })}><option value="bank_main">{t("accounting.form.account.bank")}</option><option value="cash_main">{t("accounting.form.account.treasury")}</option></select></Field>
          <Field label={t("accounting.form.method")}><select className="field" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{t(`accounting.method.${m.replace("_", "-")}`)}</option>)}</select></Field>
          <Field label={t("accounting.form.reference")}><input className="field" dir="ltr" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        </div>
      )}
      {run.status === "posted" && <div className="overflow-x-auto">
        <table className="data-table">
          <thead><tr><th>{t("pay.employee")}</th><th className="num">{t("pay.net_payable")}</th><th className="num">{t("pay.paid")}</th><th className="num">{t("pay.unpaid")}</th>{canPay && <th className="num">{t("pay.pay_now")}</th>}<th /></tr></thead>
          <tbody>
            {d.slips.map((s) => (
              <tr key={s.employeeId}>
                <td><div className="font-semibold">{nameOf.get(s.employeeId)?.name}</div><div className="text-xs text-united-muted" dir="ltr">{nameOf.get(s.employeeId)?.code}</div></td>
                <td className="num" dir="ltr">{fmtMoney(s.netPayable)}</td>
                <td className="num" dir="ltr">{fmtMoney(s.paid)}</td>
                <td className={`num font-semibold ${Number(s.remaining) > 0 ? "" : "text-united-green"}`} dir="ltr">{fmtMoney(s.remaining)}</td>
                {canPay && <td className="num">{Number(s.remaining) > 0 && <input className="field w-28" dir="ltr" inputMode="decimal" aria-label={`${t("pay.pay_now")} ${nameOf.get(s.employeeId)?.code ?? ""}`} value={amounts[s.employeeId] ?? ""} onChange={(e) => setAmounts({ ...amounts, [s.employeeId]: e.target.value })} />}</td>}
                <td><a className="btn-ghost btn-sm gap-1" href={`/hr/payroll/runs/${run.id}/payslips/${s.employeeId}/print`} target="_blank" rel="noreferrer"><Download size={14} aria-hidden />{t("pay.payslip")}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {canPay && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-united-border px-5 py-3">
          <button type="button" className="btn-secondary btn-sm" disabled={busy || explicit.length === 0} onClick={() => void pay(false)}>{t("pay.pay_entered")}</button>
          <button type="button" className="btn-primary btn-sm gap-1.5" disabled={busy} onClick={() => void pay(true)}><Wallet size={16} aria-hidden />{t("pay.pay_all_remaining")}</button>
        </div>
      )}
      {d.payments.length > 0 && (
        <ul className="flex flex-col divide-y divide-united-border border-t border-united-border text-sm">
          {d.payments.map((p) => (
            <li key={p.id} className={`flex flex-wrap items-center justify-between gap-2 px-5 py-2 ${p.reversedAt ? "opacity-70" : ""}`}>
              <span><span dir="ltr" className="font-semibold">{p.number}</span> · {p.date} · {p.cashAccount.name} · {t(`accounting.method.${p.method.replace("_", "-")}`)} · {t("pay.employees_n", { n: p.lines.length })}{p.reference ? <> · <span dir="ltr">{p.reference}</span></> : null} · {p.createdBy}{p.reversedAt ? ` · ${t("pay.payment_reversed_note", { reason: p.reversalReason ?? "" })}` : ""}</span>
              <span className="flex items-center gap-2">
                <span dir="ltr" className={`font-semibold ${p.reversedAt ? "line-through" : ""}`}>{fmtMoney(p.amount)}</span>
                {!p.reversedAt && run.can.pay && <button type="button" className="text-xs text-united-danger underline" onClick={() => void reverse(p)}>{t("pay.reverse_payment_short")}</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
