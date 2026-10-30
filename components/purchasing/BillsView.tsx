"use client";

import { useState, useMemo } from "react";
import { systemText } from "@/lib/locale/system-text";
import { newClientKey } from "@/lib/clientKey";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { apiFetch, apiPost, apiPut, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { Segmented } from "@/components/ui/Segmented";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { isServiceBillAccount } from "@/lib/purchasing/service-accounts";
import { LIST_PAGE, ListMore } from "@/components/ui/ListMore";

/**
 * Supplier bills and payables (finance). A bill is booked from the supplier's invoice
 * against receipts not yet billed; each line shows what was agreed next to what is
 * billed, and the server decides whether it posts or waits for approval. Payables: AP
 * aging, and a supplier's statement from there.
 */

const fail = (toast: ReturnType<typeof useToast>, err: unknown, t: (key: string) => string) => toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error-generic"), "error");

// Labels are dictionary keys, translated at render with the active locale.
export const BILL_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "bills.status.draft", cls: "bg-united-dark/5" },
  pending_approval: { label: "bills.status.pending_approval", cls: "bg-united-warn/10 text-united-warn" },
  posted: { label: "bills.status.posted", cls: "bg-united-green/10 text-united-green" },
  cancelled: { label: "bills.status.cancelled", cls: "bg-united-danger/10 text-united-danger" },
};
const MATCH: Record<string, { label: string; cls: string }> = {
  matched: { label: "bills.match.matched", cls: "text-united-green" },
  within_tolerance: { label: "bills.match.within_tolerance", cls: "text-united-green" },
  variance: { label: "bills.match.variance", cls: "text-united-danger" },
  unpriced: { label: "bills.match.unpriced", cls: "text-united-warn" },
};

type BillRow = { id: string; number: string; status: string; kind?: string; supplier: { id: string; code: string; name: string; nameAr?: string | null }; supplierInvoiceNo: string; billDate: string; dueDate: string; lineCount: number; total: string; variance: string; matchStatus: string; open: string | null };
type BillLine = { id: string; lineNo: number; intakeId: string; receiptNumber: string; receivedDate: string; poNumber: string | null; description: string; uomCode: string; receivedQty: string; quantity: string; unitPrice: string; expectedUnitPrice: string | null; expectedNet: string | null; lineVariance: string | null; taxCode: string; net: string; tax: string; total: string; debitedQty: string };
type ServiceLine = { id: string; lineNo: number; accountId: string; account: { code: string; name: string; nameAr: string }; description: string; taxCode: string; taxRate: string; net: string; tax: string; total: string; debitedNet: string };
type Bill = Omit<BillRow, "lineCount"> & { currencyCode: string; notes: string | null; cancelReason: string | null; expectedNet: string; net: string; taxTotal: string; debited: string; approvalId: string | null; createdBy: string; postedBy: string | null; approvedBy: string | null; version: number; lines: BillLine[]; serviceLines: ServiceLine[]; debitNotes: { id: string; number: string; issueDate: string; reason: string; total: string; createdBy: string }[] };
type Billable = { intakeId: string; receiptNumber: string; receivedDate: string; product: { id: string; name: string; unit: string }; poNumber: string | null; goodQty: string; expectedUnitPrice: string | null; priceSource: string | null; expectedNet: string | null; taxCode: string; taxRate: string };


export function BillsView({ initialBillId }: { initialBillId?: string | null }) {
  const { t } = useLocale();
  const [view, setView] = useState<"bills" | "payables">("bills");
  const [billId, setBillId] = useState<string | null>(initialBillId ?? null);
  if (billId) return <BillDetail id={billId} onClose={() => setBillId(null)} />;
  return (
    <div className="flex flex-col gap-3">
      <Segmented value={view} onChange={setView} items={[{ key: "bills", label: t("purchasing.bill.tabs.bills") }, { key: "payables", label: t("purchasing.bill.tabs.payables") }]} />
      {view === "bills" ? <Bills onOpen={setBillId} /> : <Payables />}
    </div>
  );
}

function Bills({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState<"goods" | "service" | null>(null);
  const [limit, setLimit] = useState(LIST_PAGE);
  const q = useQuery({ queryKey: ["purchasing", "bills", status, limit], queryFn: () => apiFetch<{ bills: BillRow[]; total: number }>(`/api/purchasing/bills?limit=${limit}${status ? `&status=${status}` : ""}`), placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === status ? prev : undefined) });
  const done = (id?: string) => { setCreating(null); if (id) onOpen(id); };
  if (creating === "goods") return <NewBill onDone={done} />;
  if (creating === "service") return <NewServiceBill onDone={done} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <div className="min-w-0 flex-1"><Segmented value={status} onChange={(s) => { setStatus(s); setLimit(LIST_PAGE); }} items={[{ key: "", label: t("purchasing.bill.filter.all") }, { key: "draft", label: t("purchasing.bill.filter.drafts") }, { key: "pending_approval", label: t("purchasing.bill.filter.pending_approval") }, { key: "posted", label: t("purchasing.bill.filter.posted") }]} /></div>
        {can("purchasing.bills.manage") && <button type="button" className="btn-primary shrink-0" onClick={() => setCreating("goods")}>{t("purchasing.bill.new_supplier")}</button>}
        {can("purchasing.bills.manage") && <button type="button" className="btn-secondary shrink-0" onClick={() => setCreating("service")}>{t("purchasing.bill.new_service")}</button>}
      </div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && q.data.bills.length === 0 && <EmptyState icon="🧾" title={t("purchasing.bill.empty")} />}
      <ul className="flex flex-col gap-2">
        {q.data?.bills.map((b) => (
          <li key={b.id}>
            <button type="button" className="card p-3 w-full text-start flex justify-between gap-2" onClick={() => onOpen(b.id)}>
              <div>
                <div className="font-extrabold"><span dir="ltr">{b.number}</span> · {localName(b.supplier, locale)}{b.kind === "service" ? <span className="ms-2 rounded-full px-2 text-xs bg-united-dark/5">{t("purchasing.bill.kind_service")}</span> : null}</div>
                <div className="text-xs font-bold text-united-muted">{t("purchasing.bill.supplier_invoice_label")} <span dir="ltr">{b.supplierInvoiceNo}</span> · {b.billDate} · {t("purchasing.bill.due_date")} {b.dueDate} · <span className={MATCH[b.matchStatus]?.cls}>{MATCH[b.matchStatus] ? t(MATCH[b.matchStatus].label) : b.matchStatus}</span></div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className={`rounded-full px-2 text-xs font-extrabold ${BILL_STATUS[b.status]?.cls}`}>{BILL_STATUS[b.status] ? t(BILL_STATUS[b.status].label) : b.status}</span>
                <span dir="ltr" className="font-extrabold">{fmtMoney(b.total)}</span>
                {b.open !== null && b.open !== b.total && <span className="text-xs font-bold text-united-muted">{t("purchasing.bill.remaining")} <span dir="ltr">{fmtMoney(b.open)}</span></span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {q.data && <ListMore shown={q.data.bills.length} total={q.data.total} busy={q.isFetching} onMore={() => setLimit(limit + LIST_PAGE)} />}
    </div>
  );
}

/** Pick the supplier, tick the receipts on the invoice, type what the supplier charged. */
function NewBill({ onDone, bill }: { onDone: (id?: string) => void; bill?: Bill }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const suppliers = useQuery({ queryKey: ["purchasing", "suppliers"], queryFn: () => apiFetch<{ suppliers: { id: string; code: string; name: string }[] }>("/api/purchasing/suppliers") });
  const [supplierId, setSupplierId] = useState(bill?.supplier.id ?? "");
  const [invoiceNo, setInvoiceNo] = useState(bill?.supplierInvoiceNo ?? "");
  const [billDate, setBillDate] = useState(bill?.billDate ?? todayLocalISO());
  const [notes, setNotes] = useState(bill?.notes ?? "");
  // intakeId → billed unit price (per base unit); presence = ticked.
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries((bill?.lines ?? []).map((l) => [l.intakeId, l.unitPrice])));
  const [busy, setBusy] = useState(false);
  const billable = useQuery({
    queryKey: ["purchasing", "billable", supplierId],
    queryFn: () => apiFetch<{ receipts: Billable[] }>(`/api/purchasing/suppliers/${supplierId}/billable`),
    enabled: !!supplierId,
  });
  // When editing, the bill's own receipts are not "billable" (they are on this bill):
  // show them first, alongside the rest.
  const own: Billable[] = (bill?.lines ?? []).map((l) => ({ intakeId: l.intakeId, receiptNumber: l.receiptNumber, receivedDate: l.receivedDate, product: { id: "", name: l.description.split(" · ")[0], unit: l.uomCode }, poNumber: l.poNumber, goodQty: l.receivedQty, expectedUnitPrice: l.expectedUnitPrice, priceSource: null, expectedNet: l.expectedNet, taxCode: l.taxCode, taxRate: "" }));
  const rows = [...own, ...(billable.data?.receipts ?? [])];
  const keyOf = (r: Billable) => r.intakeId;
  const lines = rows.filter((r) => picked[keyOf(r)] !== undefined);
  const billedNet = lines.reduce((a, r) => a + Number(picked[keyOf(r)] || 0) * Number(r.goodQty), 0);
  const expectedNet = lines.reduce((a, r) => a + Number(r.expectedNet ?? 0), 0);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const payload = {
        supplier_id: supplierId,
        supplier_invoice_no: invoiceNo,
        bill_date: billDate,
        notes: notes || null,
        lines: lines.map((r) => ({ intake_id: r.intakeId, unit_price: picked[r.intakeId] })),
        ...(bill ? { expected_version: bill.version } : {}),
      };
      const res = bill ? await apiPut<{ bill: Bill }>(`/api/purchasing/bills/${bill.id}`, payload) : await apiPost<{ bill: Bill }>("/api/purchasing/bills", payload);
      void qc.invalidateQueries({ queryKey: ["purchasing"] });
      toast.show(`${res.bill.number} · ${MATCH[res.bill.matchStatus] ? t(MATCH[res.bill.matchStatus].label) : res.bill.matchStatus}`, res.bill.matchStatus === "variance" || res.bill.matchStatus === "unpriced" ? "error" : "success");
      onDone(res.bill.id);
    } catch (err) {
      fail(toast, err, t);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><h2 className="text-xl font-extrabold">{bill ? t("purchasing.bill.title.edit", { number: bill.number }) : t("purchasing.bill.title.new")}</h2><button type="button" className="btn-secondary" onClick={() => onDone()}>{t("ui.back")}</button></div>
      <section className="card p-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Field label={t("purchasing.bill.field.supplier")}>
          <select className="field font-bold" value={supplierId} disabled={!!bill} onChange={(e) => { setSupplierId(e.target.value); setPicked({}); }}>
            <option value="">{t("purchasing.bill.field.select_supplier")}</option>
            {suppliers.data?.suppliers.map((s) => <option key={s.id} value={s.id}>{localName(s, locale)}</option>)}
          </select>
        </Field>
        <Field label={t("purchasing.bill.field.invoice_no")}><input className="field" dir="ltr" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
        <Field label={t("purchasing.bill.field.bill_date")}><input className="field" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></Field>
        <Field label={t("purchasing.bill.field.notes")}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </section>
      {supplierId && (
        <section className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold">{t("purchasing.bill.receipts_header")}</h3>
          {billable.isLoading && <LoadingState />}
          {billable.isError && <ErrorState message={errorMessage(billable.error)} onRetry={() => billable.refetch()} />}
          {rows.length === 0 && billable.isSuccess && <p className="text-sm font-bold text-united-muted">{t("purchasing.bill.no_receipts_empty")}</p>}
          <ul className="flex flex-col divide-y divide-united-dark/5">
            {rows.map((r) => {
              const k = keyOf(r);
              const on = picked[k] !== undefined;
              const lineNet = on ? Number(picked[k] || 0) * Number(r.goodQty) : null;
              const diff = lineNet !== null && r.expectedNet !== null ? lineNet - Number(r.expectedNet) : null;
              return (
                <li key={k} className="py-2 grid grid-cols-[auto_1fr_auto] gap-2 items-center">
                  <input type="checkbox" className="w-6 h-6" checked={on} onChange={() => setPicked((p) => { const n = { ...p }; if (on) delete n[k]; else n[k] = r.expectedUnitPrice ?? ""; return n; })} aria-label={r.receiptNumber} />
                  <div className="text-sm">
                    <div className="font-extrabold">{localName(r.product, locale)} · <span dir="ltr">{fmtQty(r.goodQty, r.product.unit)}</span></div>
                    <div className="text-xs font-bold text-united-muted"><span dir="ltr">{r.receiptNumber}</span> · {r.receivedDate}{r.poNumber ? <> · <span dir="ltr">{r.poNumber}</span></> : ""} · {t("purchasing.bill.agreed_price")} {r.expectedUnitPrice ? <span dir="ltr">{r.expectedUnitPrice}</span> : "—"}</div>
                    {diff !== null && Math.abs(diff) >= 0.005 && <div className={`text-xs font-extrabold ${diff > 0 ? "text-united-danger" : "text-united-green"}`}>{t("purchasing.bill.variance")} <span dir="ltr">{fmtMoney(diff)}</span></div>}
                  </div>
                  {on && <input className="field w-28" dir="ltr" inputMode="decimal" aria-label={`${t("purchasing.bill.price_placeholder")} ${r.receiptNumber}`} placeholder={t("purchasing.bill.price_placeholder")} value={picked[k]} onChange={(e) => setPicked({ ...picked, [k]: e.target.value })} />}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-between font-extrabold border-t border-united-dark/10 pt-2">
            <span>{t("purchasing.bill.before_tax")}: <span dir="ltr">{fmtMoney(billedNet)}</span></span>
            <span className="text-united-muted">{t("purchasing.bill.agreed_price")}: <span dir="ltr">{fmtMoney(expectedNet)}</span></span>
          </div>
          <button type="button" className="btn-primary" disabled={busy || !invoiceNo.trim() || lines.length === 0} onClick={save}>{busy ? t("purchasing.bill.saving") : bill ? t("purchasing.bill.save_edit") : t("purchasing.bill.save_draft")}</button>
        </section>
      )}
    </div>
  );
}

type DraftServiceLine = { account_id: string; description: string; amount: string; tax_code: string };

/** A supplier invoice with no goods receipt behind it: each line is an account, an amount before tax, and its tax. */
function NewServiceBill({ onDone, bill }: { onDone: (id?: string) => void; bill?: Bill }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const suppliers = useQuery({ queryKey: ["purchasing", "suppliers"], queryFn: () => apiFetch<{ suppliers: { id: string; code: string; name: string }[] }>("/api/purchasing/suppliers") });
  const accounts = useQuery({
    queryKey: ["acc", "accounts"],
    queryFn: () => apiFetch<{ accounts: { id: string; code: string; name: string; nameAr: string; type: string; postable: boolean; active: boolean; systemKey: string | null }[] }>("/api/accounting/accounts").then((r) => r.accounts),
    staleTime: 300_000,
  });
  const taxes = useQuery({ queryKey: ["sales", "tax-rates"], queryFn: () => apiFetch<{ taxRates: { code: string; name: string; nameAr: string; rate: string }[] }>("/api/sales/tax-rates").then((r) => r.taxRates), staleTime: 300_000 });
  // The server's own rule (lib/purchasing/service-accounts.ts); cash and bank accounts come from the cash list.
  const cash = useQuery({ queryKey: ["acc", "cash"], queryFn: () => apiFetch<{ cash: { rows: { glCode: string }[] } }>("/api/accounting/cash").then((r) => new Set(r.cash.rows.map((c) => c.glCode))), staleTime: 300_000 });
  const chargeable = (accounts.data ?? []).filter((a) => isServiceBillAccount(a, !!cash.data?.has(a.code)));
  const [supplierId, setSupplierId] = useState(bill?.supplier.id ?? "");
  const [invoiceNo, setInvoiceNo] = useState(bill?.supplierInvoiceNo ?? "");
  const [billDate, setBillDate] = useState(bill?.billDate ?? todayLocalISO());
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? "");
  const [notes, setNotes] = useState(bill?.notes ?? "");
  const [lines, setLines] = useState<DraftServiceLine[]>(() => bill?.serviceLines.length ? bill.serviceLines.map((l) => ({ account_id: l.accountId, description: l.description, amount: l.net, tax_code: l.taxCode })) : [{ account_id: "", description: "", amount: "", tax_code: "" }]);
  const [busy, setBusy] = useState(false);
  const rate = (code: string) => Number(taxes.data?.find((x) => x.code === code)?.rate ?? 0);
  const net = lines.reduce((a, l) => a + Number(l.amount || 0), 0);
  const tax = lines.reduce((a, l) => a + Math.round(Number(l.amount || 0) * rate(l.tax_code)) / 100, 0);
  const setLine = (i: number, patch: Partial<DraftServiceLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const ready = supplierId && invoiceNo.trim() && lines.length > 0 && lines.every((l) => l.account_id && l.description.trim() && Number(l.amount) > 0 && l.tax_code);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const payload = { kind: "service", supplier_id: supplierId, supplier_invoice_no: invoiceNo, bill_date: billDate, due_date: dueDate || null, notes: notes || null, lines, ...(bill ? { expected_version: bill.version } : {}) };
      const res = bill ? await apiPut<{ bill: Bill }>(`/api/purchasing/bills/${bill.id}`, payload) : await apiPost<{ bill: Bill }>("/api/purchasing/bills", payload);
      void qc.invalidateQueries({ queryKey: ["purchasing"] });
      toast.show(res.bill.number, "success");
      onDone(res.bill.id);
    } catch (err) {
      fail(toast, err, t);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><h2 className="text-xl font-extrabold">{bill ? t("purchasing.bill.title.edit", { number: bill.number }) : t("purchasing.bill.title.new_service")}</h2><button type="button" className="btn-secondary" onClick={() => onDone()}>{t("ui.back")}</button></div>
      <section className="card p-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Field label={t("purchasing.bill.field.supplier")}>
          <select className="field font-bold" value={supplierId} disabled={!!bill} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">{t("purchasing.bill.field.select_supplier")}</option>
            {suppliers.data?.suppliers.map((s) => <option key={s.id} value={s.id}>{localName(s, locale)}</option>)}
          </select>
        </Field>
        <Field label={t("purchasing.bill.field.invoice_no")}><input className="field" dir="ltr" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
        <Field label={t("purchasing.bill.field.bill_date")}><input className="field" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></Field>
        <Field label={t("purchasing.bill.due_date")}><input className="field" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        <Field label={t("purchasing.bill.field.notes")}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </section>
      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("purchasing.bill.service_lines_header")}</h3>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto] gap-2 items-end">
            <Field label={t("purchasing.bill.field.account")}>
              <select className="field" value={l.account_id} onChange={(e) => setLine(i, { account_id: e.target.value })}>
                <option value="">—</option>
                {chargeable.map((a) => <option key={a.id} value={a.id}>{a.code} · {localName({ name: a.name, nameAr: a.nameAr }, locale)}</option>)}
              </select>
            </Field>
            <Field label={t("purchasing.bill.field.description")}><input className="field" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
            <Field label={t("purchasing.bill.before_tax")}><input className="field" dir="ltr" inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></Field>
            <Field label={t("purchasing.bill.tax")}>
              <select className="field" value={l.tax_code} onChange={(e) => setLine(i, { tax_code: e.target.value })}>
                <option value="">—</option>
                {(taxes.data ?? []).map((x) => <option key={x.code} value={x.code}>{localName(x, locale)}</option>)}
              </select>
            </Field>
            <button type="button" className="btn-ghost text-united-danger" disabled={lines.length === 1} aria-label={t("purchasing.bill.remove_line")} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn-secondary self-start" onClick={() => setLines([...lines, { account_id: "", description: "", amount: "", tax_code: lines[lines.length - 1]?.tax_code ?? "" }])}>{t("purchasing.bill.add_line")}</button>
        <div className="flex flex-wrap justify-between gap-2 font-extrabold border-t border-united-dark/10 pt-2">
          <span>{t("purchasing.bill.before_tax")}: <span dir="ltr">{fmtMoney(net)}</span></span>
          <span>{t("purchasing.bill.tax")}: <span dir="ltr">{fmtMoney(tax)}</span></span>
          <span>{t("purchasing.bill.total")}: <span dir="ltr">{fmtMoney(net + tax)}</span></span>
        </div>
        <button type="button" className="btn-primary" disabled={busy || !ready} onClick={save}>{busy ? t("purchasing.bill.saving") : bill ? t("purchasing.bill.save_edit") : t("purchasing.bill.save_draft")}</button>
      </section>
    </div>
  );
}

function BillDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [debit, setDebit] = useState<Record<string, string>>({});
  const [returnGoods, setReturnGoods] = useState(false);
  // One key per filled debit-note form: a retry after a dropped connection returns the same note.
  const [dnKey, setDnKey] = useState(newClientKey);
  const q = useQuery({ queryKey: ["purchasing", "bill", id], queryFn: () => apiFetch<{ bill: Bill }>(`/api/purchasing/bills/${id}`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const b = q.data.bill;
  if (editing) return b.kind === "service" ? <NewServiceBill bill={b} onDone={() => { setEditing(false); void q.refetch(); }} /> : <NewBill bill={b} onDone={() => { setEditing(false); void q.refetch(); }} />;
  const service = b.kind === "service";
  const manage = can("purchasing.bills.manage");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["purchasing"] });
  const act = async (path: string, body: Record<string, unknown> = {}) => {
    try {
      const res = await apiPost<{ bill: Bill }>(`/api/purchasing/bills/${id}/${path}`, path === "debit-notes" ? { ...body, idempotency_key: dnKey } : body);
      if (path === "debit-notes") setDnKey(newClientKey());
      setReason("");
      setDebit({});
      if (path === "post") toast.show(res.bill.status === "posted" ? t("purchasing.bill.success_posted") : t("purchasing.bill.success_variance"), res.bill.status === "posted" ? "success" : "error");
      refresh();
    } catch (err) {
      fail(toast, err, t);
    }
  };
  const debitLines = Object.entries(debit).filter(([, v]) => v.trim() !== "").map(([bill_line_id, quantity]) => ({ bill_line_id, quantity }));
  const allowanceLines = Object.entries(debit).filter(([, v]) => v.trim() !== "").map(([service_line_id, amount]) => ({ service_line_id, amount }));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center gap-2">
        <div>
          <h2 className="text-xl font-extrabold" dir="ltr">{b.number}</h2>
          <p className="text-sm font-bold text-united-muted">{localName(b.supplier, locale)} · {t("purchasing.bill.supplier_invoice_label")} <span dir="ltr">{b.supplierInvoiceNo}</span> · {b.billDate} · {t("purchasing.bill.due_date")} {b.dueDate}</p>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>{t("ui.back")}</button>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <span className={`rounded-full px-3 py-1 text-sm font-extrabold ${BILL_STATUS[b.status]?.cls}`}>{BILL_STATUS[b.status] ? t(BILL_STATUS[b.status].label) : b.status}</span>
        <span className={`text-sm font-extrabold ${MATCH[b.matchStatus]?.cls}`}>{MATCH[b.matchStatus] ? t(MATCH[b.matchStatus].label) : b.matchStatus}{Number(b.variance) ? <> · {t("purchasing.bill.variance")} <span dir="ltr">{fmtMoney(b.variance)}</span></> : null}</span>
        {b.approvalId && <Link href={`/approvals?id=${b.approvalId}`} className="text-sm font-extrabold text-united-green underline">{t("orders.approval")}</Link>}
      </div>
      <section className="card p-4 flex flex-col divide-y divide-united-dark/5">
        {service && b.serviceLines.map((l) => (
          <div key={l.id} className="py-2 flex flex-col gap-1">
            <div className="flex justify-between text-sm font-extrabold gap-2"><span>{l.description}</span><span dir="ltr">{fmtMoney(l.total)}</span></div>
            <div className="flex flex-wrap justify-between gap-2 text-xs font-bold text-united-muted">
              <span><span dir="ltr">{l.account.code}</span> · {localName(l.account, locale)} · {t("purchasing.bill.before_tax")} <span dir="ltr">{fmtMoney(l.net)}</span> · {t("purchasing.bill.tax")} {l.taxCode} <span dir="ltr">{fmtMoney(l.tax)}</span></span>
              {Number(l.debitedNet) > 0 && <span>{t("purchasing.bill.debited_label")} <span dir="ltr">{fmtMoney(l.debitedNet)}</span></span>}
            </div>
            {manage && b.status === "posted" && Number(l.debitedNet) < Number(l.net) && (
              <input className="field w-40 self-end" dir="ltr" inputMode="decimal" placeholder={t("purchasing.bill.allowance_placeholder")} aria-label={t("bills.debit-line", { line: l.lineNo })} value={debit[l.id] ?? ""} onChange={(e) => setDebit({ ...debit, [l.id]: e.target.value })} />
            )}
          </div>
        ))}
        {b.lines.map((l) => (
          <div key={l.id} className="py-2 flex flex-col gap-1">
            <div className="flex justify-between text-sm font-extrabold gap-2"><span>{l.description}</span><span dir="ltr">{fmtMoney(l.total)}</span></div>
            <div className="flex flex-wrap justify-between gap-2 text-xs font-bold text-united-muted">
              <span>{t("purchasing.bill.received_label")} <span dir="ltr">{fmtQty(l.receivedQty, l.uomCode)}</span> · {t("purchasing.bill.invoiced_label")} <span dir="ltr">{fmtQty(l.quantity, l.uomCode)} × {l.unitPrice}</span> · {t("purchasing.bill.agreed_price")} <span dir="ltr">{l.expectedUnitPrice ?? "—"}</span></span>
              {l.lineVariance !== null && Number(l.lineVariance) !== 0 && <span className={Number(l.lineVariance) > 0 ? "text-united-danger" : "text-united-green"}>{t("purchasing.bill.variance")} <span dir="ltr">{fmtMoney(l.lineVariance)}</span></span>}
              {Number(l.debitedQty) > 0 && <span>{t("purchasing.bill.debited_label")} <span dir="ltr">{fmtQty(l.debitedQty, l.uomCode)}</span></span>}
            </div>
            {manage && b.status === "posted" && Number(l.debitedQty) < Number(l.quantity) && (
              <input className="field w-40 self-end" dir="ltr" inputMode="decimal" placeholder={`${t("purchasing.bill.variance")} ${l.lineNo}`} aria-label={t("bills.debit-line", { line: l.lineNo })} value={debit[l.id] ?? ""} onChange={(e) => setDebit({ ...debit, [l.id]: e.target.value })} />
            )}
          </div>
        ))}
        <div className="pt-2 flex flex-col gap-1 text-sm font-extrabold">
          <div className="flex justify-between"><span>{t("purchasing.bill.before_tax")}</span><span dir="ltr">{fmtMoney(b.net)}</span></div>
          {!service && <div className="flex justify-between text-united-muted"><span>{t("purchasing.bill.agreed_price")}</span><span dir="ltr">{fmtMoney(b.expectedNet)}</span></div>}
          <div className="flex justify-between"><span>{t("purchasing.bill.tax")}</span><span dir="ltr">{fmtMoney(b.taxTotal)}</span></div>
          <div className="flex justify-between text-lg"><span>{t("purchasing.bill.total")}</span><span dir="ltr">{fmtMoney(b.total)}</span></div>
          {b.open !== null && <div className="flex justify-between text-united-green"><span>{t("purchasing.bill.amount_due_to_supplier")}</span><span dir="ltr">{fmtMoney(b.open)}</span></div>}
        </div>
      </section>
      {b.debitNotes.length > 0 && (
        <section className="card p-4 flex flex-col gap-1 text-sm font-bold">
          <h3 className="font-extrabold">{t("purchasing.bill.debit_notes_heading")}</h3>
          {b.debitNotes.map((dn) => <div key={dn.id} className="flex justify-between"><span><span dir="ltr">{dn.number}</span> · {dn.issueDate} · {dn.reason}</span><span dir="ltr">{fmtMoney(dn.total)}</span></div>)}
        </section>
      )}
      <p className="text-xs font-bold text-united-muted">{b.createdBy}{b.postedBy ? ` · ${t("operations.performed_by_prefix")} ${b.postedBy}` : ""}{b.approvedBy ? ` · ${b.approvedBy}` : ""}{b.cancelReason ? ` · ${b.cancelReason}` : ""}</p>
      {manage && b.status !== "cancelled" && (
        <section className="card p-4 flex flex-wrap gap-2">
          {b.status === "draft" && <button type="button" className="btn-primary" onClick={() => act("post")}>{t("purchasing.bill.post_action")}</button>}
          {b.status === "draft" && <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>{t("ui.edit")}</button>}
          <input className="field flex-1 min-w-48" placeholder={b.status === "posted" ? t("purchasing.bill.debit_reason_placeholder") : t("purchasing.bill.cancel_reason_placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
          {b.status !== "posted" && <button type="button" className="btn-danger" onClick={() => act("cancel", { reason })}>{t("purchasing.bill.cancel_bill_btn")}</button>}
          {b.status === "posted" && b.open !== "0.00" && service && (
            <button type="button" className="btn-secondary" disabled={allowanceLines.length === 0} onClick={() => act("debit-notes", { reason, lines: allowanceLines })}>{t("purchasing.bill.allowance_btn")}</button>
          )}
          {b.status === "posted" && b.open !== "0.00" && !service && (
            <>
              <label className="flex items-center gap-2 text-sm font-bold w-full"><input type="checkbox" className="w-5 h-5" checked={returnGoods} onChange={(e) => setReturnGoods(e.target.checked)} />{t("purchasing.bill.return_goods_checkbox")}</label>
              <button type="button" className="btn-secondary" disabled={debitLines.length === 0} onClick={() => act("debit-notes", { reason, lines: debitLines, return_goods: returnGoods })}>{t("purchasing.bill.debit_qty_btn")}</button>
              <button type="button" className="btn-danger" onClick={() => act("debit-notes", { reason, full: true, return_goods: returnGoods })}>{t("purchasing.bill.debit_full_btn")}</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payables: aging → supplier statement
// ---------------------------------------------------------------------------

type AgingRow = { supplier: { id: string; code: string; name: string; nameAr?: string | null }; total: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string };
const BUCKETS_DEFAULT = [["current", ""], ["d1_30", "1–30"], ["d31_60", "31–60"], ["d61_90", "61–90"], ["d90_plus", "+90"], ["total", ""]];

function Payables() {
  const { t, locale } = useLocale();
  const buckets = useMemo(() => BUCKETS_DEFAULT.map(([k, _]) => [k, k === "current" ? t("purchasing.bill.current_bucket") : k === "total" ? t("purchasing.bill.total_bucket") : _] as [keyof Omit<AgingRow, "supplier">, string]), [t]);
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null);
  const q = useQuery({ queryKey: ["purchasing", "ap-aging"], queryFn: () => apiFetch<{ aging: { asOf: string; rows: AgingRow[]; totals: Omit<AgingRow, "supplier"> } }>("/api/purchasing/reports/ap-aging") });
  if (supplier) return <Statement supplier={supplier} onClose={() => setSupplier(null)} />;
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const a = q.data.aging;
  if (a.rows.length === 0) return <EmptyState icon="✅" title={t("purchasing.bill.no_payables_empty")} />;
  return (
    <section className="card p-3 overflow-x-auto">
      <p className="text-xs font-bold text-united-muted mb-2">{t("bills.aging-note", { date: a.asOf })}</p>
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-united-muted text-start"><th className="text-start p-1">{t("purchasing.suppliers")}</th>{buckets.map(([k, l]) => <th key={k} className="p-1 text-end">{l}</th>)}</tr></thead>
        <tbody>
          {a.rows.map((r) => (
            <tr key={r.supplier.id} className="border-t border-united-dark/5">
              <td className="p-1"><button type="button" className="font-extrabold text-united-green underline text-start" onClick={() => setSupplier(r.supplier)}>{localName(r.supplier, locale)}</button></td>
              {buckets.map(([k]) => <td key={k} dir="ltr" className={`p-1 num font-bold ${k === "total" ? "font-extrabold" : ""} ${k.startsWith("d") && Number(r[k]) > 0 ? "text-united-danger" : ""}`}>{Number(r[k]) ? Number(r[k]).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "—"}</td>)}
            </tr>
          ))}
          <tr className="border-t-2 border-united-dark/20 font-extrabold"><td className="p-1">{t("purchasing.bill.total_bucket")}</td>{buckets.map(([k]) => <td key={k} dir="ltr" className="p-1 num">{Number(a.totals[k]).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>)}</tr>
        </tbody>
      </table>
    </section>
  );
}

function Statement({ supplier, onClose }: { supplier: { id: string; name: string; nameAr?: string | null }; onClose: () => void }) {
  const { t, locale } = useLocale();
  const [from, setFrom] = useState(`${todayLocalISO().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayLocalISO());
  const q = useQuery({
    queryKey: ["purchasing", "statement", supplier.id, from, to],
    queryFn: () => apiFetch<{ payable: string; statement: { opening: string; closing: string; rows: { date: string; kind: string; id: string; number: string; ref: string; credit: string; debit: string; balance: string }[] } }>(`/api/purchasing/suppliers/${supplier.id}/statement?from=${from}&to=${to}`),
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><h2 className="text-xl font-extrabold">{t("purchasing.bill.statement_title", { name: localName(supplier, locale) })}</h2><button type="button" className="btn-secondary" onClick={onClose}>{t("ui.back")}</button></div>
      <div className="flex gap-2"><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (
        <section className="card p-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-united-muted"><th className="p-1 text-start">{t("purchasing.bill.col.date")}</th><th className="p-1 text-start">{t("purchasing.bill.col.document")}</th><th className="p-1 text-end">{t("purchasing.bill.col.credit")}</th><th className="p-1 text-end">{t("purchasing.bill.col.debit")}</th><th className="p-1 text-end">{t("purchasing.bill.col.balance")}</th></tr></thead>
            <tbody>
              <tr className="font-bold text-united-muted"><td className="p-1" colSpan={4}>{t("purchasing.bill.opening_balance")}</td><td className="p-1 num" dir="ltr">{q.data.statement.opening}</td></tr>
              {q.data.statement.rows.map((r) => (
                <tr key={r.id} className="border-t border-united-dark/5 font-bold">
                  <td className="p-1">{r.date}</td>
                  <td className="p-1"><span dir="ltr">{r.number}</span><div className="text-xs text-united-muted">{systemText(r.ref, locale)}</div></td>
                  <td className="p-1 num" dir="ltr">{Number(r.credit) ? r.credit : ""}</td>
                  <td className="p-1 num" dir="ltr">{Number(r.debit) ? r.debit : ""}</td>
                  <td className="p-1 num font-bold" dir="ltr">{r.balance}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-united-dark/20 font-extrabold"><td className="p-1" colSpan={4}>{t("purchasing.bill.amount_due_to_supplier")}</td><td className="p-1 num" dir="ltr">{q.data.statement.closing}</td></tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
