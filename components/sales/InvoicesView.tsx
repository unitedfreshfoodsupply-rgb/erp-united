"use client";

import Link from "next/link";
import { useState } from "react";
import { newClientKey } from "@/lib/clientKey";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

/**
 * Invoicing for the accountant: orders that left and are not invoiced yet, drafts to
 * review and issue, issued invoices with their credit notes, and who owes what by age.
 */

type InvRow = { id: string; number: string | null; status: string; issueDate: string | null; dueDate: string | null; total: string; credited: string; open: string | null; customer: { code: string; name: string; nameAr: string | null }; order: { orderNumber: string } | null };
type InvDetail = InvRow & {
  version: number; currencyCode: string; buyerName: string | null; buyerTaxId: string | null; net: string; taxTotal: string; discountTotal: string; gross: string; voidReason: string | null;
  order: { id: string; orderNumber: string; deliveryDate: string } | null;
  lines: { id: string; lineNo: number; description: string; uomCode: string; quantity: string; unitPrice: string; discountPct: string; taxRate: string; net: string; tax: string; total: string; creditedQty: string }[];
  creditNotes: { id: string; number: string; issueDate: string; reason: string; total: string; createdBy: string }[];
};

export function InvoicesView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"todo" | "draft" | "issued" | "aging">("todo");
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <InvoiceDetail id={open} onClose={() => setOpen(null)} />;
  return (
    <div className="flex flex-col gap-3">
      <Tabs value={tab} onChange={setTab} items={[{ key: "todo", label: t("sales.invoice.tab.todo") }, { key: "draft", label: t("sales.invoice.tab.drafts") }, { key: "issued", label: t("sales.invoice.tab.issued") }, { key: "aging", label: t("sales.invoice.tab.aging") }]} />
      {tab === "todo" && <ToInvoice onOpen={setOpen} />}
      {(tab === "draft" || tab === "issued") && <InvoiceList status={tab} onOpen={setOpen} />}
      {tab === "aging" && <Aging />}
    </div>
  );
}

function ToInvoice({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["sales", "to-invoice"], queryFn: () => apiFetch<{ orders: { id: string; orderNumber: string; deliveryDate: string; customerName: string; customer: { code: string; name: string; nameAr: string | null } | null; unpricedLines: number }[] }>("\/api\/sales\/invoices\/to-invoice") });
  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  if (!q.data?.orders.length) return <EmptyState icon="🧾" title={t("sales.invoice.all_invoiced")} />;
  return (
    <ul className="flex flex-col gap-2">
      {q.data.orders.map((o) => {
        const blocked = !o.customer ? t("sales.invoice.customer_not_mapped") : o.unpricedLines ? `${o.unpricedLines} ${t("sales.exposure.unpriced")}` : null;
        return (
          <li key={o.id} className="card p-3 flex items-center justify-between gap-2">
            <div>
              <Link href={`/orders/${o.id}`} className="font-extrabold" dir="ltr">{o.orderNumber}</Link>
              <div className="text-xs font-bold text-united-muted">{o.customer ? `${o.customer.code} · ${localName(o.customer, locale)}` : o.customerName} · {o.deliveryDate}</div>
              {blocked && <div className="text-xs font-extrabold text-united-warn">{blocked}</div>}
            </div>
            {can("sales.invoices.manage") && (
              <button type="button" className="btn-primary shrink-0" disabled={!!blocked} onClick={async () => {
                try {
                  const r = await apiPost<{ invoice: { id: string } }>("/api/sales/invoices", { order_id: o.id });
                  void qc.invalidateQueries({ queryKey: ["sales"] });
                  onOpen(r.invoice.id);
                } catch (err) { toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error_generic"), "error"); }
              }}>{t("sales.invoice.create")}</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function InvoiceList({ status, onOpen }: { status: string; onOpen: (id: string) => void }) {
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["sales", "invoices", status], queryFn: () => apiFetch<{ invoices: InvRow[] }>(`/api/sales/invoices?status=${status}`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  if (!q.data?.invoices.length) return <EmptyState icon="🧾" title={t("sales.invoice.no_invoices")} />;
  return (
    <ul className="flex flex-col gap-2">
      {q.data.invoices.map((i) => (
        <li key={i.id}>
          <button type="button" className="card p-3 w-full text-start flex justify-between gap-2" onClick={() => onOpen(i.id)}>
            <div>
              <div className="font-extrabold"><span dir="ltr">{i.number ?? t("sales.invoice.invoice_number_placeholder")}</span> · {localName(i.customer, locale)}</div>
              <div className="text-xs font-bold text-united-muted">{i.order?.orderNumber ?? ""}{i.issueDate ? ` · ${i.issueDate} ${t("sales.invoice.due_date_text")}${i.dueDate}` : ""}</div>
            </div>
            <div className="text-end">
              <div dir="ltr" className="font-extrabold">{fmtMoney(i.total)}</div>
              {i.open !== null && Number(i.credited) > 0 && <div className="text-xs font-bold text-united-muted">{t("sales.invoice.open_amount_label")} <span dir="ltr">{fmtMoney(i.open)}</span></div>}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function InvoiceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const [issueDate, setIssueDate] = useState(todayLocalISO());
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(false);
  const [credit, setCredit] = useState<Record<string, string>>({});
  // One key per filled credit-note form: a retry after a dropped connection returns the same note.
  const [cnKey, setCnKey] = useState(newClientKey);
  const q = useQuery({ queryKey: ["sales", "invoice", id], queryFn: () => apiFetch<{ invoice: InvDetail }>(`/api/sales/invoices/${id}`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const inv = q.data.invoice;
  const manage = can("sales.invoices.manage");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["sales"] });
  // Localized STATUS labels (inside component so t() is available)
  const statusLabels: Record<string, { label: string; cls: string }> = {
    draft: { label: t("sales.invoice.draft"), cls: "bg-united-dark/5" },
    issued: { label: t("sales.invoice.issued"), cls: "bg-united-green/10 text-united-green" },
    void: { label: t("sales.invoice.voided"), cls: "bg-united-dark/5 text-united-muted" },
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center gap-2">
        <div>
          <h2 className="text-xl font-extrabold" dir="ltr">{inv.number ?? t("sales.invoice.draft_number")}</h2>
          <p className="text-sm font-bold text-united-muted">{inv.buyerName ?? localName(inv.customer, locale)}{inv.buyerTaxId ? ` · ${t("sales.invoice.tax_id_prefix")}${inv.buyerTaxId}` : ""}{inv.order ? ` · ${inv.order.orderNumber}` : ""}</p>
        </div>
        <div className="flex gap-2">
          {inv.status === "issued" && <Link href={`/sales/invoices/${inv.id}/print${locale === "en" ? "?lang=en" : ""}`} target="_blank" className="btn-secondary">{t("sales.invoice.print")}</Link>}
          <button type="button" className="btn-secondary" onClick={onClose}>{t("ui.back")}</button>
        </div>
      </div>
      <span className={`self-start rounded-full px-3 py-1 text-sm font-extrabold ${statusLabels[inv.status]?.cls}`}>{statusLabels[inv.status]?.label}{inv.issueDate ? ` ${t("sales.invoice.due_date_text")}${inv.dueDate}` : ""}</span>
      <section className="card p-4 flex flex-col divide-y divide-united-dark/5">
        {inv.lines.map((l) => (
          <div key={l.id} className="py-2 flex flex-col gap-1">
            <div className="flex justify-between gap-2 text-sm">
              <span className="font-extrabold">{l.description}</span>
              <span dir="ltr" className="font-extrabold">{fmtMoney(l.total)}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs font-bold text-united-muted">
              <span dir="ltr">{fmtQty(l.quantity, l.uomCode)} × {l.unitPrice}{Number(l.discountPct) ? ` − ${l.discountPct}%` : ""}{Number(l.taxRate) ? ` + VAT ${l.taxRate}%` : ""}</span>
              {Number(l.creditedQty) > 0 && <span>{t("sales.invoice.is_deducted_text")}{fmtQty(l.creditedQty, l.uomCode)}</span>}
            </div>
            {inv.status === "issued" && manage && (
              <input className="field text-sm" inputMode="decimal" dir="ltr" placeholder={t("sales.invoice.quantity_to_deduct").replace("${qty}", `${Number(l.quantity) - Number(l.creditedQty)}`)} value={credit[l.id] ?? ""} onChange={(e) => setCredit({ ...credit, [l.id]: e.target.value })} />
            )}
          </div>
        ))}
        <div className="pt-2 grid grid-cols-2 gap-1 text-sm font-bold">
          <span>{t("sales.invoice.net")}</span><span dir="ltr" className="text-end">{fmtMoney(inv.net)}</span>
          <span>{t("sales.invoice.tax")}</span><span dir="ltr" className="text-end">{fmtMoney(inv.taxTotal)}</span>
          <span className="font-extrabold">{t("sales.invoice.gross")}</span><span dir="ltr" className="text-end font-extrabold">{fmtMoney(inv.total)}</span>
          {inv.status === "issued" && <><span>{t("sales.invoice.credited_notifications")}</span><span dir="ltr" className="text-end">−{fmtMoney(inv.credited)}</span><span className="font-extrabold">{t("sales.invoice.open_amount_label")}</span><span dir="ltr" className="text-end font-extrabold">{fmtMoney(inv.open)}</span></>}
        </div>
      </section>
      {inv.creditNotes.length > 0 && (
        <section className="card p-4 flex flex-col gap-1">
          <h3 className="font-extrabold">{t("sales.invoice.credited_notifications")}</h3>
          {inv.creditNotes.map((c) => (
            <div key={c.id} className="flex justify-between text-sm font-bold"><span><span dir="ltr">{c.number}</span> · {c.issueDate} · {c.reason}</span><span dir="ltr">−{fmtMoney(c.total)}</span></div>
          ))}
        </section>
      )}
      {manage && inv.status === "draft" && (
        <section className="card p-4 flex flex-col gap-2">
          <Field label={t("sales.invoice.issue_date_label")}><input type="date" className="field" value={issueDate} max={todayLocalISO()} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn-primary" onClick={async () => { try { await apiPost(`/api/sales/invoices/${id}/issue`, { issue_date: issueDate, expected_version: inv.version }); refresh(); toast.show(t("sales.invoice.toast_issued"), "success"); } catch (err) { toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error_generic"), "error"); } }}>{t("sales.invoice.issue_now")}</button>
            <input className="field flex-1" placeholder={t("sales.invoice.draft_reason_placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn-danger" onClick={async () => { try { await apiPost(`/api/sales/invoices/${id}/void`, { reason, expected_version: inv.version }); refresh(); } catch (err) { toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error_generic"), "error"); } }}>{t("sales.invoice.void_draft")}</button>
          </div>
        </section>
      )}
      {manage && inv.status === "issued" && inv.open !== "0.00" && (
        <section className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold">{t("sales.invoice.credit_note_heading")}</h3>
          <input className="field" placeholder={t("sales.invoice.reason_label")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" className="w-5 h-5" checked={restock} onChange={(e) => setRestock(e.target.checked)} />{t("sales.invoice.restock_checkbox")}</label>
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn-primary" onClick={async () => {
              const lines = Object.entries(credit).filter(([, v]) => v.trim()).map(([invoice_line_id, quantity]) => ({ invoice_line_id, quantity }));
              try { await apiPost(`/api/sales/invoices/${id}/credit-notes`, { reason, lines, restock, idempotency_key: cnKey }); setCnKey(newClientKey()); setCredit({}); setReason(""); refresh(); toast.show(t("sales.invoice.toast_credited"), "success"); } catch (err) { toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error_generic"), "error"); }
            }}>{t("sales.invoice.to_credit_by_qty")}</button>
            <button type="button" className="btn-danger" onClick={async () => {
              try { await apiPost(`/api/sales/invoices/${id}/credit-notes`, { reason, full: true, restock, idempotency_key: cnKey }); setCnKey(newClientKey()); setReason(""); refresh(); toast.show(t("sales.invoice.toast_full_deduct"), "success"); } catch (err) { toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error_generic"), "error"); }
            }}>{t("sales.invoice.deduct_full")}</button>
          </div>
        </section>
      )}
    </div>
  );
}

function Aging() {
  const { t, locale } = useLocale();
  const [asOf, setAsOf] = useState(todayLocalISO());
  const q = useQuery({ queryKey: ["sales", "aging", asOf], queryFn: () => apiFetch<{ rows: { customer: { id: string; code: string; name: string }; total: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string }[]; totals: Record<string, string> }>(`/api/sales/reports/aging?as_of=${asOf}`) });
  const cols: [string, string][] = [["current", t("sales.invoice.age.current")], ["d1_30", "1–30"], ["d31_60", "31–60"], ["d61_90", "61–90"], ["d90_plus", "+90"], ["total", t("sales.invoice.age.total")]];
  return (
    <div className="flex flex-col gap-3">
      <Field label={t("sales.invoice.due_until")}><input type="date" className="field" value={asOf} onChange={(e) => setAsOf(e.target.value || todayLocalISO())} /></Field>
      {q.isLoading && <LoadingState />}
      {q.data && q.data.rows.length === 0 && <EmptyState icon="✅" title={t("sales.invoice.no_debtors")} />}
      {q.data && q.data.rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-united-muted"><th className="p-2 text-start">{t("sales.customer.name")}</th>{cols.map(([k, l]) => <th key={k} className="p-2">{l}</th>)}</tr></thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.customer.id} className="border-t border-united-dark/5 font-bold">
                  <td className="p-2"><Link href={`/sales?customer=${r.customer.id}`}>{r.customer.code} · {localName(r.customer, locale)}</Link></td>
                  {cols.map(([k]) => <td key={k} dir="ltr" className={`p-2 text-center ${k === "d90_plus" && Number(r[k as keyof typeof r]) > 0 ? "text-united-danger" : ""}`}>{Number(r[k as keyof typeof r]) ? Number(r[k as keyof typeof r]).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "—"}</td>)}
                </tr>
              ))}
              <tr className="border-t-2 border-united-dark/20 font-extrabold"><td className="p-2">{t("sales.invoice.age.total")}</td>{cols.map(([k]) => <td key={k} dir="ltr" className="p-2 text-center">{Number(q.data!.totals[k]).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>)}</tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A customer's statement for a period (used on the customer screen). */
export function CustomerStatement({ customerId }: { customerId: string }) {
  const { t } = useLocale();
  const today = todayLocalISO();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ["sales", "statement", customerId, from, to], queryFn: () => apiFetch<{ opening: string; closing: string; rows: { id: string; date: string; kind: string; number: string; ref: string; debit: string; credit: string; balance: string }[] }>(`/api/sales/customers/${customerId}/statement?from=${from}&to=${to}`) });
  return (
    <section className="card p-4 flex flex-col gap-2">
      <h3 className="font-extrabold">{t("sales.invoice.statement_title")}</h3>
      <div className="grid grid-cols-2 gap-2">
        <input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {q.data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-united-muted"><th className="p-1 text-start">{t("sales.invoice.stmt.date")}</th><th className="p-1 text-start">{t("sales.invoice.stmt.document")}</th><th className="p-1">{t("sales.invoice.stmt.debit")}</th><th className="p-1">{t("sales.invoice.stmt.credit")}</th><th className="p-1">{t("sales.invoice.stmt.balance")}</th></tr></thead>
            <tbody>
              <tr className="font-bold text-united-muted"><td className="p-1" colSpan={4}>{t("sales.invoice.stmt.opening_balance")}</td><td dir="ltr" className="p-1 text-center">{q.data.opening}</td></tr>
              {q.data.rows.map((r) => (
                <tr key={r.id} className="border-t border-united-dark/5 font-bold">
                  <td className="p-1">{r.date}</td><td className="p-1"><span dir="ltr">{r.number}</span> <span className="text-xs text-united-muted">{r.ref}</span></td>
                  <td dir="ltr" className="p-1 text-center">{Number(r.debit) ? r.debit : ""}</td><td dir="ltr" className="p-1 text-center">{Number(r.credit) ? r.credit : ""}</td><td dir="ltr" className="p-1 text-center">{r.balance}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-united-dark/20 font-extrabold"><td className="p-1" colSpan={4}>{t("sales.invoice.stmt.closing_balance")}</td><td dir="ltr" className="p-1 text-center">{q.data.closing}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
