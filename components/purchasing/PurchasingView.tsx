"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { Segmented } from "@/components/ui/Segmented";
import { BillsView } from "@/components/purchasing/BillsView";
import { useLocale, type Locale } from "@/lib/locale/useLocale";
import { localName, otherLocalName } from "@/lib/locale/names";

/**
 * Purchasing: suppliers and what they charge, requests for quotation, purchase orders
 * and their approval, and (for finance) supplier bills. Prices appear only for those
 * allowed to see them — the server leaves them out otherwise.
 */

type Tab = "orders" | "replenishment" | "rfqs" | "suppliers" | "bills";
type Catalog = { products: { id: string; name: string; nameAr: string | null; unit: string; packagings: { uomCode: string }[] }[] };
type SupplierRow = { id: string; code: string; name: string; nameAr?: string | null; type: string; phone: string | null; city: string | null; paymentTermsDays: number; leadTimeDays: number | null; active: boolean; version: number; taxRegistrationNo: string | null; email: string | null; address: string | null };

function errorMsg(err: unknown): string {
  if (err instanceof ApiClientError && err.message) return err.message;
  // Never an empty toast: an unexpected failure still says something, in the UI language.
  const en = typeof document !== "undefined" && document.documentElement.lang === "en";
  return en ? "Something went wrong — please try again" : "حصل خطأ — حاول تاني";
}

export function PurchasingView() {
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>("orders");
  const [poId, setPoId] = useState<string | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [rfqSeed, setRfqSeed] = useState<{ product_id: string; quantity: string; uom: string; unit_price: string }[] | null>(null);

  // Build localized status/type maps and tab labels inside component body
  const { t, locale } = useLocale();
  const PO_STATUS = {
    draft:       { label: t("purchasing.po.status.draft"),       cls: "bg-united-dark/5" },
    pending_approval: { label: t("purchasing.po.status.pending_approval"), cls: "bg-united-warn/10 text-united-warn" },
    approved:    { label: t("purchasing.po.status.approved"),   cls: "bg-blue-50 text-blue-700" },
    sent:        { label: t("purchasing.po.status.sent"),       cls: "bg-blue-50 text-blue-700" },
    partially_received: { label: t("purchasing.po.status.partially_received"), cls: "bg-united-warn/10 text-united-warn" },
    received:    { label: t("purchasing.po.status.received"),   cls: "bg-united-green/10 text-united-green" },
    closed:      { label: t("purchasing.po.status.closed"),     cls: "bg-united-dark/5 text-united-muted" },
    cancelled:   { label: t("purchasing.po.status.cancelled"),  cls: "bg-united-danger/10 text-united-danger" },
  };
  const sup_type = {
    farm:         t("purchasing.supplier.type.farm"),
    grower:       t("purchasing.supplier.type.grower"),
    wholesaler:   t("purchasing.supplier.type.wholesaler"),
    market_trader: t("purchasing.supplier.type.market_trader"),
    importer:     t("purchasing.supplier.type.importer"),
    packaging:    t("purchasing.supplier.type.packaging"),
    services:     t("purchasing.supplier.type.services"),
    other:        t("purchasing.supplier.type.other"),
  };

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("po")) setPoId(sp.get("po"));
    if (sp.get("bill")) { setBillId(sp.get("bill")); setTab("bills"); }
    if (sp.get("tab")) setTab(sp.get("tab") as Tab);
  }, []);
  const tabs: { key: Tab; label: string }[] = [
    ...(can("purchasing.orders.view") ? [
      { key: "orders" as Tab, label: t("purchasing.orders") },
      ...(can("purchasing.rfq.manage") ? [{ key: "replenishment" as Tab, label: t("purchasing.replenishment.tab") }] : []),
    ] : []),
    ...(can("purchasing.rfq.manage") ? [{ key: "rfqs" as Tab, label: t("purchasing.rfqs") }] : []),
    ...(can("purchasing.suppliers.view") ? [{ key: "suppliers" as Tab, label: t("purchasing.suppliers") }] : []),
    ...(can("purchasing.bills.view") ? [{ key: "bills" as Tab, label: t("purchasing.bills") }] : []),
  ];
  return (
    <div className="page-container">
      <h1 className="page-title">{t("purchasing.title")}</h1>
      <Tabs value={tab} onChange={(tVal) => { setTab(tVal); setPoId(null); setBillId(null); }} items={tabs} />
      {poId ? (
        <PoDetail id={poId} onClose={() => setPoId(null)} locale={locale} t={t} poStatus={PO_STATUS} />
      ) : tab === "orders" ? (
        <Orders onOpen={setPoId} locale={locale} t={t} poStatus={PO_STATUS} />
      ) : tab === "replenishment" ? (
        <Replenishment onCreateRfq={(lines) => { setRfqSeed(lines); setTab("rfqs"); }} locale={locale} t={t} />
      ) : tab === "rfqs" ? (
        <Rfqs onOpenPo={setPoId} seedLines={rfqSeed ?? undefined} onSeedUsed={() => setRfqSeed(null)} locale={locale} t={t} />
      ) : tab === "bills" ? (
        <BillsView key={billId ?? "list"} initialBillId={billId} />
      ) : (
        <Suppliers locale={locale} t={t} sup_type={sup_type} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

type PoLine = { id: string; lineNo: number; productId: string; product: { name: string; nameAr: string | null; unit: string }; uomCode: string; quantity: string; baseQuantity: string; receivedGood: string; rejected: string; remaining: string; unitPrice?: string; discountPct?: string; taxRate?: string; priceSource?: string; amounts?: { total: string } };
type Po = { id: string; number: string; status: string; supplier: { id: string; code: string; name: string; nameAr?: string | null }; orderDate: string; expectedDate: string | null; notes: string | null; cancelReason: string | null; approvedBy: string | null; version: number; createdBy: string; lines: PoLine[]; total?: string; net?: string; taxTotal?: string; currencyCode?: string };

function Orders({ onOpen, locale, t, poStatus }: { onOpen: (id: string) => void; locale: Locale; t: (key: string) => string; poStatus: Record<string, { label: string; cls: string }> }) {
  const { can } = usePermissions();
  const [status, setStatus] = useState("open");
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ["purchasing", "orders", status], queryFn: () => apiFetch<{ orders: Po[] }>(`/api/purchasing/orders${status === "open" ? "?open=1" : status ? `?status=${status}` : ""}`) });
  if (creating) return <NewPo onDone={(id) => { setCreating(false); if (id) onOpen(id); }} locale={locale} t={t} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <div className="flex-1"><Segmented value={status} onChange={setStatus} items={[
          { key: "open", label: t("purchasing.orders.filter.open") },
          { key: "draft", label: t("purchasing.orders.filter.drafts") },
          { key: "pending_approval", label: t("purchasing.orders.filter.pending_approval") },
          { key: "", label: t("purchasing.orders.filter.all") },
        ]} /></div>
        {can("purchasing.orders.manage") && <button type="button" className="btn-primary shrink-0" onClick={() => setCreating(true)}>{t("purchasing.orders.btn.new")}</button>}
      </div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t("sales.invoice.error-generic")} onRetry={() => q.refetch()} />}
      {q.data && q.data.orders.length === 0 && <EmptyState icon="🛒" title={t("purchasing.orders.empty")} />}
      <ul className="flex flex-col gap-2">
        {q.data?.orders.map((po) => (
          <li key={po.id}>
            <button type="button" className="card p-3 w-full text-start flex justify-between gap-2" onClick={() => onOpen(po.id)}>
              <div>
                <div className="font-extrabold"><span dir="ltr">{po.number}</span> · {localName(po.supplier, locale)}</div>
                <div className="text-xs font-bold text-united-muted">{po.lines.length} {t("purchasing.orders.lines_label")} · {po.orderDate}{po.expectedDate ? ` · ${t("purchasing.orders.expected_date")} ${po.expectedDate}` : ""}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className={`rounded-full px-2 text-xs font-extrabold ${poStatus[po.status]?.cls}`}>{poStatus[po.status]?.label}</span>
                {po.total !== undefined && <span dir="ltr" className="font-extrabold">{fmtMoney(po.total)}</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useCatalog() {
  return useQuery({ queryKey: ["purchasing", "catalog"], queryFn: () => apiFetch<Catalog>("/api/sales/catalog"), staleTime: 60_000 });
}
function useSuppliers() {
  return useQuery({ queryKey: ["purchasing", "suppliers"], queryFn: () => apiFetch<{ suppliers: SupplierRow[] }>("/api/purchasing/suppliers") });
}

function LineEditor({ lines, setLines, withPrice, t }: { lines: { product_id: string; quantity: string; uom: string; unit_price: string }[]; setLines: (l: { product_id: string; quantity: string; uom: string; unit_price: string }[]) => void; withPrice: boolean; t: (key: string) => string }) {
  const { locale } = useLocale();
  const catalog = useCatalog();
  const products = catalog.data?.products ?? [];
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  return (
    <div className="flex flex-col gap-2">
      {lines.map((l, i) => {
        const p = products.find((x) => x.id === l.product_id);
        return (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-5 gap-2 border-t border-united-dark/5 pt-2">
            <select className="field font-bold col-span-2" value={l.product_id} onChange={(e) => set(i, { product_id: e.target.value, uom: "" })}>
              <option value="">{t("purchasing.line.product.placeholder")}</option>
              {products.map((x) => <option key={x.id} value={x.id}>{localName(x, locale)}</option>)}
            </select>
            <input className="field" inputMode="decimal" dir="ltr" placeholder={t("purchasing.line.quantity.placeholder")} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
            <select className="field" value={l.uom} onChange={(e) => set(i, { uom: e.target.value })}>
              <option value="">{p?.unit ?? t("purchasing.line.unit.default")}</option>
              {(p?.packagings ?? []).map((x) => <option key={x.uomCode} value={x.uomCode}>{x.uomCode}</option>)}
            </select>
            {withPrice && <input className="field" inputMode="decimal" dir="ltr" placeholder={t("purchasing.line.price.placeholder")} value={l.unit_price} onChange={(e) => set(i, { unit_price: e.target.value })} />}
          </div>
        );
      })}
      <button type="button" className="btn-secondary self-start" onClick={() => setLines([...lines, { product_id: "", quantity: "", uom: "", unit_price: "" }])}>{t("purchasing.line.add_btn")}</button>
    </div>
  );
}

const cleanLines = (lines: { product_id: string; quantity: string; uom: string; unit_price: string }[]) =>
  lines.filter((l) => l.product_id && l.quantity).map((l) => ({ product_id: l.product_id, quantity: l.quantity, uom: l.uom || undefined, unit_price: l.unit_price || undefined }));

function NewPo({ onDone, locale, t }: { onDone: (id?: string) => void; locale: Locale; t: (key: string) => string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const suppliers = useSuppliers();
  const [supplierId, setSupplierId] = useState("");
  const [expected, setExpected] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ product_id: "", quantity: "", uom: "", unit_price: "" }]);
  const [busy, setBusy] = useState(false);
  return (
    <form className="card p-4 flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        const r = await apiPost<{ order: Po }>("/api/purchasing/orders", { supplier_id: supplierId, expected_date: expected || undefined, notes: notes || undefined, lines: cleanLines(lines) });
        void qc.invalidateQueries({ queryKey: ["purchasing"] });
        toast.show(t("purchasing.new_po.toast").replace("%s", r.order.number), "success");
        onDone(r.order.id);
      } catch (err) { toast.show(errorMsg(err), "error"); } finally { setBusy(false); }
    }}>
      <div className="flex justify-between"><h3 className="font-extrabold">{t("purchasing.new_po.title")}</h3><button type="button" className="btn-secondary" onClick={() => onDone()}>{t("purchasing.common.back")}</button></div>
      <Field label={t("purchasing.new_po.supplier.label")}>
        <select className="field font-bold" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">{t("purchasing.new_po.supplier.placeholder")}</option>
          {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{localName(s, locale)}</option>)}
        </select>
      </Field>
      <Field label={t("purchasing.new_po.expected_date.label")}><input type="date" className="field" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      <LineEditor lines={lines} setLines={setLines} withPrice t={t} />
      <input className="field" placeholder={t("purchasing.new_po.notes.placeholder")} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button className="btn-primary text-lg" disabled={busy || !supplierId}>{busy ? t("purchasing.new_po.saving") : t("purchasing.new_po.save_draft")}</button>
    </form>
  );
}

function PoDetail({ id, onClose, locale, t, poStatus }: { id: string; onClose: () => void; locale: Locale; t: (key: string) => string; poStatus: Record<string, { label: string; cls: string }> }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["purchasing", "order", id], queryFn: () => apiFetch<{ order: Po }>(`/api/purchasing/orders/${id}`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={t("sales.invoice.error-generic")} onRetry={() => q.refetch()} />;
  const po = q.data.order;
  const manage = can("purchasing.orders.manage");
  const act = async (path: string, body: Record<string, unknown> = {}) => {
    try { await apiPost(`/api/purchasing/orders/${id}/${path}`, body); setReason(""); void qc.invalidateQueries({ queryKey: ["purchasing"] }); } catch (err) { toast.show(errorMsg(err), "error"); }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center gap-2">
        <div>
          <h2 className="text-xl font-extrabold" dir="ltr">{po.number}</h2>
          <p className="text-sm font-bold text-united-muted">{localName(po.supplier, locale)} · {po.orderDate}{po.expectedDate ? ` · ${t("purchasing.po_detail.expected")} ${po.expectedDate}` : ""}</p>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>{t("purchasing.common.back")}</button>
      </div>
      <span className={`self-start rounded-full px-3 py-1 text-sm font-extrabold ${poStatus[po.status]?.cls}`}>
        {poStatus[po.status]?.label}
        {po.approvedBy ? ` · ${t("purchasing.po_detail.approved_by").replace("%s", po.approvedBy)}` : ""}
      </span>
      <section className="card p-4 flex flex-col divide-y divide-united-dark/5">
        {po.lines.map((l) => (
          <div key={l.id} className="py-2 flex flex-col gap-1">
            <div className="flex justify-between text-sm font-extrabold">
              <span>{localName(l.product, locale)}</span>
              {l.amounts && <span dir="ltr">{fmtMoney(l.amounts.total)}</span>}
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-xs font-bold text-united-muted">
              <span dir="ltr">{fmtQty(l.quantity, l.uomCode)}{l.uomCode !== l.product.unit ? ` = ${fmtQty(l.baseQuantity, l.product.unit)}` : ""}{l.unitPrice ? ` × ${l.unitPrice}` : ""}</span>
              <span>{t("purchasing.po_detail.qty_good")} {fmtQty(l.receivedGood, l.product.unit)}{Number(l.rejected) ? ` · ${t("purchasing.po_detail.rejected")} ${fmtQty(l.rejected, l.product.unit)}` : ""} · {t("purchasing.po_detail.remaining")} {fmtQty(l.remaining, l.product.unit)}</span>
            </div>
          </div>
        ))}
        {po.total !== undefined && <div className="pt-2 flex justify-between font-extrabold"><span>{t("purchasing.po_detail.total")}</span><span dir="ltr">{fmtMoney(po.total)}</span></div>}
      </section>
      {po.cancelReason && <p className="text-sm font-bold text-united-muted">{t("purchasing.po_detail.cancel_reason")}: {po.cancelReason}</p>}
      {manage && !["cancelled", "closed", "received"].includes(po.status) && (
        <section className="card p-4 flex flex-wrap gap-2">
          {po.status === "draft" && <button type="button" className="btn-primary" onClick={() => act("submit")}>{t("purchasing.po_detail.submit_btn")}</button>}
          {po.status === "approved" && <button type="button" className="btn-primary" onClick={() => act("send")}>{t("purchasing.po_detail.send_to_supplier")}</button>}
          <input className="field flex-1" placeholder={t("purchasing.po_detail.reason_placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
          {["draft", "pending_approval", "approved", "sent"].includes(po.status) && <button type="button" className="btn-danger" onClick={() => act("cancel", { reason })}>{t("purchasing.po_detail.cancel_btn")}</button>}
          {["sent", "partially_received"].includes(po.status) && <button type="button" className="btn-secondary" onClick={() => act("close", { reason })}>{t("purchasing.po_detail.close_btn")}</button>}
        </section>
      )}
    </div>
  );
}

function Replenishment({ onCreateRfq, locale, t }: { onCreateRfq: (lines: { product_id: string; quantity: string; uom: string; unit_price: string }[]) => void; locale: Locale; t: (key: string) => string }) {
  const q = useQuery({ queryKey: ["purchasing", "replenishment"], queryFn: () => apiFetch<{ replenishment: { warehouse: { code: string; name: string; nameAr?: string | null; nameEn?: string | null }; suggestions: { productId: string; productName: string; unit: string; available: string; reorderPointQty: string; maxStockQty: string | null; suggestedQty: string }[] } }>("/api/purchasing/orders?replenishment=1") });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={errorMsg(q.error)} onRetry={() => q.refetch()} />;
  const suggestions = q.data?.replenishment.suggestions ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-united-muted">{t("purchasing.replenishment.desc")} · {q.data ? localName(q.data.replenishment.warehouse, locale) : ""}</div>
      {suggestions.length === 0 ? <div><EmptyState icon="📦" title={t("purchasing.replenishment.empty")} /><p className="text-center text-sm text-united-muted -mt-10">{t("purchasing.replenishment.adjust_hint")}</p></div> : (
        <>
          <div className="flex justify-end"><button type="button" className="btn-primary" disabled={!Object.values(selected).some(Boolean)} onClick={() => onCreateRfq(suggestions.filter((s) => selected[s.productId]).map((s) => ({ product_id: s.productId, quantity: s.suggestedQty, uom: s.unit, unit_price: "" })))}>{t("purchasing.replenishment.prepare_btn")}</button></div>
          <ul className="flex flex-col gap-2">{suggestions.map((s) => (
            <li key={s.productId}>
              <label className="card p-3 flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={!!selected[s.productId]} onChange={(e) => setSelected({ ...selected, [s.productId]: e.target.checked })} />
                <span className="flex-1"><strong>{s.productName}</strong><span className="block text-xs text-united-muted">{t("purchasing.replenishment.available")} {fmtQty(s.available)} · {t("purchasing.replenishment.reorder_point")} {fmtQty(s.reorderPointQty)} · {t("purchasing.replenishment.target")} {s.maxStockQty ? fmtQty(s.maxStockQty) : fmtQty(s.reorderPointQty)}</span></span>
                <span className="font-extrabold">{t("purchasing.replenishment.order_qty")} {fmtQty(s.suggestedQty)} {s.unit}</span>
              </label>
            </li>
          ))}</ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RFQs
// ---------------------------------------------------------------------------

type RfqDetail = {
  id: string; number: string; status: string; neededBy: string | null;
  invited: { supplier: { id: string; code: string; name: string; nameAr?: string | null }; status: string; validUntil: string | null }[];
  comparison: { line: { id: string; product: { name: string; nameAr: string | null; unit: string }; uomCode: string; quantity: string }; quotes: { supplier: { id: string; name: string; nameAr?: string | null }; unitPrice: string; leadTimeDays: number | null; awarded: boolean }[]; cheapestSupplierId: string | null }[];
  orders: { id: string; number: string; status: string }[];
};

function Rfqs({ onOpenPo, seedLines, onSeedUsed, locale, t }: { onOpenPo: (id: string) => void; seedLines?: { product_id: string; quantity: string; uom: string; unit_price: string }[]; onSeedUsed: () => void; locale: Locale; t: (key: string) => string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (seedLines?.length) { setCreating(true); onSeedUsed(); } }, [seedLines, onSeedUsed]);
  const q = useQuery({ queryKey: ["purchasing", "rfqs"], queryFn: () => apiFetch<{ rfqs: { id: string; number: string; status: string; neededBy: string | null; _count: { lines: number; suppliers: number }; suppliers: { status: string }[] }[] }>("/api/purchasing/rfqs") });
  if (open) return <RfqView id={open} onClose={() => setOpen(null)} onOpenPo={onOpenPo} locale={locale} t={t} />;
  if (creating) return <NewRfq initialLines={seedLines} onDone={(id) => { setCreating(false); if (id) setOpen(id); }} locale={locale} t={t} />;
  return (
    <div className="flex flex-col gap-3">
      <button type="button" className="btn-primary self-start" onClick={() => setCreating(true)}>{t("purchasing.rfqs.new_btn")}</button>
      {q.data && q.data.rfqs.length === 0 && <EmptyState icon="📨" title={t("purchasing.rfqs.empty")} />}
      <ul className="flex flex-col gap-2">
        {q.data?.rfqs.map((r) => (
          <li key={r.id}>
            <button type="button" className="card p-3 w-full text-start flex justify-between" onClick={() => setOpen(r.id)}>
              <span className="font-extrabold" dir="ltr">{r.number}</span>
              <span className="text-xs font-bold text-united-muted">{r._count.lines} {t("purchasing.rfqs.items_count")} · {r.suppliers.filter((s) => s.status === "quoted").length}/{r._count.suppliers} {t("purchasing.rfqs.responses")} · {r.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewRfq({ onDone, initialLines, locale, t }: { onDone: (id?: string) => void; initialLines?: { product_id: string; quantity: string; uom: string; unit_price: string }[]; locale: Locale; t: (key: string) => string }) {
  const toast = useToast();
  const suppliers = useSuppliers();
  const [picked, setPicked] = useState<string[]>([]);
  const [neededBy, setNeededBy] = useState("");
  const [lines, setLines] = useState(initialLines?.length ? initialLines : [{ product_id: "", quantity: "", uom: "", unit_price: "" }]);
  return (
    <form className="card p-4 flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await apiPost<{ rfq: { id: string } }>("/api/purchasing/rfqs", { needed_by: neededBy || undefined, supplier_ids: picked, lines: cleanLines(lines).map(({ unit_price: _u, ...x }) => x) });
        onDone(r.rfq.id);
      } catch (err) { toast.show(errorMsg(err), "error"); }
    }}>
      <div className="flex justify-between"><h3 className="font-extrabold">{t("purchasing.rfqs")}</h3><button type="button" className="btn-secondary" onClick={() => onDone()}>{t("purchasing.common.back")}</button></div>
      <Field label={t("purchasing.rfqs.neededby")}><input type="date" className="field" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} /></Field>
      <LineEditor lines={lines} setLines={setLines} withPrice={false} t={t} />
      <div className="flex flex-wrap gap-2">
        {(suppliers.data?.suppliers ?? []).map((s) => (
          <button type="button" key={s.id} onClick={() => setPicked(picked.includes(s.id) ? picked.filter((x) => x !== s.id) : [...picked, s.id])} className={`tap-target px-3 rounded-xl text-sm font-extrabold ${picked.includes(s.id) ? "bg-united-green text-white" : "bg-united-dark/5"}`}>{localName(s, locale)}</button>
        ))}
      </div>
      <button className="btn-primary" disabled={!picked.length}>{t("purchasing.supplier.edit_terms_save")}</button>
    </form>
  );
}

function RfqView({ id, onClose, onOpenPo, locale, t }: { id: string; onClose: () => void; onOpenPo: (id: string) => void; locale: Locale; t: (key: string) => string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [award, setAward] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<{ supplier: string; prices: Record<string, string> }>({ supplier: "", prices: {} });
  const q = useQuery({ queryKey: ["purchasing", "rfq", id], queryFn: () => apiFetch<{ rfq: RfqDetail }>(`/api/purchasing/rfqs/${id}`) });
  if (!q.data) return <LoadingState />;
  const r = q.data.rfq;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["purchasing"] });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><h2 className="text-xl font-extrabold" dir="ltr">{r.number}</h2><button type="button" className="btn-secondary" onClick={onClose}>{t("purchasing.common.back")}</button></div>
      <p className="text-sm font-bold text-united-muted">
        {r.status}
        {r.neededBy ? ` · ${t("purchasing.rfqs.neededby")} ${r.neededBy}` : ""} ·
        {r.invited.map((i) => `${localName(i.supplier, locale)} (${i.status === "quoted" ? t("purchasing.rfq_status.quoted") : i.status === "declined" ? t("purchasing.rfq_status.declined") : t("purchasing.rfq_status.pending")})`).join(locale === "en" ? ", " : "، ")}
      </p>
      {r.status === "draft" && <button type="button" className="btn-primary self-start" onClick={async () => { try { await apiPost(`/api/purchasing/rfqs/${id}/send`, {}); refresh(); } catch (err) { toast.show(errorMsg(err), "error"); } }}>{t("purchasing.rfq.send_to_suppliers")}</button>}
      <section className="card p-4 flex flex-col gap-3">
        <h3 className="font-extrabold">{t("purchasing.rfq.comparison_title")}</h3>
        {r.comparison.map((c) => (
          <div key={c.line.id} className="border-b border-united-dark/5 pb-2">
            <div className="font-extrabold text-sm">{localName(c.line.product, locale)} · <span dir="ltr">{fmtQty(c.line.quantity, c.line.uomCode)}</span></div>
            {c.quotes.length === 0 && <p className="text-xs font-bold text-united-muted">{t("purchasing.rfq.no_quotes")}</p>}
            {c.quotes.map((x) => (
              <label key={x.supplier.id} className="flex items-center justify-between text-sm font-bold py-1">
                <span className="flex items-center gap-2">
                  {r.status === "sent" && <input type="radio" name={c.line.id} checked={award[c.line.id] === x.supplier.id} onChange={() => setAward({ ...award, [c.line.id]: x.supplier.id })} />}
                  {localName(x.supplier, locale)}
                  {x.supplier.id === c.cheapestSupplierId ? ` · ${t("purchasing.rfq.cheapest")}` : ""}
                  {x.awarded ? ` · ${t("purchasing.rfq.awarded_text")}` : ""}
                  {x.leadTimeDays != null ? ` · ${x.leadTimeDays} ${t("purchasing.rfq.days_label")}` : ""}
                </span>
                <span dir="ltr">{x.unitPrice} / {c.line.uomCode}</span>
              </label>
            ))}
          </div>
        ))}
        {r.status === "sent" && (
          <button type="button" className="btn-primary self-start" disabled={!Object.keys(award).length} onClick={async () => {
            try {
              const res = await apiPost<{ orders: { id: string; number: string }[] }>(`/api/purchasing/rfqs/${id}/award`, { awards: Object.entries(award).map(([rfq_line_id, supplier_id]) => ({ rfq_line_id, supplier_id })) });
              const nums = res.orders.map((o) => o.number).join(locale === "en" ? ", " : "، ");
              toast.show(t("purchasing.new_po.toast").replace("%s", nums), "success");
              refresh();
            } catch (err) { toast.show(errorMsg(err), "error"); }
          }}>{t("purchasing.rfq.award_btn")}</button>
        )}
      </section>
      {r.status === "sent" && (
        <section className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold">{t("purchasing.rfq.quote_section_title")}</h3>
          <select className="field font-bold" value={quote.supplier} onChange={(e) => setQuote({ supplier: e.target.value, prices: {} })}>
            <option value="">{t("purchasing.rfq.quote_supplier")}</option>
            {r.invited.map((i) => <option key={i.supplier.id} value={i.supplier.id}>{localName(i.supplier, locale)}</option>)}
          </select>
          {quote.supplier && r.comparison.map((c) => (
            <div key={c.line.id} className="flex items-center gap-2 text-sm font-bold">
              <span className="flex-1">{localName(c.line.product, locale)} ({c.line.uomCode})</span>
              <input className="field w-32" inputMode="decimal" dir="ltr" placeholder={t("purchasing.rfq.quote_price")} value={quote.prices[c.line.id] ?? ""} onChange={(e) => setQuote({ ...quote, prices: { ...quote.prices, [c.line.id]: e.target.value } })} />
            </div>
          ))}
          {quote.supplier && (
            <button type="button" className="btn-primary self-start" onClick={async () => {
              try {
                await apiPost(`/api/purchasing/rfqs/${id}/quotes`, { supplier_id: quote.supplier, lines: Object.entries(quote.prices).filter(([, v]) => v.trim()).map(([rfq_line_id, unit_price]) => ({ rfq_line_id, unit_price })) });
                setQuote({ supplier: "", prices: {} });
                refresh();
              } catch (err) { toast.show(errorMsg(err), "error"); }
            }}>{t("purchasing.rfq.save_quote_btn")}</button>
          )}
        </section>
      )}
      {r.orders.length > 0 && (
        <div className="flex flex-wrap gap-2">{r.orders.map((o) => <button type="button" key={o.id} className="btn-secondary" onClick={() => onOpenPo(o.id)} dir="ltr">{o.number}</button>)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

function Suppliers({ locale, t, sup_type }: { locale: Locale; t: (key: string) => string; sup_type: Record<string, string> }) {
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useSuppliers();
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", name_ar: "", type: "farm", payment_terms_days: "0", tax_registration_no: "" });
  if (open) return <SupplierDetail id={open} onClose={() => setOpen(null)} locale={locale} t={t} />;
  return (
    <div className="flex flex-col gap-3">
      {can("purchasing.suppliers.manage") && (
        <form className="card p-3 grid grid-cols-2 sm:grid-cols-5 gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await apiPost("/api/purchasing/suppliers", { name: form.name, name_ar: form.name_ar || null, type: form.type, payment_terms_days: Number(form.payment_terms_days || 0), tax_registration_no: form.tax_registration_no || undefined });
            setForm({ name: "", name_ar: "", type: "farm", payment_terms_days: "0", tax_registration_no: "" });
            void qc.invalidateQueries({ queryKey: ["purchasing", "suppliers"] });
          } catch (err) { toast.show(errorMsg(err), "error"); }
        }}>
          <input className="field col-span-2" placeholder={t("purchasing.supplier.form.name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="field col-span-2" dir="rtl" lang="ar" placeholder={t("purchasing.supplier.form.name_ar")} value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })} />
          <select className="field" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {Object.entries(sup_type).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className="field" inputMode="numeric" dir="ltr" placeholder={t("purchasing.supplier.form.payment_terms")} value={form.payment_terms_days} onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value })} />
          <button className="btn-secondary">{t("purchasing.supplier.form.add_btn")}</button>
        </form>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        {q.data?.suppliers.map((s) => (
          <li key={s.id}>
            <button type="button" className="card p-3 w-full text-start" onClick={() => setOpen(s.id)}>
              <div className="flex justify-between"><span className="font-extrabold">{localName(s, locale)}</span><span className="text-xs font-bold text-united-muted" dir="ltr">{s.code}</span></div>
              <div className="text-xs font-bold text-united-muted">
                {sup_type[s.type]} ·
                {s.paymentTermsDays ? ` ${t("purchasing.supplier.term_due").replace("%s", String(s.paymentTermsDays))}` : t("purchasing.supplier.cash")}
                {s.leadTimeDays != null ? ` · ${t("purchasing.supplier.lead_time").replace("%s", String(s.leadTimeDays))}` : ""}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SupplierDetail({ id, onClose, locale, t }: { id: string; onClose: () => void; locale: Locale; t: (key: string) => string }) {
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["purchasing", "supplier", id], queryFn: () => apiFetch<{ supplier: SupplierRow & { contacts: { id: string; name: string; phone: string | null; isPrimary: boolean }[] } }>(`/api/purchasing/suppliers/${id}`) });
  const prices = useQuery({ queryKey: ["purchasing", "supplier", id, "prices"], queryFn: () => apiFetch<{ prices: { id: string; uomCode: string; unitPrice: string; validFrom: string; createdBy: string; product: { name: string; nameAr: string | null } }[] }>(`/api/purchasing/suppliers/${id}/prices`), enabled: can("purchasing.prices.view") });
  const catalog = useCatalog();
  const [nameAr, setNameAr] = useState<string | null>(null);
  const [savingNameAr, setSavingNameAr] = useState(false);
  const [price, setPrice] = useState({ product_id: "", unit_price: "", valid_from: todayLocalISO() });
  if (!q.data) return <LoadingState />;
  const s = q.data.supplier;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["purchasing"] });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><div><h2 className="text-xl font-extrabold">{localName(s, locale)}</h2><p className="text-xs font-bold text-united-muted" dir="ltr">{s.code}{s.taxRegistrationNo ? ` · ${t("purchasing.supplier.detail.tax").replace("%s", s.taxRegistrationNo!)}` : ""}</p></div><button type="button" className="btn-secondary" onClick={onClose}>{t("purchasing.common.back")}</button></div>
      <section className="card p-4 flex flex-col gap-2 text-sm font-bold">
        {otherLocalName(s, locale) && <div dir="auto" className="text-united-muted">{otherLocalName(s, locale)}</div>}
        <div>
          <span className="text-united-muted">{t("purchasing.supplier.type." + s.type) ?? s.type}</span>
          {s.phone && <span className="ms-2 text-united-green">· {s.phone}</span>}
          {s.city && <span className="ms-2">· {s.city}</span>}
          {s.address && <span className="ms-2">· {s.address}</span>}
        </div>
        {can("purchasing.suppliers.manage") && (
          <form className="flex gap-2 items-center" onSubmit={async (e) => {
            e.preventDefault();
            if (nameAr === null || savingNameAr) return;
            setSavingNameAr(true);
            try {
              await apiPatch(`/api/purchasing/suppliers/${id}`, { name_ar: nameAr, expected_version: s.version });
              setNameAr(null);
              toast.show(t("purchasing.supplier.name_ar.saved"), "success");
              refresh();
            } catch (err) { toast.show(errorMsg(err), "error"); }
            finally { setSavingNameAr(false); }
          }}>
            <input className="field flex-1" dir="rtl" lang="ar" placeholder={t("purchasing.supplier.form.name_ar")} value={nameAr ?? s.nameAr ?? ""} onChange={(e) => setNameAr(e.target.value)} />
            <button type="submit" className="btn-secondary text-sm" disabled={nameAr === null || savingNameAr}>{t("purchasing.supplier.name_ar.save")}</button>
          </form>
        )}
        {s.leadTimeDays != null && <div>{t("purchasing.supplier.detail.delivery_in").replace("%s", String(s.leadTimeDays))}</div>}
        {!s.leadTimeDays && <div className="text-united-muted">{t("purchasing.supplier.detail.not_logged")}</div>}
      </section>
      {can("purchasing.prices.view") && prices.data && (
        <section className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold">{t("purchasing.supplier.prices_title")}</h3>
          {/* Registering an agreed price (restored: dropped in the 37f9064 redesign). */}
          {can("purchasing.prices.manage") && (
            <form className="grid grid-cols-2 gap-2 sm:grid-cols-4" onSubmit={async (e) => {
              e.preventDefault();
              if (!price.product_id || !price.unit_price.trim()) return;
              try {
                await apiPost(`/api/purchasing/suppliers/${id}/prices`, { valid_from: price.valid_from, prices: [{ product_id: price.product_id, unit_price: price.unit_price.trim() }] });
                setPrice({ ...price, unit_price: "" });
                toast.show(t("purchasing.supplier.price_registered"), "success");
                refresh();
              } catch (err) { toast.show(errorMsg(err), "error"); }
            }}>
              <select className="field col-span-2" value={price.product_id} onChange={(e) => setPrice({ ...price, product_id: e.target.value })} aria-label={t("purchasing.line.product.placeholder")}>
                <option value="">{t("purchasing.line.product.placeholder")}</option>
                {(catalog.data?.products ?? []).map((p) => <option key={p.id} value={p.id}>{localName(p, locale)} ({p.unit})</option>)}
              </select>
              <input className="field" dir="ltr" inputMode="decimal" placeholder={t("purchasing.rfq.quote_price")} aria-label={t("purchasing.rfq.quote_price")} value={price.unit_price} onChange={(e) => setPrice({ ...price, unit_price: e.target.value })} />
              <input className="field" type="date" value={price.valid_from} onChange={(e) => setPrice({ ...price, valid_from: e.target.value })} aria-label={t("purchasing.supplier.price_valid_from")} />
              <button type="submit" className="btn-secondary col-span-full" disabled={!price.product_id || !price.unit_price.trim()}>{t("purchasing.supplier.price_register")}</button>
            </form>
          )}
          {prices.data.prices.map((p) => (
            <div key={p.id} className="flex justify-between text-xs font-bold">
              <span>{localName(p.product, locale)} · {p.uomCode}</span>
              <span dir="ltr">{p.unitPrice} · {p.validFrom} · {p.createdBy}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
