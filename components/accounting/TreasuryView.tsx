"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, apiPatch, errorMessage } from "@/lib/api-client";
import { newClientKey } from "@/lib/clientKey";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";
import { CashAccountSelect } from "@/components/accounting/CashAccountSelect";

/**
 * Cash & banks: every cash box and bank account with its ledger balance, adding and
 * retiring them, and moving money between them. Balances are read from the GL accounts
 * behind each box; a transfer posts Dr destination / Cr source and nothing else.
 */

type CashRow = { id: string; code: string; name: string; nameAr: string | null; type: "cash" | "bank"; active: boolean; bankName: string | null; accountNumber: string | null; notes: string | null; version: number; balance: string; openReconciliation: boolean; glAccount: { code: string } };
type Party = { id: string; code: string; name: string; nameAr: string | null; type: string };
type TransferRow = { id: string; number: string; date: string; status: "pending_approval" | "posted" | "rejected"; amount: string; fee: string; reference: string | null; from: Party; to: Party; createdBy: string; reversal: { at: string; by: string; reason: string } | null };

export function TreasuryView() {
  const { can } = usePermissions();
  const manage = can("accounting.manage");
  return (
    <div className="flex flex-col gap-4">
      <CashAccounts manage={manage} />
      {manage && <NewTransfer />}
      <Transfers manage={manage} />
    </div>
  );
}

function CashAccounts({ manage }: { manage: boolean }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<CashRow | "new" | null>(null);
  const q = useQuery({ queryKey: ["acc", "cash-accounts", showInactive], queryFn: () => apiFetch<{ cashAccounts: CashRow[] }>(`/api/accounting/cash-accounts${showInactive ? "?all=1" : ""}`).then((r) => r.cashAccounts) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["acc"] }); void qc.invalidateQueries({ queryKey: ["cash-accounts"] }); };
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const active = q.data.filter((r) => r.active);
  const total = active.reduce((s, r) => s + Number(r.balance), 0);
  const toggle = async (r: CashRow) => {
    if (r.active && !(await dialogs.confirm({ title: t("treasury.confirm-deactivate", { name: localName(r, locale) }), body: t("treasury.deactivate-body"), tone: "danger", confirmLabel: t("treasury.deactivate") }))) return;
    try { await apiPatch(`/api/accounting/cash-accounts/${r.id}`, { active: !r.active, version: r.version }); toast.show(t(r.active ? "treasury.toast-deactivated" : "treasury.toast-activated"), "success"); refresh(); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  return (
    <section className="flex flex-col gap-2" aria-labelledby="treasury-accounts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="treasury-accounts" className="section-title">{t("treasury.accounts-title")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-bold text-united-muted"><input type="checkbox" className="h-5 w-5" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{t("treasury.show-inactive")}</label>
          {manage && <button type="button" className="btn-primary btn-sm" onClick={() => setEditing("new")}>{t("treasury.add-account")}</button>}
        </div>
      </div>
      {editing && <CashAccountForm row={editing === "new" ? null : editing} onDone={() => { setEditing(null); refresh(); }} />}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {q.data.map((r) => (
          <article key={r.id} className={`card p-4 flex flex-col gap-1 ${r.active ? "" : "opacity-70"}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-bold text-united-muted">{t(r.type === "cash" ? "treasury.type.cash" : "treasury.type.bank")}{r.bankName ? ` · ${r.bankName}` : ""}</div>
                <div className="font-extrabold truncate">{localName(r, locale)}</div>
              </div>
              {!r.active && <StatusPill tone="neutral">{t("treasury.inactive")}</StatusPill>}
              {r.openReconciliation && <StatusPill tone="info">{t("treasury.reconciling")}</StatusPill>}
            </div>
            <div className="text-2xl font-extrabold" dir="ltr">{fmtMoney(r.balance)}</div>
            <div className="text-xs text-united-muted">{t("accounting.gl-account")} <bdi dir="ltr">{r.glAccount.code}</bdi>{r.accountNumber ? <> · <bdi dir="ltr">{r.accountNumber}</bdi></> : null}</div>
            {manage && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(r)}>{t("ui.edit")}</button>
                <button type="button" className={r.active ? "btn-danger btn-sm" : "btn-secondary btn-sm"} onClick={() => toggle(r)}>{t(r.active ? "treasury.deactivate" : "treasury.activate")}</button>
              </div>
            )}
          </article>
        ))}
        <div className="card p-4 bg-united-green/10">
          <div className="text-sm font-bold text-united-muted">{t("accounting.total-cash")}</div>
          <div className="text-2xl font-extrabold text-united-green" dir="ltr">{fmtMoney(total.toFixed(2))}</div>
        </div>
      </div>
    </section>
  );
}

function CashAccountForm({ row, onDone }: { row: CashRow | null; onDone: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [f, setF] = useState({ type: row?.type ?? "bank", name: row?.name ?? "", name_ar: row?.nameAr ?? "", bank_name: row?.bankName ?? "", account_number: row?.accountNumber ?? "", notes: row?.notes ?? "" });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name: f.name, name_ar: f.name_ar, notes: f.notes, ...(f.type === "bank" ? { bank_name: f.bank_name, account_number: f.account_number } : {}) };
      if (row) await apiPatch(`/api/accounting/cash-accounts/${row.id}`, { ...body, version: row.version });
      else await apiPost("/api/accounting/cash-accounts", { ...body, type: f.type });
      toast.show(t(row ? "treasury.toast-saved" : "treasury.toast-created"), "success");
      onDone();
    } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="card p-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {!row && (
        <Field label={t("treasury.field.type")} required>
          <select className="field" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as "cash" | "bank" })}>
            <option value="bank">{t("treasury.type.bank")}</option>
            <option value="cash">{t("treasury.type.cash")}</option>
          </select>
        </Field>
      )}
      <Field label={t("treasury.field.name-ar")} required><input className="field" required value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
      <Field label={t("treasury.field.name-en")} required><input className="field" dir="ltr" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      {f.type === "bank" && <Field label={t("treasury.field.bank")}><input className="field" value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} /></Field>}
      {f.type === "bank" && <Field label={t("treasury.field.number")}><input className="field" dir="ltr" value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></Field>}
      <Field label={t("treasury.field.notes")}><input className="field" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="flex gap-2 self-end">
        <button type="submit" className="btn-primary" disabled={busy}>{t(row ? "ui.save" : "treasury.add-account")}</button>
        <button type="button" className="btn-secondary" onClick={onDone}>{t("ui.cancel")}</button>
      </div>
    </form>
  );
}

function NewTransfer() {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const blank = () => ({ from_cash_account_id: "cash_main", to_cash_account_id: "bank_main", amount: "", fee: "", date: todayLocalISO(), reference: "", notes: "", key: newClientKey() });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await apiPost<{ transfer: { number: string; status: string } }>("/api/accounting/transfers", { from_cash_account_id: f.from_cash_account_id, to_cash_account_id: f.to_cash_account_id, amount: f.amount, ...(f.fee ? { fee: f.fee } : {}), date: f.date, reference: f.reference, notes: f.notes, idempotency_key: f.key });
      toast.show(t(r.transfer.status === "pending_approval" ? "treasury.toast-transfer-pending" : "treasury.toast-transfer-posted", { number: r.transfer.number }), "success");
      setF(blank());
      void qc.invalidateQueries({ queryKey: ["acc"] });
      void qc.invalidateQueries({ queryKey: ["cash-accounts"] });
    } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="card p-4 flex flex-col gap-2" aria-labelledby="treasury-new-transfer">
      <h2 id="treasury-new-transfer" className="section-title">{t("treasury.new-transfer")}</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label={t("treasury.field.from")} required><CashAccountSelect value={f.from_cash_account_id} onChange={(id) => setF({ ...f, from_cash_account_id: id })} /></Field>
        <Field label={t("treasury.field.to")} required><CashAccountSelect value={f.to_cash_account_id} onChange={(id) => setF({ ...f, to_cash_account_id: id })} /></Field>
        <Field label={t("treasury.field.date")} required><input type="date" className="field" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={t("treasury.field.amount")} required><input className="field" dir="ltr" inputMode="decimal" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label={t("treasury.field.fee")} hint={t("treasury.fee-hint")}><input className="field" dir="ltr" inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></Field>
        <Field label={t("treasury.field.reference")}><input className="field" dir="ltr" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
      <Field label={t("treasury.field.notes")}><input className="field" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div><button type="submit" className="btn-primary" disabled={busy || f.from_cash_account_id === f.to_cash_account_id}>{t("treasury.record-transfer")}</button></div>
    </form>
  );
}

function Transfers({ manage }: { manage: boolean }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["acc", "transfers"], queryFn: () => apiFetch<{ transfers: TransferRow[] }>("/api/accounting/transfers?limit=50").then((r) => r.transfers) });
  const reverse = async (r: TransferRow) => {
    const reason = await dialogs.prompt({ title: t("treasury.prompt-reverse", { number: r.number }), label: t("ui.reason-label"), required: true, multiline: true, tone: "danger", confirmLabel: t("accounting.button.reverse") });
    if (!reason) return;
    try { await apiPost(`/api/accounting/transfers/${r.id}/reverse`, { reason }); toast.show(t("treasury.toast-reversed"), "success"); void qc.invalidateQueries({ queryKey: ["acc"] }); void qc.invalidateQueries({ queryKey: ["cash-accounts"] }); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  return (
    <section className="flex flex-col gap-2" aria-labelledby="treasury-transfers">
      <h2 id="treasury-transfers" className="section-title">{t("treasury.transfers-title")}</h2>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState icon="🔁" title={t("treasury.no-transfers")} /> : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("treasury.col.number")}</th><th>{t("treasury.col.date")}</th><th>{t("treasury.field.from")}</th><th>{t("treasury.field.to")}</th><th className="num">{t("treasury.field.amount")}</th><th>{t("treasury.col.status")}</th>{manage && <th><span className="sr-only">{t("treasury.col.actions")}</span></th>}</tr></thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id}>
                  <td><bdi dir="ltr">{r.number}</bdi></td>
                  <td><bdi dir="ltr">{r.date}</bdi></td>
                  <td>{localName(r.from, locale)}</td>
                  <td>{localName(r.to, locale)}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.amount)}{Number(r.fee) ? <span className="block text-xs text-united-muted">+ {fmtMoney(r.fee)}</span> : null}</td>
                  <td>{r.reversal ? <StatusPill tone="neutral" strike>{t("treasury.status.reversed")}</StatusPill> : <StatusPill tone={r.status === "posted" ? "success" : r.status === "pending_approval" ? "warn" : "danger"}>{t(`treasury.status.${r.status}`)}</StatusPill>}</td>
                  {manage && <td>{r.status === "posted" && !r.reversal && <button type="button" className="btn-danger btn-sm" onClick={() => reverse(r)}>{t("accounting.button.reverse")}</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
