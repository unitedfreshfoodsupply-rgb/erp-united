"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, FileText, HandCoins } from "lucide-react";
import { CashAccountSelect } from "@/components/accounting/CashAccountSelect";
import { newClientKey } from "@/lib/clientKey";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { systemText } from "@/lib/locale/system-text";

/**
 * Purchasing custody (عهدة شراء): money a buyer holds to pay suppliers. Issuing it waits for a
 * second person's approval; it is spent through supplier payments "from custody" (Accounting →
 * Payments) against the supplier's bill, and the rest is returned to a cash box or bank. Custody is
 * kept apart from salary advances and is never deducted from pay automatically (lib/hr/custody.ts).
 */

type Holder = { id: string; code: string; name: string; nameAr: string | null; active: boolean; purchasingCategory: string | null; held: string; pendingAdvances: string; pendingPayments: string; available: string; missingReceipts: number };
type Party = { id: string; code: string; name: string; nameAr: string | null };
type Statement = {
  employee: Party & { active: boolean; purchasingCategory: string | null };
  rows: { date: string; kind: "advance" | "payment" | "payment_reversal" | "return"; number: string; description: string; supplier?: Party | null; bills?: string[]; in: string; out: string; balance: string; missingReceipt?: boolean; by?: string | null; approvedBy?: string | null; reference?: string | null }[];
  totals: { issued: string; paidToSuppliers: string; returned: string };
  held: string; documents: string; reconciled: boolean; salaryAdvances: string; available: string; missingReceipts: number;
  pending: { advances: { id: string; number: string; date: string; amount: string; reference: string | null; cashAccount: string; cashAccountAr: string | null; requestedBy: string }[]; payments: { id: string; number: string; date: string; amount: string; supplier: Party; requestedBy: string }[]; paymentsTotal: string };
};

const failMsg = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));

export function CustodyView() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const canIssue = can("hr.advances.manage");
  const q = useQuery({ queryKey: ["hr", "custody"], queryFn: () => apiFetch<{ holders: Holder[] }>("/api/hr/custody").then((r) => r.holders) });
  const [dialog, setDialog] = useState<{ type: "advance" | "advance_return"; holder: Holder | null } | null>(null);
  const [statementOf, setStatementOf] = useState<Holder | null>(null);
  const cat = (c: string | null) => (c ? t(`hr.custody.category.${c}`) : t("hr.custody.category.none"));

  return (
    <div className="flex flex-col gap-5">
      <section className="card" aria-labelledby="custody-title">
        <div className="card-header flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="custody-title" className="section-title">{t("hr.custody.title")}</h2>
            <p className="text-xs text-united-muted">{t("hr.custody.hint")}</p>
          </div>
          {canIssue && (
            <button type="button" className="btn-primary" onClick={() => setDialog({ type: "advance", holder: null })}>
              <HandCoins size={16} aria-hidden /> {t("hr.custody.issue")}
            </button>
          )}
        </div>
        {q.isLoading && <LoadingState />}
        {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
        {q.data?.length === 0 && <EmptyState icon="👜" title={t("hr.custody.empty")} />}
        {!!q.data?.length && (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("hr.custody.col.employee")}</th>
                  <th>{t("hr.custody.col.category")}</th>
                  <th className="num">{t("hr.custody.col.held")}</th>
                  <th className="num">{t("hr.custody.col.pending_advances")}</th>
                  <th className="num">{t("hr.custody.col.pending_payments")}</th>
                  <th className="num">{t("hr.custody.col.available")}</th>
                  <th className="num">{t("hr.custody.col.missing_receipts")}</th>
                  <th><span className="sr-only">{t("hr.col.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((h) => (
                  <tr key={h.id} className={h.active ? undefined : "text-united-muted"}>
                    <td className="min-w-[10rem]"><div className="font-medium">{localName(h, locale)}</div><div className="text-xs text-united-muted" dir="ltr">{h.code}</div></td>
                    <td>{cat(h.purchasingCategory)}</td>
                    <td className={`num font-semibold ${Number(h.held) > 0 ? "text-united-warn" : ""}`} dir="ltr">{fmtMoney(h.held)}</td>
                    <td className="num" dir="ltr">{Number(h.pendingAdvances) ? fmtMoney(h.pendingAdvances) : "—"}</td>
                    <td className="num" dir="ltr">{Number(h.pendingPayments) ? fmtMoney(h.pendingPayments) : "—"}</td>
                    <td className="num" dir="ltr">{fmtMoney(h.available)}</td>
                    <td className="num">{h.missingReceipts ? <StatusPill tone="warn">{h.missingReceipts}</StatusPill> : "—"}</td>
                    <td className="whitespace-nowrap text-end">
                      <div className="inline-flex gap-1">
                        <IconButton label={t("hr.custody.statement")} onClick={() => setStatementOf(h)}><FileText size={16} /></IconButton>
                        {canIssue && h.active && <IconButton label={t("hr.custody.issue")} onClick={() => setDialog({ type: "advance", holder: h })}><HandCoins size={16} /></IconButton>}
                        {canIssue && Number(h.available) > 0 && <IconButton label={t("hr.custody.return")} onClick={() => setDialog({ type: "advance_return", holder: h })}><ArrowDownToLine size={16} /></IconButton>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-united-border px-5 py-2.5 text-xs text-united-muted">{t("hr.custody.footnote")}</p>
      </section>
      <MissingReceipts />
      {dialog && <CustodyMoneyDialog type={dialog.type} holder={dialog.holder} onClose={() => setDialog(null)} />}
      {statementOf && <CustodyStatementDialog employee={statementOf} onClose={() => setStatementOf(null)} />}
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

/** Issue custody (a request for approval) or return what is left of it to a cash box / bank. */
function CustodyMoneyDialog({ type, holder, onClose }: { type: "advance" | "advance_return"; holder: Holder | null; onClose: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const emps = useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: (Party & { active: boolean })[] }>("/api/hr/employees"), enabled: !holder });
  const [f, setF] = useState({ employee_id: holder?.id ?? "", amount: "", cash_account_id: "cash_main", date: todayLocalISO(), reference: "", notes: "" });
  const [key, setKey] = useState(newClientKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!f.employee_id && /^\d+(\.\d{1,2})?$/.test(f.amount.trim()) && Number(f.amount) > 0;
  const issuing = type === "advance";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ custodyRequest?: { number: string }; transaction?: { id: string } }>("/api/hr/transactions", { employee_id: f.employee_id, type, purpose: "purchasing_custody", amount: f.amount.trim(), cash_account_id: f.cash_account_id, date: f.date, reference: f.reference.trim() || undefined, notes: f.notes.trim() || undefined, idempotency_key: key });
      setKey(newClientKey());
      toast.show(r.custodyRequest ? t("hr.custody.toast.requested", { ref: r.custodyRequest.number }) : t("hr.custody.toast.returned"), "success");
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
      title={issuing ? t("hr.custody.issue_title") : t("hr.custody.return_title")}
      description={holder ? `${localName(holder, locale)} · ${t("hr.custody.col.available")} ${fmtMoney(holder.available)}` : t("hr.custody.issue_desc")}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
          <button type="submit" form="custody-form" className="btn-primary" disabled={busy || !ready}>{busy ? t("ui.saving") : issuing ? t("hr.custody.request_button") : t("hr.record_button")}</button>
        </>
      }
    >
      <form id="custody-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <p className="text-xs text-united-muted sm:col-span-2">{issuing ? t("hr.custody.effect.advance") : t("hr.custody.effect.return")}</p>
        {!holder && (
          <div className="sm:col-span-2">
            <Field label={t("hr.custody.col.employee")} required>
              <select className="field" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
                <option value="">{t("hr.placeholder.choose")}</option>
                {emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.code} · {localName(e, locale)}</option>)}
              </select>
            </Field>
          </div>
        )}
        <Field label={t("hr.label.amount")} required>
          <input className="field" required autoFocus dir="ltr" inputMode="decimal" autoComplete="off" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label={issuing ? t("hr.custody.source") : t("hr.custody.return_to")} required>
          <CashAccountSelect value={f.cash_account_id} onChange={(id) => setF({ ...f, cash_account_id: id })} />
        </Field>
        <Field label={t("hr.label.date")} required>
          <input type="date" className="field" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value || todayLocalISO() })} />
        </Field>
        <Field label={t("hr.custody.reference")}>
          <input className="field" dir="ltr" maxLength={100} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t("hr.money.notes")}>
            <input className="field" maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>
        {error && <p role="alert" className="text-sm font-medium text-united-danger sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
}

/** Custody issued, paid to suppliers (with the bills), returned — and the balance after each. */
export function CustodyStatementDialog({ employee, onClose }: { employee: Party; onClose: () => void }) {
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["hr", "custody", employee.id], queryFn: () => apiFetch<{ statement: Statement }>(`/api/hr/employees/${employee.id}/custody`).then((r) => r.statement) });
  const kind = (k: string) => t(`hr.custody.kind.${k}`);
  return (
    <Modal open onClose={onClose} size="xl" title={t("hr.custody.statement")} description={localName(employee, locale)} footer={<button type="button" className="btn-secondary" onClick={onClose}>{t("ui.close")}</button>}>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label={t("hr.custody.total.issued")} value={fmtMoney(q.data.totals.issued)} />
            <Metric label={t("hr.custody.total.paid")} value={fmtMoney(q.data.totals.paidToSuppliers)} />
            <Metric label={t("hr.custody.total.returned")} value={fmtMoney(q.data.totals.returned)} />
            <Metric label={t("hr.custody.col.held")} value={fmtMoney(q.data.held)} tone={Number(q.data.held) > 0 ? "text-united-warn" : undefined} />
          </dl>
          <p className="text-xs text-united-muted">
            {q.data.reconciled ? t("hr.custody.reconciled") : t("hr.custody.not_reconciled", { documents: fmtMoney(q.data.documents), held: fmtMoney(q.data.held) })}
            {" · "}{t("hr.custody.salary_apart", { amount: fmtMoney(q.data.salaryAdvances) })}
            {Number(q.data.pending.paymentsTotal) > 0 ? ` · ${t("hr.custody.col.pending_payments")} ${fmtMoney(q.data.pending.paymentsTotal)}` : ""}
          </p>
          {q.data.pending.advances.length > 0 && (
            <ul className="text-sm text-united-warn">
              {q.data.pending.advances.map((a) => <li key={a.id}><span dir="ltr">{a.number}</span> · {a.date} · <span dir="ltr">{fmtMoney(a.amount)}</span> · {t("hr.custody.awaiting_approval")}</li>)}
            </ul>
          )}
          {q.data.rows.length === 0 ? (
            <EmptyState icon="📄" title={t("hr.custody.statement_empty")} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-united-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("hr.label.date")}</th>
                    <th>{t("hr.custody.col.kind")}</th>
                    <th>{t("hr.col.number")}</th>
                    <th>{t("hr.custody.col.supplier")}</th>
                    <th className="num">{t("hr.custody.col.in")}</th>
                    <th className="num">{t("hr.custody.col.out")}</th>
                    <th className="num">{t("hr.custody.col.balance")}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.rows.map((r, i) => (
                    <tr key={`${r.kind}-${r.number}-${i}`}>
                      <td dir="ltr" className="whitespace-nowrap">{r.date}</td>
                      <td className="whitespace-nowrap">{kind(r.kind)}{r.missingReceipt ? <> {" "}<StatusPill tone="warn">{t("hr.custody.missing_receipt")}</StatusPill></> : null}</td>
                      <td dir="ltr" className="whitespace-nowrap text-united-muted">{r.number || "—"}{r.reference ? ` · ${r.reference}` : ""}</td>
                      <td className="min-w-[10rem]">
                        {r.supplier ? localName(r.supplier, locale) : systemText(r.description, locale) || "—"}
                        {r.bills?.length ? <div className="text-xs text-united-muted" dir="ltr">{r.bills.join(", ")}</div> : null}
                        {r.approvedBy ? <div className="text-xs text-united-muted">{t("hr.custody.approved_by", { name: r.approvedBy })}</div> : null}
                      </td>
                      <td className="num" dir="ltr">{Number(r.in) ? fmtMoney(r.in) : ""}</td>
                      <td className="num" dir="ltr">{Number(r.out) ? fmtMoney(r.out) : ""}</td>
                      <td className="num font-semibold" dir="ltr">{fmtMoney(r.balance)}</td>
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

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs font-medium text-united-muted">{label}</dt>
      <dd className={`mt-1 text-lg font-bold ${tone ?? "text-united-dark"}`}><span dir="ltr">{value}</span></dd>
    </div>
  );
}

/** Custody payments with no receipt attached — attach it from Accounting → Payments. */
function MissingReceipts() {
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["hr", "custody", "missing"], queryFn: () => apiFetch<{ payments: { id: string; number: string; date: string; amount: string; supplier: Party; employee: Party | null }[] }>("/api/hr/custody/missing-receipts").then((r) => r.payments) });
  if (!q.data?.length) return null;
  return (
    <section className="card" aria-labelledby="custody-missing">
      <div className="card-header">
        <h2 id="custody-missing" className="section-title">{t("hr.custody.missing_title")}</h2>
        <span className="text-xs text-united-muted">{t("hr.custody.missing_hint")}</span>
      </div>
      <ul className="divide-y divide-united-dark/5 text-sm">
        {q.data.map((p) => (
          <li key={p.id} className="flex justify-between gap-2 px-5 py-2">
            <span><span dir="ltr">{p.number}</span> · {p.date} · {localName(p.supplier, locale)}{p.employee ? ` · ${localName(p.employee, locale)}` : ""}</span>
            <span dir="ltr" className="font-semibold">{fmtMoney(p.amount)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
