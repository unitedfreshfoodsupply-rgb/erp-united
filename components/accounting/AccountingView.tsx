"use client";

import { useState } from "react";
import { CashAccountSelect } from "@/components/accounting/CashAccountSelect";
import { TreasuryView } from "@/components/accounting/TreasuryView";
import { ChartView } from "@/components/accounting/ChartView";
import { VatReturnsView } from "@/components/accounting/VatReturnsView";
import { PeriodsView } from "@/components/accounting/PeriodsView";
import { OpeningBatchView } from "@/components/accounting/OpeningBatchView";
import { JournalRequests } from "@/components/accounting/JournalRequests";
import { controlAccountMovedBy } from "@/lib/accounting/control-accounts";
import { systemText } from "@/lib/locale/system-text";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, errorMessage } from "@/lib/api-client";
import { newClientKey } from "@/lib/clientKey";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { Pagination } from "@/components/ui/Pagination";
import { useLocale } from "@/lib/locale";
import { intlLocale, unitLabel } from "@/lib/format";
import { localName, type LocalizedNameSource } from "@/lib/locale/names";
import { useDialogs } from "@/components/ui/Dialog";
import { LIST_PAGE, ListMore } from "@/components/ui/ListMore";

/**
 * Finance: cash position, customer receipts, supplier payments, journals, trial
 * balance, periods and bank reconciliation. Every number here is read from the
 * ledger the documents post to; nothing on this screen is computed twice.
 */

type Tab = "health" | "treasury" | "chart" | "receipts" | "payments" | "journals" | "trial" | "vat" | "periods" | "reconcile" | "opening";
const yearStart = () => `${todayLocalISO().slice(0, 4)}-01-01`;

// Document source types — translated via t() template key at render time
const SOURCE_TYPES: Record<string, string> = {
  manual: "accounting.source.manual",
  sales_invoice: "accounting.source.sales-invoice",
  credit_note: "accounting.source.credit-note",
  supplier_bill: "accounting.source.supplier-bill",
  debit_note: "accounting.source.debit-note",
  customer_receipt: "accounting.source.customer-receipt",
  supplier_payment: "accounting.source.supplier-payment",
  stock_valuation: "accounting.source.stock-valuation",
  reversal: "accounting.source.reversal",
  expense: "accounting.source.expense",
  employee_transaction: "accounting.source.employee-transaction",
  opening_balance: "accounting.source.opening-balance",
  receipt_reversal: "accounting.source.receipt-reversal",
  payment_reversal: "accounting.source.payment-reversal",
  customer_refund: "accounting.source.customer-refund",
  supplier_refund: "accounting.source.supplier-refund",
  payroll_run: "accounting.source.payroll-run",
  payroll_payment: "accounting.source.payroll-payment",
  cash_transfer: "accounting.source.cash-transfer",
  cash_transfer_reversal: "accounting.source.cash-transfer-reversal",
  vat_settlement: "accounting.source.vat-settlement",
  vat_payment: "accounting.source.vat-payment",
  year_end_close: "accounting.source.year-end-close",
  year_end_reopen: "accounting.source.year-end-reopen",
  asset_acquisition: "accounting.source.asset-acquisition",
  asset_improvement: "accounting.source.asset-improvement",
  asset_depreciation: "accounting.source.asset-depreciation",
  asset_disposal: "accounting.source.asset-disposal",
  opening_batch: "accounting.source.opening-batch",
};

// Payment method labels — used by METHOD dict in templates
const METHOD_LABELS: Record<string, string> = {
  cash: "accounting.method.cash",
  bank_transfer: "accounting.method.bank-transfer",
  cheque: "accounting.method.cheque",
  wallet: "accounting.method.wallet",
  other: "accounting.method.other",
};

/** A receipt or payment as the list endpoints return it (fields this screen reads). */
type SettlementRow = {
  id: string;
  number: string;
  date: string;
  method: string;
  cashAccount: string;
  cashAccountAr?: string | null;
  reference: string | null;
  amount: string;
  cashAmount: string;
  unallocated: string;
  customer?: LocalizedNameSource | null;
  supplier?: LocalizedNameSource | null;
  deductions?: { kind: string; amount: string; reference: string | null }[];
  reversal?: { date: string; reason: string; by: string } | null;
};

function getPartyName(party: LocalizedNameSource | null | undefined, locale: string) {
  // Arabic name in Arabic, English in English, with the shared fallback policy —
  // works whether or not the endpoint sends nameAr.
  return party ? localName(party, locale === "en" ? "en" : "ar") : "";
}

export function AccountingView({ initialTab }: { initialTab?: string } = {}) {
  const { can } = usePermissions();
  const { t } = useLocale();
  // Financial visibility (balances, journals, reports) is accounting.view; a clerk holding
  // only the receipts or payments workflow sees just those tabs. The API enforces the same.
  const full = can("accounting.view");
  const items: { key: Tab; label: string }[] = [
    ...(full ? [{ key: "health" as Tab, label: t("accounting.tab.health") }, { key: "treasury" as Tab, label: t("accounting.tab.treasury") }] : []),
    ...(full || can("accounting.receipts.manage") ? [{ key: "receipts" as Tab, label: t("accounting.tab.receipts") }] : []),
    ...(full || can("accounting.payments.manage") ? [{ key: "payments" as Tab, label: t("accounting.tab.payments") }] : []),
    ...(full ? [
      { key: "chart" as Tab, label: t("accounting.tab.chart") },
      { key: "journals" as Tab, label: t("accounting.tab.journals") },
      { key: "trial" as Tab, label: t("accounting.tab.trial") },
      { key: "vat" as Tab, label: t("accounting.tab.vat") },
      { key: "periods" as Tab, label: t("accounting.tab.periods") },
    ] : []),
    ...(can("accounting.manage") ? [{ key: "reconcile" as Tab, label: t("accounting.tab.reconcile") }, { key: "opening" as Tab, label: t("accounting.tab.opening") }] : []),
  ];
  const [chosen, setTab] = useState<Tab>((initialTab === "cash" ? "treasury" : initialTab) as Tab ?? "health");
  const tab: Tab = items.some((i) => i.key === chosen) ? chosen : items[0]?.key ?? "receipts";
  return (
    <div className="page-container">
      <h1 className="page-title">{t("accounting.title")}</h1>
      <Tabs value={tab} onChange={setTab} items={items} />
      {tab === "health" ? <Health /> : tab === "opening" ? <Opening /> : tab === "treasury" ? <TreasuryView /> : tab === "chart" ? <ChartView /> : tab === "receipts" ? <><MoneyIn kind="receipts" />{(full || can("accounting.payments.manage")) && <Refunds kind="customer" />}</> : tab === "payments" ? <><MoneyIn kind="payments" />{(full || can("accounting.receipts.manage")) && <Refunds kind="supplier" />}</> : tab === "journals" ? <Journals /> : tab === "trial" ? <Trial /> : tab === "vat" ? <><VatSummary /><VatReturnsView /></> : tab === "periods" ? <PeriodsView /> : <Reconcile />}
    </div>
  );
}

/** Receipts from customers or payments to suppliers: the form allocates to open documents (or oldest-first). */
function MoneyIn({ kind }: { kind: "receipts" | "payments" }) {
  const dialogs = useDialogs();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const isReceipt = kind === "receipts";
  const manage = can(isReceipt ? "accounting.receipts.manage" : "accounting.payments.manage");
  const parties = useQuery({
    queryKey: ["acc", "parties", kind],
    queryFn: () => (isReceipt ? apiFetch<{ customers: { id: string; code: string; name: string }[] }>("/api/sales/customers").then((r) => r.customers) : apiFetch<{ suppliers: { id: string; code: string; name: string }[] }>("/api/purchasing/suppliers").then((r) => r.suppliers)),
    enabled: manage,
  });
  const [party, setParty] = useState("");
  const [form, setForm] = useState({ amount: "", method: "cash", cash_account_id: "cash_main", reference: "", date: todayLocalISO() });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  // Settled without cash: tax the customer withheld, a bank charge, a small difference
  // (receipts); tax we withheld (payments). Each kind needs its account configured.
  const [ded, setDed] = useState({ withholding: "", withholding_ref: "", bank_charge: "", write_off: "" });
  const [key, setKey] = useState(newClientKey);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const open = useQuery({
    queryKey: ["acc", "open", kind, party],
    queryFn: () => apiFetch<{ invoices?: { id: string; number: string; dueDate: string; open: string }[]; bills?: { id: string; number: string; dueDate: string; open: string }[] }>(isReceipt ? `/api/accounting/customers/${party}/open-invoices` : `/api/accounting/suppliers/${party}/open-bills`).then((r) => r.invoices ?? r.bills ?? []),
    enabled: !!party,
  });
  const list = useQuery({
    queryKey: ["acc", kind, page],
    queryFn: async () => {
      const r = await apiFetch<Partial<Record<typeof kind, SettlementRow[]>> & { pagination: { total: number; limit: number; offset: number } }>(`/api/accounting/${kind}?limit=${pageSize}&offset=${(page - 1) * pageSize}`);
      const items: SettlementRow[] = r[kind] ?? [];
      const totalPages = Math.max(1, Math.ceil((r.pagination?.total ?? 0) / pageSize));
      return { items, total: r.pagination?.total ?? 0, totalPages };
    },
  });
  const explicit = Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([document_id, amount]) => ({ document_id, amount }));
  const deductions = [
    ...(Number(ded.withholding) > 0 ? [{ kind: "withholding", amount: ded.withholding, reference: ded.withholding_ref.trim() || null }] : []),
    ...(isReceipt && Number(ded.bank_charge) > 0 ? [{ kind: "bank_charge", amount: ded.bank_charge }] : []),
    ...(isReceipt && Number(ded.write_off) > 0 ? [{ kind: "write_off", amount: ded.write_off }] : []),
  ];
  const cashPart = Number(form.amount || 0) - deductions.reduce((s, d) => s + Number(d.amount), 0);
  return (
    <div className="flex flex-col gap-3">
      {manage && (
        <section className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold">{isReceipt ? t("accounting.form.receipt-header") : t("accounting.form.payment-header")}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Field label={isReceipt ? t("accounting.form.party.label-customer") : t("accounting.form.party.label-supplier")}>
              <select className="field font-bold" value={party} onChange={(e) => { setParty(e.target.value); setAlloc({}); }}>
                <option value="">{t("accounting.form.party.placeholder")}</option>
                {parties.data?.map((p) => <option key={p.id} value={p.id}>{getPartyName(p, locale)}</option>)}
              </select>
            </Field>
            <Field label={t("accounting.form.amount")}><input className="field" dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            <Field label={t("accounting.form.date")}><input type="date" className="field" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
            <Field label={t("accounting.form.method")}><select className="field" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{Object.entries(METHOD_LABELS).map(([k, vk]) => <option key={k} value={k}>{t(vk)}</option>)}</select></Field>
            <Field label={t("accounting.form.account.label")}><CashAccountSelect value={form.cash_account_id} onChange={(id) => setForm({ ...form, cash_account_id: id })} /></Field>
            <Field label={t("accounting.form.reference-hint")}><input className="field" dir="ltr" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
          </div>
          <details className="rounded-xl border border-united-border p-2" open={deductions.length > 0}>
            <summary className="text-sm font-extrabold cursor-pointer">{isReceipt ? t("accounting.deductions.receipt-title") : t("accounting.deductions.payment-title")}</summary>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
              <Field label={isReceipt ? t("accounting.deductions.withholding-in") : t("accounting.deductions.withholding-out")}><input className="field" dir="ltr" inputMode="decimal" value={ded.withholding} onChange={(e) => setDed({ ...ded, withholding: e.target.value })} /></Field>
              <Field label={t("accounting.deductions.certificate")}><input className="field" dir="ltr" value={ded.withholding_ref} onChange={(e) => setDed({ ...ded, withholding_ref: e.target.value })} /></Field>
              {isReceipt && <Field label={t("accounting.deductions.bank-charge")}><input className="field" dir="ltr" inputMode="decimal" value={ded.bank_charge} onChange={(e) => setDed({ ...ded, bank_charge: e.target.value })} /></Field>}
              {isReceipt && can("accounting.manage") && <Field label={t("accounting.deductions.write-off")}><input className="field" dir="ltr" inputMode="decimal" value={ded.write_off} onChange={(e) => setDed({ ...ded, write_off: e.target.value })} /></Field>}
            </div>
            <p className="text-xs font-bold text-united-muted mt-1">{t("accounting.deductions.notice")}</p>
          </details>
          {deductions.length > 0 && <p className="text-sm font-extrabold">{isReceipt ? t("accounting.deductions.cash-in") : t("accounting.deductions.cash-out")} <span dir="ltr">{fmtMoney(cashPart.toFixed(2))}</span></p>}
          {party && (open.data?.length ? (
            <ul className="text-sm font-bold divide-y divide-united-dark/5">
              {open.data.map((d) => (
                <li key={d.id} className="py-1 flex items-center justify-between gap-2">
                  <span><span dir="ltr">{d.number}</span> · {t("accounting.due-date")} {d.dueDate} · {t("accounting.open")} <span dir="ltr">{fmtMoney(d.open)}</span></span>
                  <input className="field w-28" dir="ltr" inputMode="decimal" placeholder={t("accounting.form.allocate")} aria-label={`${t("accounting.form.allocate")} ${d.number}`} value={alloc[d.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} />
                </li>
              ))}
            </ul>
          ) : <p className="text-sm font-bold text-united-muted">{t("accounting.empty.no-open-docs")}</p>)}
          <p className="text-xs font-bold text-united-muted">{t("accounting.notice.auto-allocate")}</p>
          <button type="button" className="btn-primary" disabled={!party || !form.amount || busy} onClick={async () => {
            setBusy(true);
            try {
              const r = await apiPost<Record<string, { number: string }>>(`/api/accounting/${kind}`, { party_id: party, amount: form.amount, method: form.method, cash_account_id: form.cash_account_id, reference: form.reference || null, date: form.date, idempotency_key: key, ...(deductions.length ? { deductions } : {}), ...(explicit.length ? { allocations: explicit } : { auto: true }) });
              toast.show(t("accounting.toast-recorded", { ref: (r.receipt ?? r.payment).number }), "success");
              setForm({ ...form, amount: "", reference: "" });
              setAlloc({});
              setDed({ withholding: "", withholding_ref: "", bank_charge: "", write_off: "" });
              setKey(newClientKey());
              void qc.invalidateQueries({ queryKey: ["acc"] });
            } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); } finally { setBusy(false); }
          }}>{isReceipt ? t("accounting.button.record-receipt") : t("accounting.button.record-payment")}</button>
        </section>
      )}
      {list.isLoading && <LoadingState />}
      {list.isError && <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />}
      {list.data?.items.length === 0 && <EmptyState icon="💵" title={t("accounting.empty.no-transactions")} />}
      <ul className="flex flex-col gap-2">
        {list.data?.items.map((r) => (
          <li key={r.id} className={`card p-3 flex justify-between gap-2 text-sm font-bold ${r.reversal ? "opacity-70" : ""}`}>
            <div>
              <div className="font-extrabold"><span dir="ltr">{r.number}</span> · {getPartyName(r.customer, locale) || getPartyName(r.supplier, locale)}</div>
              <div className="text-xs text-united-muted">{r.date} · {METHOD_LABELS[r.method] ? t(METHOD_LABELS[r.method]) : r.method} · {localName({ name: r.cashAccount, nameAr: r.cashAccountAr }, locale)}{r.reference ? <> · <span dir="ltr">{r.reference}</span></> : null}{Number(r.unallocated) > 0 ? ` · ${t("accounting.unallocated")} ${fmtMoney(r.unallocated)}` : ""}</div>
              {(r.deductions?.length ?? 0) > 0 && (
                <div className="text-xs text-united-muted">
                  {r.deductions!.map((d) => `${t(`accounting.deductions.kind.${d.kind}`)} ${fmtMoney(d.amount)}${d.reference ? ` (${d.reference})` : ""}`).join(" · ")} · {isReceipt ? t("accounting.deductions.cash-in") : t("accounting.deductions.cash-out")} <span dir="ltr">{fmtMoney(r.cashAmount)}</span>
                </div>
              )}
              {r.reversal && <div className="text-xs text-united-danger">{t("accounting.reversal-display", { date: r.reversal.date, reason: r.reversal.reason, by: r.reversal.by })}</div>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <span dir="ltr" className={`font-extrabold ${r.reversal ? "line-through" : ""}`}>{fmtMoney(r.amount)}</span>
              {!r.reversal && can("accounting.manage") && (
                <button type="button" className="text-xs text-united-danger underline" onClick={async () => {
                  const reason = await dialogs.prompt({ title: isReceipt ? t("accounting.prompt-reverse-receipt", { number: r.number }) : t("accounting.prompt-reverse-payment", { number: r.number }), label: t("ui.reason-label"), required: true, multiline: true, tone: "danger", confirmLabel: t("accounting.button.reverse") });
                  if (!reason) return;
                  try { await apiPost(`/api/accounting/${kind}/${r.id}/reverse`, { reason }); toast.show(t("accounting.toast-reversed", { n: r.number }), "success"); void qc.invalidateQueries({ queryKey: ["acc"] }); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
                }}>{t("accounting.button.reverse")}</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {list.data && <Pagination page={page} pageSize={pageSize} total={list.data.total} onChange={setPage} />}
      {can("accounting.view") && <Withholding side={isReceipt ? "receivable" : "payable"} />}
    </div>
  );
}

/** Tax withheld this year, per document — reconciled against certificates, or remitted. */
function Withholding({ side }: { side: "receivable" | "payable" }) {
  const { t, locale } = useLocale();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayLocalISO());
  const q = useQuery({
    queryKey: ["acc", "withholding", side, from, to],
    queryFn: () => apiFetch<{ report: { rows: { date: string; document: string; party: LocalizedNameSource & { code: string }; amount: string; reference: string | null }[]; total: string; missingReference: number } }>(`/api/accounting/withholding?side=${side}&from=${from}&to=${to}`).then((r) => r.report),
  });
  if (!q.data?.rows.length) return null;
  return (
    <section className="card p-3 flex flex-col gap-2 text-sm font-bold">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-extrabold">{side === "receivable" ? t("accounting.withholding.title-in") : t("accounting.withholding.title-out")}</h3>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="text-xs">{t("accounting.date-from")} <input type="date" className="field ms-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-xs">{t("accounting.date-to")} <input type="date" className="field ms-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <a className="btn-secondary text-xs" href={`/api/accounting/withholding/export?side=${side}&from=${from}&to=${to}`} download>{t("accounting.withholding.export")}</a>
        </div>
      </div>
      <ul className="divide-y divide-united-dark/5">
        {q.data.rows.map((r) => (
          <li key={r.document} className="py-1 flex justify-between gap-2">
            <span><span dir="ltr">{r.document}</span> · {r.date} · {getPartyName(r.party, locale)}{r.reference ? <> · <span dir="ltr">{r.reference}</span></> : <> · <span className="text-united-warn">{t("accounting.withholding.no-certificate")}</span></>}</span>
            <span dir="ltr">{fmtMoney(r.amount)}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between font-extrabold"><span>{t("accounting.tb-total")}</span><span dir="ltr">{fmtMoney(q.data.total)}</span></div>
    </section>
  );
}

/**
 * Credit a party holds, paid out in money: a customer who returned goods after paying,
 * or a supplier paying us back after a debit note. Never more than the credit — the
 * server refuses it — and each filled form is one key, so a double tap pays once.
 */
function Refunds({ kind }: { kind: "customer" | "supplier" }) {
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const isCustomer = kind === "customer";
  const manage = can(isCustomer ? "accounting.payments.manage" : "accounting.receipts.manage");
  const path = isCustomer ? "customer-refunds" : "supplier-refunds";
  const parties = useQuery({
    queryKey: ["acc", "parties", isCustomer ? "receipts" : "payments"],
    queryFn: () => (isCustomer ? apiFetch<{ customers: { id: string; code: string; name: string }[] }>("/api/sales/customers?include_inactive=1").then((r) => r.customers) : apiFetch<{ suppliers: { id: string; code: string; name: string }[] }>("/api/purchasing/suppliers?include_inactive=1").then((r) => r.suppliers)),
    enabled: manage,
  });
  const [limit, setLimit] = useState(LIST_PAGE);
  const listQ = useQuery({ queryKey: ["acc", path, limit], queryFn: () => apiFetch<{ refunds: { id: string; number: string; date: string; amount: string; method: string; reason: string; createdBy: string; customer?: { name: string }; supplier?: { name: string }; cashAccount: string }[]; total: number }>(`/api/accounting/${path}?limit=${limit}`), placeholderData: keepPreviousData });
  const list = { ...listQ, data: listQ.data?.refunds };
  const [form, setForm] = useState({ party: "", amount: "", method: "cash", cash_account_id: "cash_main", reference: "", reason: "" });
  const [key, setKey] = useState(newClientKey);
  const [busy, setBusy] = useState(false);
  return (
    <section className="card p-4 flex flex-col gap-2">
      <h3 className="font-extrabold">{isCustomer ? t("accounting.refund-customer-header") : t("accounting.refund-supplier-header")}</h3>
      {manage && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Field label={isCustomer ? t("accounting.form.party.label-customer") : t("accounting.form.party.label-supplier")}>
              <select className="field font-bold" value={form.party} onChange={(e) => setForm({ ...form, party: e.target.value })}>
                <option value="">{t("accounting.form.party.placeholder")}</option>
                {parties.data?.map((p) => <option key={p.id} value={p.id}>{getPartyName(p, locale)}</option>)}
              </select>
            </Field>
            <Field label={t("accounting.form.amount")}><input className="field" dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            <Field label={t("accounting.form.method")}><select className="field" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{Object.entries(METHOD_LABELS).map(([k, vk]) => <option key={k} value={k}>{t(vk)}</option>)}</select></Field>
            <Field label={t("accounting.form.account.label")}><CashAccountSelect value={form.cash_account_id} onChange={(id) => setForm({ ...form, cash_account_id: id })} /></Field>
            <Field label={t("accounting.form.reference")}><input className="field" dir="ltr" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
            <Field label={t("accounting.form.reason")}><input className="field" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </div>
          <button type="button" className="btn-secondary" disabled={!form.party || !form.amount || !form.reason.trim() || busy} onClick={async () => {
            setBusy(true);
            try {
              const r = await apiPost<{ refund: { number: string } }>(`/api/accounting/${path}`, { party_id: form.party, amount: form.amount, method: form.method, cash_account_id: form.cash_account_id, reference: form.reference || null, reason: form.reason, idempotency_key: key });
              toast.show(t("accounting.toast-recorded", { ref: r.refund.number }), "success");
              setForm({ ...form, amount: "", reference: "", reason: "" });
              setKey(newClientKey());
              void qc.invalidateQueries({ queryKey: ["acc"] });
            } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); } finally { setBusy(false); }
          }}>{isCustomer ? t("accounting.button.record-customer-refund") : t("accounting.button.record-supplier-refund")}</button>
        </>
      )}
      {list.data?.length ? (
        <ul className="text-sm font-bold divide-y divide-united-dark/5">
          {list.data.map((f) => (
            <li key={f.id} className="py-1 flex justify-between gap-2">
              <span><span dir="ltr">{f.number}</span> · {getPartyName(f.customer, locale) || getPartyName(f.supplier, locale)} · {f.date} · {t(METHOD_LABELS[f.method])} · {f.reason}</span>
              <span dir="ltr" className="font-extrabold">{fmtMoney(f.amount)}</span>
            </li>
          ))}
        </ul>
      ) : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} /> : <p className="text-sm font-bold text-united-muted">{list.isLoading ? t("accounting.empty.loading") : t("accounting.empty.no-transactions")}</p>}
      {listQ.data && <ListMore shown={listQ.data.refunds.length} total={listQ.data.total} busy={listQ.isFetching} onMore={() => setLimit(limit + LIST_PAGE)} />}
    </section>
  );
}

type Journal = { id: string; number: string; date: string; description: string; sourceType: string; total: string; reversedBy?: { number: string } | null; lines?: { id: string; debit: string; credit: string; description: string | null; account: { code: string; name?: string; nameAr: string } }[] };

function Journals() {
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const [jPage, setJPage] = useState(1);
  const jPageSize = 50;
  const q = useQuery({ queryKey: ["acc", "journals", jPage], queryFn: () => apiFetch<{ journals: Journal[]; pagination: { total: number } }>(`/api/accounting/journals?limit=${jPageSize}&offset=${(jPage - 1) * jPageSize}`) });
  const detail = useQuery({ queryKey: ["acc", "journal", open], queryFn: () => apiFetch<{ journal: Journal }>(`/api/accounting/journals/${open}`), enabled: !!open });
  const accounts = useQuery({ queryKey: ["acc", "accounts"], queryFn: () => apiFetch<{ accounts: { id: string; code: string; name: string; nameAr: string; postable: boolean; active: boolean; systemKey: string | null; controlledBy: string | null }[] }>("/api/accounting/accounts"), enabled: can("accounting.manage") });
  const [m, setM] = useState({ date: todayLocalISO(), description: "", lines: [{ account_id: "", debit: "", credit: "" }, { account_id: "", debit: "", credit: "" }] });
  const [mKey, setMKey] = useState(newClientKey);
  return (
    <div className="flex flex-col gap-3">
      <JournalRequests />
      {can("accounting.manage") && (
        <details className="card p-4">
          <summary className="font-extrabold cursor-pointer">{t("accounting.button.manual-journal")}</summary>
          <div className="flex flex-col gap-2 mt-2">
            <div className="grid grid-cols-2 gap-2">
              <input type="date" className="field" aria-label={t("accounting.form.date")} value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} />
              <input className="field" placeholder={t("accounting.description")} value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })}  aria-label={t("accounting.description")}/>
            </div>
            {m.lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_6rem_6rem] gap-2">
                <select className="field" aria-label={t("accounting.account-select")} value={l.account_id} onChange={(e) => setM({ ...m, lines: m.lines.map((x, j) => (j === i ? { ...x, account_id: e.target.value } : x)) })}>
                  <option value="">{t("accounting.account-select")}</option>
                  {accounts.data?.accounts.filter((a) => a.postable && a.active && !controlAccountMovedBy(a.systemKey, a.controlledBy)).map((a) => <option key={a.id} value={a.id}>{a.code} · {localName(a, locale)}</option>)}
                </select>
                <input className="field" dir="ltr" placeholder={t("accounting.debit-placeholder")} aria-label={t("accounting.debit-placeholder")} value={l.debit} onChange={(e) => setM({ ...m, lines: m.lines.map((x, j) => (j === i ? { ...x, debit: e.target.value } : x)) })} />
                <input className="field" dir="ltr" placeholder={t("accounting.credit-placeholder")} aria-label={t("accounting.credit-placeholder")} value={l.credit} onChange={(e) => setM({ ...m, lines: m.lines.map((x, j) => (j === i ? { ...x, credit: e.target.value } : x)) })} />
              </div>
            ))}
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={() => setM({ ...m, lines: [...m.lines, { account_id: "", debit: "", credit: "" }] })}>{t("accounting.button.add-line")}</button>
              <button type="button" className="btn-primary" onClick={async () => {
                try {
                  const res = await apiPost<{ journal?: { number: string }; journalRequest?: { number: string } }>("/api/accounting/journals", { date: m.date, description: m.description, lines: m.lines.filter((l) => l.account_id).map((l) => ({ account_id: l.account_id, debit: l.debit || 0, credit: l.credit || 0 })), idempotency_key: mKey });
                  toast.show(res.journalRequest ? t("journal.toast-pending", { number: res.journalRequest.number }) : t("journal.toast-posted", { number: res.journal?.number ?? "" }), "success");
                  setMKey(newClientKey());
                  setM({ date: todayLocalISO(), description: "", lines: [{ account_id: "", debit: "", credit: "" }, { account_id: "", debit: "", credit: "" }] });
                  void qc.invalidateQueries({ queryKey: ["acc"] });
                } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
              }}>{t("accounting.button.post")}</button>
            </div>
          </div>
        </details>
      )}
      {open && detail.data && (() => {
        const j = detail.data.journal;
        const sum = (k: "debit" | "credit") => (j.lines ?? []).reduce((n, l) => n + Number(l[k]), 0);
        return (
          <section className="card overflow-hidden">
            <div className="card-header">
              <div className="min-w-0">
                <h3 className="section-title"><bdi dir="ltr">{j.number}</bdi> · {j.date}</h3>
                <p className="text-sm text-united-muted">{t(SOURCE_TYPES[j.sourceType])} · <bdi>{systemText(j.description, locale)}</bdi></p>
              </div>
              <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setOpen(null)}>{t("accounting.button.close")}</button>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>{t("accounting.col.account")}</th><th>{t("accounting.col.line-note")}</th><th className="num">{t("accounting.debit-placeholder")}</th><th className="num">{t("accounting.credit-placeholder")}</th></tr></thead>
                <tbody>
                  {j.lines?.map((l) => (
                    <tr key={l.id}>
                      <td><span dir="ltr" className="text-united-muted">{l.account.code}</span> · {localName(l.account, locale)}</td>
                      <td className="text-united-muted">{l.description ? <bdi>{systemText(l.description, locale)}</bdi> : "—"}</td>
                      <td dir="ltr" className="num tabular-nums">{Number(l.debit) ? fmtMoney(l.debit) : ""}</td>
                      <td dir="ltr" className="num tabular-nums">{Number(l.credit) ? fmtMoney(l.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={2}>{t("accounting.col.total")}</td><td dir="ltr" className="num tabular-nums">{fmtMoney(sum("debit"))}</td><td dir="ltr" className="num tabular-nums">{fmtMoney(sum("credit"))}</td></tr></tfoot>
              </table>
            </div>
            {j.reversedBy && <p className="px-5 py-3 text-sm font-semibold text-united-danger">{t("accounting.reversed-by", { n: j.reversedBy.number })}</p>}
          </section>
        );
      })()}
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error) ?? t("ui.error.generic")} onRetry={() => q.refetch()} />}
      {q.data && !q.data.journals.length && <EmptyState title={t("accounting.journals-empty")} />}
      {!!q.data?.journals.length && (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("accounting.col.number")}</th>
                <th>{t("accounting.col.date")}</th>
                <th>{t("accounting.col.source")}</th>
                <th>{t("accounting.description")}</th>
                <th className="num">{t("accounting.col.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.journals.map((j) => (
                <tr key={j.id} className={`cursor-pointer ${open === j.id ? "bg-united-green/5" : ""}`} onClick={() => setOpen(j.id)}>
                  <td className="whitespace-nowrap">
                    <button type="button" className="font-semibold text-united-green hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(j.id); }}>
                      <bdi dir="ltr">{j.number}</bdi>
                    </button>
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{j.date}</td>
                  <td className="whitespace-nowrap text-united-muted">{t(SOURCE_TYPES[j.sourceType])}</td>
                  <td className="min-w-[16rem]"><bdi>{systemText(j.description, locale)}</bdi></td>
                  <td dir="ltr" className="num whitespace-nowrap tabular-nums font-semibold">{fmtMoney(j.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination page={jPage} pageSize={jPageSize} total={q.data.pagination?.total ?? 0} onChange={setJPage} />}
    </div>
  );
}

function Trial() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayLocalISO());
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["acc", "tb", from, to], queryFn: () => apiFetch<{ trialBalance: { lines: { account: { code: string; name: string; nameAr?: string; nameEn?: string; id: string }; opening: string; debit: string; credit: string; closing: string }[]; totals: { debit: string; credit: string }; balanced: boolean } }>(`/api/accounting/trial-balance?from=${from}&to=${to}`) });
  const ledger = useQuery({
    queryKey: ["acc", "ledger", activeAccount, from, to],
    queryFn: () => apiFetch<{ ledger: { lines: { date: string; number: string; description: string; debit: string; credit: string }[]; account: { code: string; name: string; nameAr?: string; nameEn?: string }; opening: string; closing: string; pagination?: { total: number; limit: number; offset: number } } }>(`/api/accounting/accounts/${activeAccount}/ledger?from=${from}&to=${to}`),
    enabled: !!activeAccount,
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2"><label className="text-xs font-bold">{t("accounting.date-from")} <input type="date" className="field ms-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="text-xs font-bold">{t("accounting.date-to")} <input type="date" className="field ms-1" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      {q.isLoading && <LoadingState />}
      {q.data && (
        <section className="card overflow-x-auto">
          {/* All shown amounts are formatted identically (2 decimals); a negative
              opening/closing balance means the account stands at credit — shown
              explicitly as creditor label so the sign is never misread. */}
          {(() => { const fmt = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 }); return (
          <table className="data-table">
            <thead><tr><th>{t("accounting.tb.account")}</th><th className="num">{t("accounting.tb-opening")}</th><th className="num">{t("accounting.tb-debit")}</th><th className="num">{t("accounting.tb-credit")}</th><th className="num">{t("accounting.tb-closing")}</th></tr></thead>
            <tbody>
              {q.data.trialBalance.lines.map((l) => (
                <tr key={l.account.code} className={activeAccount === l.account.id ? "bg-united-green/5" : undefined}>
                  <td>
                    {/* A real button, so the drill-down to the account ledger works from the keyboard too. */}
                    <button type="button" aria-expanded={activeAccount === l.account.id} onClick={() => setActiveAccount(activeAccount === l.account.id ? null : l.account.id)} className="text-start font-medium text-united-dark hover:text-united-green hover:underline">
                      <span dir="ltr" className="text-united-muted">{l.account.code}</span> · {localName(l.account, locale)}
                    </button>
                  </td>
                  {[l.opening, l.debit, l.credit, l.closing].map((v, i) => {
                    const n = Number(v);
                    const formatted = fmt(v);
                    const isBalanceColumn = i === 0 || i === 3;
                    const label = n < 0 && isBalanceColumn ? `${t("accounting.creditor-label")}${formatted.replace("-", "")}` : formatted;
                    return <td key={i} className={`num ${n < 0 && isBalanceColumn ? "text-united-danger/80" : ""}`} dir="ltr">{label}</td>;
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>{t("accounting.tb-total")} <span className={q.data.trialBalance.balanced ? "text-united-green" : "text-united-danger"}>{q.data.trialBalance.balanced ? t("accounting.tb-balanced-ok") : t("accounting.tb-balanced-no")}</span></td><td /><td className="num" dir="ltr">{fmt(q.data.trialBalance.totals.debit)}</td><td className="num" dir="ltr">{fmt(q.data.trialBalance.totals.credit)}</td><td /></tr>
            </tfoot>
          </table>
          ); })()}
        </section>
      )}
      {activeAccount && ledger.isLoading && <LoadingState />}
      {activeAccount && ledger.isError && <ErrorState message={errorMessage(ledger.error)} onRetry={() => ledger.refetch()} />}
      {activeAccount && ledger.data && (
        <section className="card p-3 text-sm font-bold">
          <div className="flex justify-between mb-2">
            <span>{t("accounting.parent-ledger")} {localName(ledger.data.ledger.account, locale)} ({ledger.data.ledger.account.code}) — {t("accounting.date-from")} {from} {t("accounting.date-to")} {to}</span>
            <span className="font-extrabold">{t("accounting.closing-balance")} <span dir="ltr">{fmtMoney(ledger.data.ledger.closing)}</span></span>
          </div>
          {ledger.data.ledger.lines.length === 0 && <p className="text-united-muted">{t("accounting.no-transactions")}</p>}
          <div className="flex flex-col gap-1">
            {ledger.data.ledger.lines.map((l) => (
              <div key={l.date + l.number + l.description} className="grid grid-cols-[1fr_6rem_6rem] gap-2">
                <span>{l.date} · <span dir="ltr">{l.number}</span> · {systemText(l.description, locale)}</span>
                <span dir="ltr" className="num">{Number(l.debit) ? fmtMoney(l.debit) : ""}</span>
                <span dir="ltr" className="num">{Number(l.credit) ? fmtMoney(l.credit) : ""}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function VatSummary() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayLocalISO());
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["acc", "vat", from, to], queryFn: () => apiFetch<{ summary: { from: string; to: string; lines: { taxCode: string; taxName: string; taxNameEn?: string; rate: string; outputBase: string; outputTax: string; inputBase: string; inputTax: string }[]; totals: { outputBase: string; outputTax: string; inputBase: string; inputTax: string; netPayable: string }; ledger: { outputDebit: string; outputCredit: string; outputExpectedCredit: string; outputDifference: string; inputDebit: string; inputCredit: string; inputExpectedDebit: string; inputDifference: string; reconciled: boolean } } }>(`/api/accounting/vat-summary?from=${from}&to=${to}`) });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2"><label className="text-xs font-bold">{t("accounting.date-from")} <input type="date" className="field ms-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="text-xs font-bold">{t("accounting.date-to")} <input type="date" className="field ms-1" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      <p className="card p-3 text-sm font-bold text-united-warn">{t("accounting.warning.internal-review")}</p>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && <>
        <section className={`card p-3 text-sm font-extrabold ${q.data.summary.ledger.reconciled ? "text-united-green" : "text-united-danger"}`}>
          {q.data.summary.ledger.reconciled ? t("accounting.status.matched") : t("accounting.status.difference", { output: fmtMoney(q.data.summary.ledger.outputDifference), input: fmtMoney(q.data.summary.ledger.inputDifference) })}
        </section>
        <section className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("accounting.vat-classification")}</th><th className="num">{t("accounting.vat-rate")}</th><th className="num">{t("accounting.vat-taxable-sales")}</th><th className="num">{t("accounting.vat-output-tax")}</th><th className="num">{t("accounting.vat-taxable-purchases")}</th><th className="num">{t("accounting.vat-input-tax")}</th></tr></thead>
            <tbody>{q.data.summary.lines.map((line) => <tr key={`${line.taxCode}-${line.rate}`} ><td>{locale === "en" ? line.taxNameEn ?? line.taxName : line.taxName} <span dir="ltr" className="ms-1 rounded bg-united-subtle px-1 text-xs text-united-muted">{line.taxCode}</span></td><td className="num" dir="ltr">{line.rate}%</td><td className="num" dir="ltr">{fmtMoney(line.outputBase)}</td><td className="num" dir="ltr">{fmtMoney(line.outputTax)}</td><td className="num" dir="ltr">{fmtMoney(line.inputBase)}</td><td className="num" dir="ltr">{fmtMoney(line.inputTax)}</td></tr>)}
            </tbody>
            <tfoot>
              <tr><td>{t("accounting.tb-total")}</td><td /><td className="num" dir="ltr">{fmtMoney(q.data.summary.totals.outputBase)}</td><td className="num" dir="ltr">{fmtMoney(q.data.summary.totals.outputTax)}</td><td className="num" dir="ltr">{fmtMoney(q.data.summary.totals.inputBase)}</td><td className="num" dir="ltr">{fmtMoney(q.data.summary.totals.inputTax)}</td></tr>
            </tfoot>
          </table>
        </section>
        <section className="card p-3 flex flex-wrap justify-between gap-2 text-sm font-extrabold"><span>{t("accounting.net-payable")}</span><span dir="ltr">{fmtMoney(q.data.summary.totals.netPayable)}</span></section>
        <p className="text-xs font-bold text-united-muted">{t("accounting.comparison-note")}</p>
      </>}
    </div>
  );
}

function Reconcile() {
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const [form, setForm] = useState({ cash_account_id: "bank_main", statement_date: todayLocalISO(), statement_balance: "" });
  const [recId, setRecId] = useState<string | null>(null);
  const rec = useQuery({ queryKey: ["acc", "rec", recId], queryFn: () => apiFetch<{ reconciliation: { status: string; statementBalance: string; clearedBalance: string; difference: string; lines: { id: string; date: string; number: string; description: string; debit: string; credit: string; cleared: boolean }[] } }>(`/api/accounting/reconciliations/${recId}`), enabled: !!recId });
  const mark = async (ids: string[], cleared: boolean) => {
    try { await apiPost(`/api/accounting/reconciliations/${recId}/mark`, { line_ids: ids, cleared }); void qc.invalidateQueries({ queryKey: ["acc", "rec", recId] }); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  if (!recId) {
    return (
      <section className="card p-4 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <Field label={t("accounting.rec-account")}><CashAccountSelect value={form.cash_account_id} onChange={(id) => setForm({ ...form, cash_account_id: id })} /></Field>
        <Field label={t("accounting.rec-statement-date")}><input type="date" className="field" value={form.statement_date} onChange={(e) => setForm({ ...form, statement_date: e.target.value })} /></Field>
        <Field label={t("accounting.rec-statement-balance")}><input className="field" dir="ltr" inputMode="decimal" value={form.statement_balance} onChange={(e) => setForm({ ...form, statement_balance: e.target.value })} /></Field>
        <button type="button" className="btn-primary self-end" onClick={async () => {
          try { const r = await apiPost<{ reconciliation: { id: string } }>("/api/accounting/reconciliations", form); setRecId(r.reconciliation.id); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
        }}>{t("accounting.button.start-reconcile")}</button>
      </section>
    );
  }
  const r = rec.data?.reconciliation;
  if (!r) return <LoadingState />;
  return (
    <div className="flex flex-col gap-3">
      <section className="card p-4 grid grid-cols-3 gap-2 font-bold text-sm">
        <div>{t("accounting.rec.statement-balance")} <div dir="ltr" className="text-lg font-extrabold">{fmtMoney(r.statementBalance)}</div></div>
        <div>{t("accounting.rec.book-matched")} <div dir="ltr" className="text-lg font-extrabold">{fmtMoney(r.clearedBalance)}</div></div>
        <div>{t("accounting.rec.difference")} <div dir="ltr" className={`text-lg font-extrabold ${Number(r.difference) ? "text-united-danger" : "text-united-green"}`}>{fmtMoney(r.difference)}</div></div>
      </section>
      <ul className="card p-3 flex flex-col divide-y divide-united-dark/5 text-sm font-bold">
        {r.lines.map((l) => (
          <li key={l.id} className="py-1 flex items-center gap-2">
            <input type="checkbox" className="w-5 h-5" checked={l.cleared} disabled={r.status !== "open"} onChange={() => mark([l.id], !l.cleared)} aria-label={l.number} />
            <span className="flex-1">{l.date} · <span dir="ltr">{l.number}</span> · {systemText(l.description, locale)}</span>
            <span dir="ltr">{Number(l.debit) ? `+${l.debit}` : `-${l.credit}`}</span>
          </li>
        ))}
        {r.lines.length === 0 && <EmptyState icon="🏦" title={t("accounting.empty.no-reconcile-items")} />}
      </ul>
      {r.status === "open" && <button type="button" className="btn-primary" onClick={async () => {
        try { await apiPost(`/api/accounting/reconciliations/${recId}/complete`, {}); toast.show(t("accounting.toast-reconciled"), "success"); void qc.invalidateQueries({ queryKey: ["acc"] }); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
      }}>{t("accounting.button.finish-reconcile")}</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts health: every subledger against its GL account
// ---------------------------------------------------------------------------

type Check = { key: string; label: string; ok: boolean; subledger?: string; ledger?: string; difference?: string; count?: number; detail?: unknown };

type WasteRow = { productId: string; name: string; nameAr: string | null; unit: string; quantity: string; value: string };

function Health() {
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["acc", "integrity"], queryFn: () => apiFetch<{ integrity: { ok: boolean; checkedAt: string; checks: Check[] } }>("/api/accounting/integrity") });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const r = q.data.integrity;
  // Labels come from the dictionary by check key; the server's Arabic label covers a check
  // this build does not know yet.
  const checkLabel = (c: Check) => {
    const k = `accounting.integrity.${c.key}`;
    const label = t(k);
    return label === k ? c.label : label;
  };
  return (
    <div className="flex flex-col gap-3">
      <section className={`card p-4 font-extrabold ${r.ok ? "bg-united-green/10 text-united-green" : "bg-united-danger/10 text-united-danger"}`}>
        {r.ok ? t("accounting.health-matched") : t("accounting.health-diff")}
        <div className="text-xs font-bold text-united-muted mt-1">{t("accounting.last-checked")} {new Date(r.checkedAt).toLocaleString(intlLocale(locale))}</div>
      </section>
      <ul className="flex flex-col gap-2">
        {r.checks.map((c) => (
          <li key={c.key} className="card p-3 flex flex-col gap-1 text-sm font-bold">
            <div className="flex justify-between gap-2"><span>{c.ok ? "✓" : "✗"} {checkLabel(c)}</span>{c.count !== undefined && !["waste_pending", "payroll"].includes(c.key) && <span>{c.count}</span>}</div>
            {c.subledger !== undefined && c.ledger !== undefined && (
              <div className="text-xs text-united-muted flex flex-wrap gap-3">
                <span>{t("accounting.detail.documents")} <span dir="ltr">{fmtMoney(c.subledger)}</span></span>
                <span>{t("accounting.detail.general-ledger")} <span dir="ltr">{fmtMoney(c.ledger)}</span></span>
                {c.difference !== undefined && <span className={Number(c.difference) ? "text-united-danger" : ""}>{t("accounting.detail.difference")} <span dir="ltr">{fmtMoney(c.difference)}</span></span>}
              </div>
            )}
            {c.key !== "grni" && c.key !== "waste_pending" && c.subledger === undefined && c.ledger !== undefined && <div className="text-xs text-united-muted" dir="ltr">{fmtMoney(c.ledger)}</div>}
            {c.key === "waste_pending" && (
              <div className="text-xs text-united-muted flex flex-col gap-1">
                <span>{t("accounting.waste-note")}: <span dir="ltr">{fmtMoney(c.ledger)}</span></span>
                {Array.isArray(c.detail) && c.detail.length > 0 && (
                  <ul className="flex flex-col">
                    {(c.detail as WasteRow[]).map((w) => (
                      <li key={w.productId} className="flex justify-between gap-2"><span>{localName(w, locale)}</span><span dir="ltr">{fmtQty(w.quantity, w.unit)} · {fmtMoney(w.value)}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {c.key === "grni" && <div className="text-xs text-united-muted">{t("accounting.grni-note")}: <span dir="ltr">{fmtMoney(c.ledger)}</span></div>}
            {!c.ok && Array.isArray(c.detail) && c.detail.length > 0 && <pre className="text-xs whitespace-pre-wrap text-united-danger" dir="ltr">{JSON.stringify(c.detail, null, 1)}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Go-live: balances and stock brought over from the old system
// ---------------------------------------------------------------------------

function Opening() {
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const customers = useQuery({ queryKey: ["acc", "parties", "receipts"], queryFn: () => apiFetch<{ customers: { id: string; code: string; name: string }[] }>("/api/sales/customers").then((r) => r.customers) });
  const suppliers = useQuery({ queryKey: ["acc", "parties", "payments"], queryFn: () => apiFetch<{ suppliers: { id: string; code: string; name: string }[] }>("/api/purchasing/suppliers").then((r) => r.suppliers) });
  const products = useQuery({ queryKey: ["acc", "products"], queryFn: () => apiFetch<{ products: { id: string; name: string; unit: string }[] }>("/api/stock/products").then((r) => r.products) });
  const list = useQuery({ queryKey: ["acc", "opening"], queryFn: () => apiFetch<{ openingBalances: { id: string; partyType: string; date: string; amount: string; reference: string | null; party: { code: string; name: string } | null }[] }>("/api/accounting/opening-balances") });
  const [b, setB] = useState({ party_type: "customer", party_id: "", amount: "", date: todayLocalISO(), due_date: "", reference: "" });
  const [bKey, setBKey] = useState(newClientKey);
  const [sKey, setSKey] = useState(newClientKey);
  const [stock, setStock] = useState<{ product_id: string; quantity: string; unit_cost: string; expiry_date: string }[]>([{ product_id: "", quantity: "", unit_cost: "", expiry_date: "" }]);
  const parties = b.party_type === "customer" ? customers.data : suppliers.data;
  const done = (msg: string) => { toast.show(msg, "success"); void qc.invalidateQueries({ queryKey: ["acc"] }); };
  return (
    <div className="flex flex-col gap-3">
      <OpeningBatchView />
      <h2 className="section-title mt-4">{t("opening.direct-title")}</h2>
      <p className="text-sm font-bold text-united-muted">{t("opening.direct-explain")}</p>
      <p className="text-sm font-bold text-united-muted">{t("accounting.info-go-live")}</p>
      <section className="card p-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
        <h3 className="font-extrabold col-span-full">{t("accounting.info-heading")}</h3>
        <Field label={t("accounting.info-type")}><select className="field" value={b.party_type} onChange={(e) => setB({ ...b, party_type: e.target.value, party_id: "" })}><option value="customer">{t("accounting.info-type-customer")}</option><option value="supplier">{t("accounting.info-type-supplier")}</option></select></Field>
        <Field label={b.party_type === "customer" ? t("accounting.form.party.label-customer") : t("accounting.form.party.label-supplier")}><select className="field" value={b.party_id} onChange={(e) => setB({ ...b, party_id: e.target.value })}><option value="">{t("accounting.form.party.placeholder")}</option>{parties?.map((p) => <option key={p.id} value={p.id}>{getPartyName(p, locale)}</option>)}</select></Field>
        <Field label={b.party_type === "customer" ? t("accounting.info-amount-customer") : t("accounting.info-amount-supplier")}><input className="field" dir="ltr" inputMode="decimal" value={b.amount} onChange={(e) => setB({ ...b, amount: e.target.value })} /></Field>
        <Field label={t("accounting.form.date")}><input type="date" className="field" value={b.date} onChange={(e) => setB({ ...b, date: e.target.value })} /></Field>
        <Field label={t("accounting.info-due-date")}><input type="date" className="field" value={b.due_date} onChange={(e) => setB({ ...b, due_date: e.target.value })} /></Field>
        <Field label={t("accounting.form.reference")}><input className="field" value={b.reference} onChange={(e) => setB({ ...b, reference: e.target.value })} /></Field>
        <button type="button" className="btn-primary col-span-full" disabled={!b.party_id || !b.amount} onClick={async () => {
          try { await apiPost("/api/accounting/opening-balances", { ...b, due_date: b.due_date || undefined, reference: b.reference || null, idempotency_key: bKey }); setBKey(newClientKey()); setB({ ...b, party_id: "", amount: "", reference: "" }); done(t("accounting-toast-opening-saved")); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
        }}>{t("accounting.button.record-opening")}</button>
      </section>
      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("accounting.opening-stock")}</h3>
        {stock.map((l, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <select className="field" value={l.product_id} onChange={(e) => setStock(stock.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))} aria-label={t("accounting.product-label")}><option value="">{t("accounting.product-label")}</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{localName(p, locale)} ({unitLabel(p.unit)})</option>)}</select>
            <input className="field" dir="ltr" inputMode="decimal" placeholder={t("stock.qty")} value={l.quantity} onChange={(e) => setStock(stock.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}  aria-label={t("stock.qty")}/>
            <input className="field" dir="ltr" inputMode="decimal" placeholder={t("stock.unit-cost")} value={l.unit_cost} onChange={(e) => setStock(stock.map((x, j) => (j === i ? { ...x, unit_cost: e.target.value } : x)))}  aria-label={t("stock.unit-cost")}/>
            <input type="date" className="field" aria-label={t("accounting.info-expiry")} value={l.expiry_date} onChange={(e) => setStock(stock.map((x, j) => (j === i ? { ...x, expiry_date: e.target.value } : x)))} />
          </div>
        ))}
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => setStock([...stock, { product_id: "", quantity: "", unit_cost: "", expiry_date: "" }])}>{t("accounting.button.add-item")}</button>
          <button type="button" className="btn-primary" onClick={async () => {
            try { await apiPost("/api/accounting/opening-stock", { lines: stock.filter((l) => l.product_id).map((l) => ({ ...l, expiry_date: l.expiry_date || undefined })), idempotency_key: sKey }); setSKey(newClientKey()); setStock([{ product_id: "", quantity: "", unit_cost: "", expiry_date: "" }]); done(t("accounting-toast-stock-saved")); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
          }}>{t("accounting.button.record-stock")}</button>
        </div>
      </section>
      <ul className="flex flex-col gap-1 text-sm font-bold">
        {list.data?.openingBalances.map((o) => (
          <li key={o.id} className="card p-2 flex justify-between"><span>{o.partyType === "customer" ? t("accounting.info-type-customer") : t("accounting.info-type-supplier")} · {getPartyName(o.party, locale)} · {o.date}{o.reference ? ` · ${o.reference}` : ""}</span><span dir="ltr">{fmtMoney(o.amount)}</span></li>
        ))}
      </ul>
    </div>
  );
}
