"use client";

import Link from "next/link";
import { useState } from "react";
import { newClientKey } from "@/lib/clientKey";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill, docTone } from "@/components/ui/StatusPill";
import { useBusy } from "@/components/ui/useBusy";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { isFullyCredited } from "@/components/sales/invoice-credit";
import { Segmented } from "@/components/ui/Segmented";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { statementLine } from "@/lib/locale/statement-text";
import { formatNumber } from "@/lib/format";
import { DataTable, FilterBar, useListQuery, useListState, type Column } from "@/components/ui/DataTable";
import { href as profileHref } from "@/lib/profiles/links";
import { DocLink, PartyLink } from "@/components/profiles/EntityLink";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import { DraftMasterData, type DraftParties } from "@/components/sales/DraftMasterData";

/**
 * Invoicing for the accountant: orders that left and are not invoiced yet, drafts to
 * review and issue, issued invoices with their credit notes, and who owes what by age.
 */

type InvRow = { id: string; number: string | null; status: string; issueDate: string | null; dueDate: string | null; total: string; credited: string; open: string | null; customer: { code: string; name: string; nameAr: string | null }; order: { orderNumber: string } | null };
type InvDetail = Omit<InvRow, "customer"> & {
  customer: { id: string; code: string; name: string; nameAr: string | null };
  version: number; currencyCode: string; buyerName: string | null; buyerTaxId: string | null; net: string; taxTotal: string; discountTotal: string; gross: string; voidReason: string | null;
  order: { id: string; orderNumber: string; deliveryDate: string; customerPoRef: string | null } | null;
  notes: string | null;
  /** A draft: the current company and customer cards issue will freeze, and what they lack. */
  current: DraftParties | null;
  lines: { id: string; lineNo: number; description: string; uomCode: string; quantity: string; unitPrice: string; discountPct: string; taxRate: string; net: string; tax: string; total: string; creditedQty: string }[];
  creditNotes: { id: string; number: string; issueDate: string; reason: string; total: string; createdBy: string }[];
  paid: string;
  payments: { receiptId: string; number: string; date: string; amount: string }[];
};

export const INVOICE_TABS = ["todo", "draft", "issued", "aging"] as const;
export type InvoiceTab = (typeof INVOICE_TABS)[number];

export function InvoicesView({ initialTab, initialInvoiceId }: { initialTab?: InvoiceTab; initialInvoiceId?: string | null } = {}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<InvoiceTab>(initialTab ?? "todo");
  const [open, setOpen] = useState<string | null>(initialInvoiceId ?? null);
  if (open) return <InvoiceDetail id={open} onClose={() => setOpen(null)} />;
  return (
    <div className="flex flex-col gap-3">
      <Segmented value={tab} onChange={setTab} items={[{ key: "todo", label: t("sales.invoice.tab.todo") }, { key: "draft", label: t("sales.invoice.tab.drafts") }, { key: "issued", label: t("sales.invoice.tab.issued") }, { key: "aging", label: t("sales.invoice.tab.aging") }]} />
      {tab === "todo" && <ToInvoice onOpen={setOpen} />}
      {(tab === "draft" || tab === "issued") && <InvoiceList key={tab} status={tab} onOpen={setOpen} />}
      {tab === "aging" && <Aging />}
    </div>
  );
}

function ToInvoice({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const { busy, run } = useBusy();
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
              <div className="text-xs font-bold text-united-muted">{o.customer ? localName(o.customer, locale) : o.customerName} · {o.deliveryDate}</div>
              {blocked && <div className="text-xs font-extrabold text-united-warn">{blocked}</div>}
            </div>
            {can("sales.invoices.manage") && (
              <button type="button" className="btn-primary shrink-0" disabled={!!blocked || !!busy} aria-busy={busy === o.id} onClick={() => run(o.id, async () => {
                try {
                  const r = await apiPost<{ invoice: { id: string } }>("/api/sales/invoices", { order_id: o.id });
                  void qc.invalidateQueries({ queryKey: ["sales"] });
                  onOpen(r.invoice.id);
                } catch (err) { toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error_generic"), "error"); }
              })}>{busy === o.id ? t("ui.saving") : t("sales.invoice.create")}</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function InvoiceList({ status, onOpen }: { status: string; onOpen: (id: string) => void }) {
  const { t, locale } = useLocale();
  // Shared list experience (maturity 2026-11): search by number, customer (either
  // language), code or tax number; issue-date range; paged on the server.
  const list = useListState([], { prefix: `${status}_`, pageSize: 50 });
  const q = useListQuery<{ invoices: InvRow[]; total: number }>(["sales", "invoices", status], `/api/sales/invoices?status=${status}&${list.apiQuery()}`);
  const rows = q.data?.invoices;
  const sum = (k: "total" | "open") => fmtMoney((rows ?? []).reduce((a, r) => a + Number(r[k] ?? 0), 0));
  // Fully credited reads as such, not as a paid invoice (both have nothing open).
  const openCell = (i: InvRow) => (isFullyCredited(i)
    ? <StatusPill tone="neutral">{t("sales.invoice.fully_credited")}</StatusPill>
    : <span className={Number(i.open) > 0 ? "font-semibold text-united-dark" : "text-united-muted"}>{fmtMoney(i.open ?? 0)}</span>);
  const columns: Column<InvRow>[] = [
    { key: "number", label: t("sales.col.invoice"), sortValue: (i) => i.number ?? "", render: (i) => <span dir="ltr" className="whitespace-nowrap">{i.number ?? t("sales.invoice.invoice_number_placeholder")}</span> },
    { key: "customer", label: t("sales.col.customer"), sortValue: (i) => localName(i.customer, locale), render: (i) => localName(i.customer, locale) },
    { key: "order", label: t("sales.col.order"), render: (i) => <span dir="ltr" className="text-united-muted">{i.order?.orderNumber ?? "—"}</span>, secondary: true },
    { key: "issued", label: t("sales.col.issued"), sortValue: (i) => i.issueDate ?? "", render: (i) => <span dir="ltr">{i.issueDate ?? "—"}</span> },
    { key: "due", label: t("sales.col.due"), sortValue: (i) => i.dueDate ?? "", render: (i) => <span dir="ltr">{i.dueDate ?? "—"}</span>, secondary: true },
    { key: "total", label: t("sales.col.total"), numeric: true, sortValue: (i) => Number(i.total), render: (i) => fmtMoney(i.total) },
    ...(status === "issued" ? [{ key: "open", label: t("sales.col.open"), numeric: true, sortValue: (i: InvRow) => Number(i.open ?? 0), render: openCell }] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <FilterBar list={list} searchLabel={t("sales.search.invoices")} searchHint={t("sales.search.invoices-hint")} filters={[{ key: "dates", label: t("sales.col.issued"), kind: "date-range" }]} />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(i) => i.id}
        onRowOpen={(i) => onOpen(i.id)}
        totals={{ total: sum("total"), ...(status === "issued" ? { open: sum("open") } : {}) }}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        empty={{ title: list.active ? t("list.empty-filtered") : t("sales.invoice.no_invoices") }}
        total={q.data?.total}
        page={list.page}
        pageSize={list.pageSize}
        onPage={(p) => list.set({ page: p })}
      />
    </div>
  );
}


/** A draft's notes, printed on the invoice. Audited with the previous and the new text. */
function DraftNotes({ id, notes, version, onSaved }: { id: string; notes: string | null; version: number; onSaved: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [text, setText] = useState(notes ?? "");
  const [busy, setBusy] = useState(false);
  const changed = text.trim() !== (notes ?? "");
  return (
    <section className="card p-4 flex flex-col gap-2">
      <Field label={t("doc.draft-notes")}><textarea className="field min-h-[4rem]" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <button type="button" className="btn-secondary self-start" disabled={!changed || busy} onClick={async () => {
        setBusy(true);
        try { await apiPatch(`/api/sales/invoices/${id}`, { notes: text, expected_version: version }); onSaved(); toast.show(t("doc.draft-notes-saved"), "success"); }
        catch (err) { toast.show(err instanceof ApiClientError ? err.message : t("ui.error"), "error"); }
        finally { setBusy(false); }
      }}>{t("ui.save")}</button>
    </section>
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
  const dialogs = useDialogs();
  // Issue, void and credit notes post or reverse revenue: one at a time, and a second tap waits.
  const { busy, run } = useBusy();
  const q = useQuery({ queryKey: ["sales", "invoice", id], queryFn: () => apiFetch<{ invoice: InvDetail }>(`/api/sales/invoices/${id}`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const inv = q.data.invoice;
  const manage = can("sales.invoices.manage");
  // A credit note is limited by the quantity left to credit, as on the server — not by the
  // open amount: an invoice paid in full can still be credited for goods returned afterwards.
  const creditable = inv.lines.some((l) => Number(l.quantity) > Number(l.creditedQty));
  // Fully credited by the same rule as the list and the server (credit notes add up to the total).
  const fullyCredited = isFullyCredited(inv);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["sales"] });
  // Localized STATUS labels (inside component so t() is available); the tone is the shared one
  // (a voided draft is neutral there, like a cancelled document).
  const statusLabels: Record<string, string> = {
    draft: t("sales.invoice.draft"),
    issued: t("sales.invoice.issued"),
    void: t("sales.invoice.voided"),
  };
  const fail = (err: unknown) => toast.show(err instanceof ApiClientError ? err.message : t("sales.invoice.error_generic"), "error");
  // On screen the customer reads in the screen's language; the legal name frozen at issue
  // (buyerName, usually Arabic) stays on the printed invoice and in Arabic.
  const party = locale === "en" ? localName(inv.customer, locale) : inv.buyerName ?? localName(inv.customer, locale);
  // Each irreversible step says what it will do — to whom, for how much — before it runs.
  const issue = async () => {
    if (!(await dialogs.confirm({ title: t("sales.invoice.confirm_issue", { customer: party }), body: t("sales.invoice.confirm_issue_body", { amount: fmtMoney(inv.total), date: issueDate }), confirmLabel: t("sales.invoice.issue_now"), cancelLabel: t("ui.back") }))) return;
    await run("issue", async () => {
      try { await apiPost(`/api/sales/invoices/${id}/issue`, { issue_date: issueDate, expected_version: inv.version }); refresh(); toast.show(t("sales.invoice.toast_issued"), "success"); } catch (err) { fail(err); }
    });
  };
  const voidDraft = async () => {
    if (!(await dialogs.confirm({ title: t("sales.invoice.confirm_void", { customer: party }), body: t("sales.invoice.confirm_void_body", { amount: fmtMoney(inv.total), reason: reason.trim() }), tone: "danger", confirmLabel: t("sales.invoice.void_draft"), cancelLabel: t("ui.back") }))) return;
    await run("void", async () => {
      try { await apiPost(`/api/sales/invoices/${id}/void`, { reason, expected_version: inv.version }); refresh(); toast.show(t("sales.invoice.toast_voided"), "success"); } catch (err) { fail(err); }
    });
  };
  const creditByQty = () => run("credit", async () => {
    const lines = Object.entries(credit).filter(([, v]) => v.trim()).map(([invoice_line_id, quantity]) => ({ invoice_line_id, quantity }));
    try { await apiPost(`/api/sales/invoices/${id}/credit-notes`, { reason, lines, restock, idempotency_key: cnKey }); setCnKey(newClientKey()); setCredit({}); setReason(""); refresh(); toast.show(t("sales.invoice.toast_credited"), "success"); } catch (err) { fail(err); }
  });
  const creditFull = async () => {
    const amount = fmtMoney(Number(inv.total) - Number(inv.credited));
    if (!(await dialogs.confirm({ title: t("sales.invoice.confirm_full_credit", { number: inv.number ?? "" }), body: t(restock ? "sales.invoice.confirm_full_credit_body_restock" : "sales.invoice.confirm_full_credit_body", { amount, customer: party }), tone: "danger", confirmLabel: t("sales.invoice.confirm_full_credit_btn"), cancelLabel: t("ui.back") }))) return;
    await run("credit-full", async () => {
      try { await apiPost(`/api/sales/invoices/${id}/credit-notes`, { reason, full: true, restock, idempotency_key: cnKey }); setCnKey(newClientKey()); setReason(""); refresh(); toast.show(t("sales.invoice.toast_full_deduct"), "success"); } catch (err) { fail(err); }
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap justify-between items-start gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-extrabold" dir={inv.number ? "ltr" : undefined}>{inv.number ?? t(inv.status === "void" ? "sales.invoice.voided_number" : "sales.invoice.draft_number")}</h2>
          <p className="text-sm font-bold text-united-muted"><PartyLink kind="customer" id={inv.customer.id} name={party} />{inv.buyerTaxId ? ` · ${t("sales.invoice.tax_id_prefix")}${inv.buyerTaxId}` : ""}{inv.order ? <> · <DocLink href={profileHref.order(inv.order.id)}>{inv.order.orderNumber}</DocLink></> : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {inv.status === "issued" && <Link href={`/sales/invoices/${inv.id}/print`} target="_blank" className="btn-secondary">{t("doc.print-ar")}</Link>}
          {inv.status === "issued" && <Link href={`/sales/invoices/${inv.id}/print?lang=en`} target="_blank" className="btn-secondary">{t("doc.print-en")}</Link>}
          <button type="button" className="btn-secondary" onClick={onClose}>{t("ui.back")}</button>
        </div>
      </div>
      {inv.order && (
        <p className="text-sm font-bold text-united-muted">
          {t("doc.order")} <DocLink href={profileHref.order(inv.order.id)}>{inv.order.orderNumber}</DocLink>
          {inv.order.customerPoRef && <> · {t("doc.customer-po")} <bdi dir="ltr">{inv.order.customerPoRef}</bdi></>}
          {` · ${t("doc.delivery")} ${inv.order.deliveryDate}`}
        </p>
      )}
      {inv.status === "draft" && inv.current && <DraftMasterData parties={inv.current} customerId={inv.customer.id} />}
      {manage && inv.status === "draft" && <DraftNotes id={inv.id} notes={inv.notes} version={inv.version} onSaved={refresh} />}
      <span className="self-start">{fullyCredited
        ? <StatusPill tone="neutral" size="md">{t("sales.invoice.fully_credited")}</StatusPill>
        : <StatusPill tone={docTone(inv.status)} size="md">{statusLabels[inv.status] ?? inv.status}{inv.issueDate ? ` ${t("sales.invoice.due_date_text")}${inv.dueDate}` : ""}</StatusPill>}</span>
      <section className="card p-4 flex flex-col divide-y divide-united-dark/5">
        {inv.lines.map((l) => (
          <div key={l.id} className="py-2 flex flex-col gap-1">
            <div className="flex justify-between gap-2 text-sm">
              <span className="font-extrabold">{l.description}</span>
              <span dir="ltr" className="font-extrabold">{fmtMoney(l.total)}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs font-bold text-united-muted">
              {/* Each figure isolated, so in Arabic the unit stays with its quantity: "30 كجم × 15". */}
              <span><bdi>{fmtQty(l.quantity, l.uomCode)}</bdi> × <bdi dir="ltr">{l.unitPrice}</bdi>{Number(l.discountPct) ? <> − <bdi dir="ltr">{l.discountPct}%</bdi></> : null}{Number(l.taxRate) ? <> {t("sales.quotation.tax-prefix")} <bdi dir="ltr">{l.taxRate}%</bdi></> : null}</span>
              {Number(l.creditedQty) > 0 && <span>{t("sales.invoice.is_deducted_text")}<bdi>{fmtQty(l.creditedQty, l.uomCode)}</bdi></span>}
            </div>
            {/* Only a line with something left to credit takes a quantity (the credit-note form below). */}
            {inv.status === "issued" && manage && Number(l.quantity) > Number(l.creditedQty) && (
              <Field label={t("sales.invoice.quantity_to_deduct", { qty: fmtQty(Number(l.quantity) - Number(l.creditedQty), l.uomCode) })}><input className="field text-sm" inputMode="decimal" dir="ltr" value={credit[l.id] ?? ""} onChange={(e) => setCredit({ ...credit, [l.id]: e.target.value })} /></Field>
            )}
          </div>
        ))}
        <div className="pt-2 grid grid-cols-2 gap-1 text-sm font-bold">
          <span>{t("sales.invoice.net")}</span><span dir="ltr" className="num">{fmtMoney(inv.net)}</span>
          <span>{t("sales.invoice.tax")}</span><span dir="ltr" className="num">{fmtMoney(inv.taxTotal)}</span>
          <span className="font-extrabold">{t("sales.invoice.gross")}</span><span dir="ltr" className="num font-bold">{fmtMoney(inv.total)}</span>
          {inv.status === "issued" && <><span>{t("sales.invoice.credited_notifications")}</span><span dir="ltr" className="num">−{fmtMoney(inv.credited)}</span><span>{t("sales.invoice.paid_label")}</span><span dir="ltr" className="num">−{fmtMoney(inv.paid)}</span><span className="font-extrabold">{t("sales.invoice.open_amount_label")}</span><span dir="ltr" className="num font-bold">{fmtMoney(inv.open)}</span></>}
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
      {inv.payments.length > 0 && (
        <section className="card p-4 flex flex-col gap-1">
          <h3 className="font-extrabold">{t("sales.invoice.paid_label")}</h3>
          {inv.payments.map((p) => (
            <div key={p.receiptId} className="flex justify-between text-sm font-bold"><span><DocLink href={profileHref.receipt(p.number)}>{p.number}</DocLink> · {p.date}</span><span dir="ltr">−{fmtMoney(p.amount)}</span></div>
          ))}
        </section>
      )}
      {manage && inv.status === "draft" && (
        <section className="card p-4 flex flex-col gap-2">
          <Field label={t("sales.invoice.issue_date_label")}><input type="date" className="field" value={issueDate} max={todayLocalISO()} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <div className="flex gap-2 flex-wrap items-end">
            <button type="button" className="btn-primary" disabled={!!busy} aria-busy={busy === "issue"} onClick={issue}>{busy === "issue" ? t("sales.invoice.issuing") : t("sales.invoice.issue_now")}</button>
            <Field label={t("sales.invoice.draft_reason_placeholder")} className="flex-1"><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <button type="button" className="btn-danger" disabled={!!busy || !reason.trim()} aria-busy={busy === "void"} onClick={voidDraft}>{busy === "void" ? t("ui.working") : t("sales.invoice.void_draft")}</button>
          </div>
        </section>
      )}
      <section className="card p-4">
        <h3 className="font-extrabold mb-2">{t("doc.attachments")}</h3>
        <AttachmentsPanel entityType="sales_invoice" entityId={inv.id} canManage={manage} />
      </section>
      {manage && inv.status === "issued" && creditable && (
        <section className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold">{t("sales.invoice.credit_note_heading")}</h3>
          <Field label={t("sales.invoice.reason_label")}><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" className="w-5 h-5" checked={restock} onChange={(e) => setRestock(e.target.checked)} />{t("sales.invoice.restock_checkbox")}</label>
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn-primary" disabled={!!busy || !reason.trim()} aria-busy={busy === "credit"} onClick={creditByQty}>{busy === "credit" ? t("ui.saving") : t("sales.invoice.to_credit_by_qty")}</button>
            <button type="button" className="btn-danger" disabled={!!busy || !reason.trim()} aria-busy={busy === "credit-full"} onClick={creditFull}>{busy === "credit-full" ? t("ui.saving") : t("sales.invoice.deduct_full")}</button>
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
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && q.data.rows.length === 0 && <EmptyState icon="✅" title={t("sales.invoice.no_debtors")} />}
      {q.data && q.data.rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-united-muted"><th className="p-2 text-start">{t("sales.customer.name")}</th>{cols.map(([k, l]) => <th key={k} className="p-2">{l}</th>)}</tr></thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.customer.id} className="border-t border-united-dark/5 font-bold">
                  <td className="p-2"><PartyLink kind="customer" id={r.customer.id} name={localName(r.customer, locale)} /></td>
                  {cols.map(([k]) => <td key={k} dir="ltr" className={`p-2 text-center ${k === "d90_plus" && Number(r[k as keyof typeof r]) > 0 ? "text-united-danger" : ""}`}>{Number(r[k as keyof typeof r]) ? formatNumber(r[k as keyof typeof r] as string, { minDp: 2, maxDp: 2 }) : "—"}</td>)}
                </tr>
              ))}
              <tr className="border-t-2 border-united-dark/20 font-extrabold"><td className="p-2">{t("sales.invoice.age.total")}</td>{cols.map(([k]) => <td key={k} dir="ltr" className="p-2 text-center">{formatNumber(q.data!.totals[k], { minDp: 2, maxDp: 2 })}</td>)}</tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A customer's statement for a period (used on the customer screen). */
export function CustomerStatement({ customerId }: { customerId: string }) {
  const { t, locale } = useLocale();
  const today = todayLocalISO();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ["sales", "statement", customerId, from, to], queryFn: () => apiFetch<{ opening: string; closing: string; rows: { id: string; date: string; kind: string; number: string; ref: string; debit: string; credit: string; balance: string; linkId?: string }[] }>(`/api/sales/customers/${customerId}/statement?from=${from}&to=${to}`) });
  // Each line opens the document it is: the invoice (a credit note opens its invoice), the receipt.
  const statementHref = (r: { kind: string; id: string; number: string; linkId?: string }) =>
    r.kind === "invoice" ? profileHref.invoice(r.id) : r.kind === "credit_note" && r.linkId ? profileHref.invoice(r.linkId) : r.kind === "receipt" || r.kind === "receipt_reversal" ? profileHref.receipt(r.number) : r.kind === "opening_balance" ? profileHref.opening() : null;
  return (
    <section className="card p-4 flex flex-col gap-2">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <h3 className="font-extrabold">{t("sales.invoice.statement_title")}</h3>
        <a className="btn-secondary text-sm" href={`/api/sales/customers/${customerId}/statement/export?from=${from}&to=${to}&lang=${locale}`} download>{t("profile.export-csv")}</a>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input type="date" className="field" aria-label={t("accounting.date-from")} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="field" aria-label={t("accounting.date-to")} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-united-muted"><th className="p-1 text-start">{t("sales.invoice.stmt.date")}</th><th className="p-1 text-start">{t("sales.invoice.stmt.document")}</th><th className="p-1">{t("sales.invoice.stmt.debit")}</th><th className="p-1">{t("sales.invoice.stmt.credit")}</th><th className="p-1">{t("sales.invoice.stmt.balance")}</th></tr></thead>
            <tbody>
              <tr className="font-bold text-united-muted"><td className="p-1" colSpan={4}>{t("sales.invoice.stmt.opening_balance")}</td><td dir="ltr" className="p-1 text-center">{formatNumber(q.data.opening, { minDp: 2, maxDp: 2 })}</td></tr>
              {q.data.rows.map((r) => (
                <tr key={r.id} className="border-t border-united-dark/5 font-bold">
                  <td className="p-1">{r.date}</td><td className="p-1"><DocLink href={statementHref(r)}>{statementLine(r, locale).number}</DocLink> <span className="text-xs text-united-muted">{statementLine(r, locale).ref}</span></td>
                  <td dir="ltr" className="p-1 text-center">{Number(r.debit) ? formatNumber(r.debit, { minDp: 2, maxDp: 2 }) : ""}</td><td dir="ltr" className="p-1 text-center">{Number(r.credit) ? formatNumber(r.credit, { minDp: 2, maxDp: 2 }) : ""}</td><td dir="ltr" className="p-1 text-center">{formatNumber(r.balance, { minDp: 2, maxDp: 2 })}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-united-dark/20 font-extrabold"><td className="p-1" colSpan={4}>{t("sales.invoice.stmt.closing_balance")}</td><td dir="ltr" className="p-1 text-center">{formatNumber(q.data.closing, { minDp: 2, maxDp: 2 })}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
