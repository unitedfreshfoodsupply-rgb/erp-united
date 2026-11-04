"use client";

import { unitLabel } from "@/lib/format";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { DataTable, FilterBar, useListQuery, useListState, type Column } from "@/components/ui/DataTable";
import { href as profileHref } from "@/lib/profiles/links";
import { PartyLink } from "@/components/profiles/EntityLink";

/**
 * Purchasing: suppliers and what they charge, requests for quotation, purchase orders
 * and their approval, and (for finance) supplier bills. Prices appear only for those
 * allowed to see them — the server leaves them out otherwise.
 */

type Tab = "orders" | "replenishment" | "rfqs" | "suppliers" | "bills";
type Catalog = { products: { id: string; name: string; nameAr: string | null; unit: string; packagings: { uomCode: string }[] }[] };
type SupplierRow = { id: string; code: string; name: string; nameAr?: string | null; type: string; phone: string | null; city: string | null; paymentTermsDays: number; leadTimeDays: number | null; active: boolean; version: number; taxRegistrationNo: string | null; email: string | null; address: string | null; category: string | null };
const SUPPLIER_CATEGORIES = ["vegetable", "fruit"] as const;
const categoryLabel = (t: (key: string) => string, c: string | null) => t(c ? `purchasing.supplier.category.${c}` : "purchasing.supplier.category.unclassified");

function errorMsg(err: unknown): string {
  if (err instanceof ApiClientError && err.message) return err.message;
  // Never an empty toast: an unexpected failure still says something, in the UI language.
  const en = typeof document !== "undefined" && document.documentElement.lang === "en";
  return en ? "Something went wrong — please try again" : "حصل خطأ — حاول تاني";
}

export function PurchasingView() {
  const { can } = usePermissions();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("orders");
  const [poId, setPoId] = useState<string | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [billView, setBillView] = useState<"bills" | "payables" | undefined>(undefined);
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
    const tb = sp.get("tab");
    if (tb && (["orders", "replenishment", "rfqs", "suppliers", "bills"] as const).includes(tb as Tab)) setTab(tb as Tab);
    // Deep links: ?supplier=<id> (older links) goes to the supplier's profile, ?tab=bills&btab=payables the aging.
    if (sp.get("supplier")) { router.replace(profileHref.supplier(sp.get("supplier")!)); return; }
    if (sp.get("btab") === "payables") setBillView("payables");
  }, [router]);
  const tabs: { key: Tab; label: string }[] = [
    ...(can("purchasing.orders.view") ? [
      { key: "orders" as Tab, label: t("purchasing.orders") },
      ...(can("purchasing.rfq.manage") ? [{ key: "replenishment" as Tab, label: t("purchasing.replenishment.tab") }] : []),
    ] : []),
    ...(can("purchasing.rfq.manage") ? [{ key: "rfqs" as Tab, label: t("purchasing.rfqs") }] : []),
    ...(can("purchasing.suppliers.view") ? [{ key: "suppliers" as Tab, label: t("purchasing.suppliers") }] : []),
    ...(can("purchasing.bills.view") ? [{ key: "bills" as Tab, label: t("purchasing.bills") }] : []),
  ];
  // The module opens for any one of its tabs: show the first the viewer has when theirs is not one.
  const current: Tab = tabs.some((x) => x.key === tab) ? tab : tabs[0]?.key ?? tab;
  return (
    <div className="page-container">
      <h1 className="page-title">{t("purchasing.title")}</h1>
      <Tabs value={current} onChange={(tVal) => { setTab(tVal); setPoId(null); setBillId(null); }} items={tabs} />
      {poId ? (
        <PoDetail id={poId} onClose={() => setPoId(null)} locale={locale} t={t} poStatus={PO_STATUS} />
      ) : current === "orders" ? (
        <Orders onOpen={setPoId} locale={locale} t={t} poStatus={PO_STATUS} />
      ) : current === "replenishment" ? (
        <Replenishment onCreateRfq={(lines) => { setRfqSeed(lines); setTab("rfqs"); }} locale={locale} t={t} />
      ) : current === "rfqs" ? (
        <Rfqs onOpenPo={setPoId} seedLines={rfqSeed ?? undefined} onSeedUsed={() => setRfqSeed(null)} locale={locale} t={t} />
      ) : current === "bills" ? (
        <BillsView key={`${billId ?? "list"}-${billView ?? ""}`} initialBillId={billId} initialView={billView} />
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
  // Search (maturity 2026-11): PO number or supplier (code, either language).
  const search = useListState([], { prefix: "po_" });
  const params = new URLSearchParams({ ...(status === "open" ? { open: "1" } : status ? { status } : {}), ...(search.q ? { q: search.q } : {}) });
  const q = useQuery({ queryKey: ["purchasing", "orders", status, search.q], queryFn: () => apiFetch<{ orders: Po[] }>(`/api/purchasing/orders?${params}`) });
  if (creating) return <NewPo onDone={(id) => { setCreating(false); if (id) onOpen(id); }} locale={locale} t={t} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <div className="min-w-0 flex-1"><Segmented value={status} onChange={setStatus} items={[
          { key: "open", label: t("purchasing.orders.filter.open") },
          { key: "draft", label: t("purchasing.orders.filter.drafts") },
          { key: "pending_approval", label: t("purchasing.orders.filter.pending_approval") },
          { key: "", label: t("purchasing.orders.filter.all") },
        ]} /></div>
        {can("purchasing.orders.manage") && <button type="button" className="btn-primary shrink-0" onClick={() => setCreating(true)}>{t("purchasing.orders.btn.new")}</button>}
      </div>
      {q.isLoading && <LoadingState />}
      <FilterBar list={search} searchLabel={t("purchasing.search.orders")} searchHint={t("purchasing.search.orders-hint")} />
      {q.isError && <ErrorState message={t("sales.invoice.error-generic")} onRetry={() => q.refetch()} />}
      {q.data && q.data.orders.length === 0 && <EmptyState icon="🛒" title={search.q ? t("list.empty-filtered") : t("purchasing.orders.empty")} />}
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
            <Field label={t("purchasing.line.product.placeholder")} required className="col-span-2">
              <select className="field font-bold" value={l.product_id} onChange={(e) => set(i, { product_id: e.target.value, uom: "" })}>
                <option value="">{t("form.choose")}</option>
                {products.map((x) => <option key={x.id} value={x.id}>{localName(x, locale)}</option>)}
              </select>
            </Field>
            <Field label={t("purchasing.line.quantity.placeholder")} required><input className="field" inputMode="decimal" dir="ltr" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></Field>
            <Field label={t("purchasing.line.unit.default")}>
              <select className="field" value={l.uom} onChange={(e) => set(i, { uom: e.target.value })}>
                <option value="">{p?.unit ?? t("purchasing.line.unit.default")}</option>
                {(p?.packagings ?? []).map((x) => <option key={x.uomCode} value={x.uomCode}>{x.uomCode}</option>)}
              </select>
            </Field>
            {withPrice && <Field label={t("purchasing.line.price.placeholder")}><input className="field" inputMode="decimal" dir="ltr" value={l.unit_price} onChange={(e) => set(i, { unit_price: e.target.value })} /></Field>}
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
      <Field label={t("purchasing.new_po.notes.placeholder")}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
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
          <p className="text-sm font-bold text-united-muted"><PartyLink kind="supplier" id={po.supplier.id} name={localName(po.supplier, locale)} /> · {po.orderDate}{po.expectedDate ? ` · ${t("purchasing.po_detail.expected")} ${po.expectedDate}` : ""}</p>
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
        <section className="card p-4 flex flex-wrap items-end gap-2">
          {po.status === "draft" && <button type="button" className="btn-primary" onClick={() => act("submit")}>{t("purchasing.po_detail.submit_btn")}</button>}
          {po.status === "approved" && <button type="button" className="btn-primary" onClick={() => act("send")}>{t("purchasing.po_detail.send_to_supplier")}</button>}
          <Field label={t("purchasing.po_detail.reason_placeholder")} className="flex-1"><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
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
                <span className="font-extrabold">{t("purchasing.replenishment.order_qty")} {fmtQty(s.suggestedQty, s.unit)}</span>
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
          <Field label={t("purchasing.rfq.quote_supplier")} required>
            <select className="field font-bold" value={quote.supplier} onChange={(e) => setQuote({ supplier: e.target.value, prices: {} })}>
              <option value="">{t("form.choose")}</option>
              {r.invited.map((i) => <option key={i.supplier.id} value={i.supplier.id}>{localName(i.supplier, locale)}</option>)}
            </select>
          </Field>
          {quote.supplier && r.comparison.map((c) => (
            <div key={c.line.id} className="flex items-center gap-2 text-sm font-bold">
              <span className="flex-1">{localName(c.line.product, locale)} ({c.line.uomCode})</span>
              <input className="field w-32" inputMode="decimal" dir="ltr" placeholder={t("purchasing.rfq.quote_price")} aria-label={`${t("purchasing.rfq.quote_price")} — ${localName(c.line.product, locale)}`} value={quote.prices[c.line.id] ?? ""} onChange={(e) => setQuote({ ...quote, prices: { ...quote.prices, [c.line.id]: e.target.value } })} />
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
  const router = useRouter();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", name_ar: "", type: "farm", category: "", payment_terms_days: "0", tax_registration_no: "" });
  // The shared list experience (maturity 2026-11): server search on either name, code, phone
  // and tax number; type and status filters in the URL; a sortable table.
  const list = useListState(["type", "category", "status"], { prefix: "s_" });
  const params = new URLSearchParams();
  if (list.q) params.set("q", list.q);
  if (list.filters.type) params.set("type", list.filters.type);
  if (list.filters.category) params.set("category", list.filters.category);
  if (list.filters.status === "all" || list.filters.status === "inactive") params.set("include_inactive", "1");
  const query = useListQuery<{ suppliers: SupplierRow[] }>(["purchasing", "suppliers", "directory"], `/api/purchasing/suppliers?${params}`);
  const rows = (query.data?.suppliers ?? []).filter((s) => list.filters.status !== "inactive" || !s.active);
  // Active suppliers still waiting for a category (added at the stock gate): always in view.
  const unclassified = useQuery({ queryKey: ["purchasing", "suppliers", "unclassified"], queryFn: () => apiFetch<{ suppliers: SupplierRow[] }>("/api/purchasing/suppliers?category=none") });
  const columns: Column<SupplierRow>[] = [
    { key: "name", label: t("purchasing.col.supplier"), sortValue: (s) => localName(s, locale), render: (s) => <span className={s.active ? "" : "text-united-muted line-through"}>{localName(s, locale)}</span> },
    { key: "code", label: t("sales.col.code"), sortValue: (s) => s.code, render: (s) => <span dir="ltr" className="whitespace-nowrap text-united-muted">{s.code}</span> },
    { key: "type", label: t("purchasing.col.supplier-type"), sortValue: (s) => sup_type[s.type] ?? s.type, render: (s) => sup_type[s.type] ?? s.type, secondary: true },
    { key: "category", label: t("purchasing.supplier.category"), sortValue: (s) => s.category ?? "~", render: (s) => (s.category ? categoryLabel(t, s.category) : <span className="text-united-muted">{categoryLabel(t, null)}</span>) },
    { key: "phone", label: t("sales.col.phone"), render: (s) => <span dir="ltr">{s.phone ?? "—"}</span>, secondary: true },
    { key: "city", label: t("sales.col.area"), sortValue: (s) => s.city ?? "", render: (s) => s.city ?? "—", secondary: true },
    { key: "terms", label: t("sales.col.terms"), sortValue: (s) => s.paymentTermsDays, render: (s) => (s.paymentTermsDays ? t("purchasing.supplier.term_due").replace("%s", String(s.paymentTermsDays)) : t("purchasing.supplier.cash")) },
    { key: "lead", label: t("purchasing.col.lead-time"), numeric: true, sortValue: (s) => s.leadTimeDays ?? -1, render: (s) => (s.leadTimeDays != null ? String(s.leadTimeDays) : "—"), secondary: true },
    { key: "status", label: t("list.status"), render: (s) => (s.active ? null : <span className="pill-neutral">{t("sales.label.inactive")}</span>) },
  ];
  return (
    <div className="flex flex-col gap-3">
      {can("purchasing.suppliers.manage") && (
        <form className="card p-3 grid grid-cols-2 sm:grid-cols-6 items-end gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await apiPost("/api/purchasing/suppliers", { name: form.name, name_ar: form.name_ar || null, type: form.type, category: form.category || null, payment_terms_days: Number(form.payment_terms_days || 0), tax_registration_no: form.tax_registration_no || undefined });
            setForm({ name: "", name_ar: "", type: "farm", category: "", payment_terms_days: "0", tax_registration_no: "" });
            void qc.invalidateQueries({ queryKey: ["purchasing", "suppliers"] });
          } catch (err) { toast.show(errorMsg(err), "error"); }
        }}>
          <Field label={t("purchasing.supplier.form.name")} required className="col-span-2"><input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t("purchasing.supplier.form.name_ar")} className="col-span-2"><input className="field" dir="rtl" lang="ar" value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })} /></Field>
          <Field label={t("purchasing.col.supplier-type")}>
            <select className="field" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {Object.entries(sup_type).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label={t("purchasing.supplier.category")} required>
            <select className="field" required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="" disabled>{t("purchasing.supplier.category.choose")}</option>
              {SUPPLIER_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(t, c)}</option>)}
            </select>
          </Field>
          <Field label={t("purchasing.supplier.form.payment_terms")}><input className="field" inputMode="numeric" dir="ltr" value={form.payment_terms_days} onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value })} /></Field>
          <button className="btn-secondary" disabled={!form.name.trim() || !form.category}>{t("purchasing.supplier.form.add_btn")}</button>
        </form>
      )}
      {(unclassified.data?.suppliers.length ?? 0) > 0 && list.filters.category !== "none" && (
        <div className="card p-3 flex flex-wrap items-center justify-between gap-2 bg-united-warn/10 text-sm font-bold" role="status">
          <span>{t("purchasing.supplier.unclassified-banner").replace("%s", String(unclassified.data!.suppliers.length))}</span>
          <button type="button" className="btn-secondary" onClick={() => list.set({ category: "none" })}>{t("purchasing.supplier.unclassified-show")}</button>
        </div>
      )}
      <FilterBar
        list={list}
        searchLabel={t("purchasing.search.suppliers")}
        searchHint={t("purchasing.search.suppliers-hint")}
        filters={[
          { key: "type", label: t("purchasing.col.supplier-type"), kind: "select", options: Object.entries(sup_type).map(([value, label]) => ({ value, label })) },
          { key: "category", label: t("purchasing.supplier.category"), kind: "select", options: [...SUPPLIER_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(t, c) })), { value: "none", label: categoryLabel(t, null) }] },
          { key: "status", label: t("list.status"), kind: "select", options: [{ value: "all", label: t("sales.filter.with-inactive") }, { value: "inactive", label: t("sales.label.inactive") }] },
        ]}
      />
      <DataTable
        rows={query.data ? rows : undefined}
        columns={columns}
        rowKey={(s) => s.id}
        onRowOpen={(s) => router.push(profileHref.supplier(s.id))}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => query.refetch()}
        empty={{ title: list.active ? t("list.empty-filtered") : t("purchasing.empty.suppliers") }}
        caption={t("purchasing.search.suppliers")}
      />
    </div>
  );
}

type SupplierContact = { id: string; name: string; role: string | null; phone: string | null; email: string | null; isPrimary: boolean; active: boolean; version: number };
type SupplierFull = SupplierRow & { commercialRegNo: string | null; notes: string | null; currencyCode: string; contacts: SupplierContact[]; _count: { intakes: number } };

/** The supplier's own record (the profile's overview): who they are, their terms, whom to call, and agreed prices. */
export function SupplierOverview({ id }: { id: string }) {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["purchasing", "supplier", id], queryFn: () => apiFetch<{ supplier: SupplierFull }>(`/api/purchasing/suppliers/${id}`) });
  const prices = useQuery({ queryKey: ["purchasing", "supplier", id, "prices"], queryFn: () => apiFetch<{ prices: { id: string; uomCode: string; unitPrice: string; validFrom: string; createdBy: string; product: { id?: string; name: string; nameAr: string | null } }[] }>(`/api/purchasing/suppliers/${id}/prices`), enabled: can("purchasing.prices.view") });
  const catalog = useCatalog();
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState({ product_id: "", unit_price: "", valid_from: todayLocalISO() });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMsg(q.error)} onRetry={() => q.refetch()} />;
  const s = q.data.supplier;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["purchasing"] });
  const manage = can("purchasing.suppliers.manage");
  // One editor for the whole record; the stock permission reaches its identity fields only.
  const editable = manage || can("stock.manage_suppliers");
  const typeLabel = ((k) => (t(k) === k ? s.type : t(k)))(`purchasing.supplier.type.${s.type}`);
  const facts: [string, React.ReactNode][] = [
    [t("purchasing.col.supplier-type"), typeLabel],
    [t("purchasing.supplier.category"), categoryLabel(t, s.category)],
    [t("sales.customer.nameAr"), otherLocalName(s, locale) || null],
    [t("sales.customer.tax"), s.taxRegistrationNo ? <span dir="ltr">{s.taxRegistrationNo}</span> : null],
    [t("sales.customer.commercial-reg"), s.commercialRegNo ? <span dir="ltr">{s.commercialRegNo}</span> : null],
    [t("sales.customer.phone"), s.phone ? <a dir="ltr" href={`tel:${s.phone}`} className="text-united-green">{s.phone}</a> : null],
    [t("sales.customer.email"), s.email ? <span dir="ltr">{s.email}</span> : null],
    [t("sales.customer.address"), [s.address, s.city].filter(Boolean).join(locale === "en" ? ", " : "، ") || null],
    [t("sales.col.terms"), s.paymentTermsDays ? t("purchasing.supplier.term_due").replace("%s", String(s.paymentTermsDays)) : t("purchasing.supplier.cash")],
    [t("purchasing.col.lead-time"), s.leadTimeDays != null ? t("purchasing.supplier.detail.delivery_in").replace("%s", String(s.leadTimeDays)) : t("purchasing.supplier.detail.not_logged")],
    [t("profile.currency"), <span key="c" dir="ltr">{s.currencyCode}</span>],
    [t("list.status"), s.active ? t("sales.col.active") : t("sales.label.inactive")],
    [t("profile.notes"), s.notes],
  ];
  return (
    <div className="flex flex-col gap-3">
      <section className="card p-4 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <h3 className="font-extrabold">{t("sales.section.data")}</h3>
          {editable && <button type="button" className="text-sm font-extrabold text-united-green underline" onClick={() => setEditing(!editing)}>{editing ? t("ui.cancel") : t("ui.edit")}</button>}
        </div>
        {!s.category && <p className="text-sm font-bold text-united-warn" role="status">{t("purchasing.supplier.unclassified-callout")}</p>}
        {editing ? (
          <SupplierMasterForm s={s} full={manage} onSaved={() => { setEditing(false); refresh(); }} />
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            {facts.map(([k, v]) => <div key={k}><dt className="text-xs font-extrabold text-united-muted">{k}</dt><dd className="font-bold">{v || "—"}</dd></div>)}
          </dl>
        )}
      </section>
      <SupplierContacts supplierId={id} contacts={s.contacts} canEdit={manage} onSaved={refresh} />
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
                {(catalog.data?.products ?? []).map((p) => <option key={p.id} value={p.id}>{localName(p, locale)} ({unitLabel(p.unit)})</option>)}
              </select>
              <Field label={t("purchasing.rfq.quote_price")}><input className="field" dir="ltr" inputMode="decimal" value={price.unit_price} onChange={(e) => setPrice({ ...price, unit_price: e.target.value })} /></Field>
              <input className="field" type="date" value={price.valid_from} onChange={(e) => setPrice({ ...price, valid_from: e.target.value })} aria-label={t("purchasing.supplier.price_valid_from")} />
              <button type="submit" className="btn-secondary col-span-full" disabled={!price.product_id || !price.unit_price.trim()}>{t("purchasing.supplier.price_register")}</button>
            </form>
          )}
          {prices.data.prices.length === 0 && <p className="text-sm font-bold text-united-muted">—</p>}
          {prices.data.prices.map((p) => (
            <div key={p.id} className="flex justify-between gap-2 text-xs font-bold">
              <span>{localName(p.product, locale)} · {p.uomCode}</span>
              <span dir="ltr">{p.unitPrice} · {p.validFrom} · {p.createdBy}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * The supplier's single editor (Nov 2026): every master field in one form, saved through one
 * versioned, field-audited service. Without purchasing.suppliers.manage only the identity fields
 * (name, phone, notes, active) are editable and only those are sent; the server checks the same rule.
 */
function SupplierMasterForm({ s, full, onSaved }: { s: SupplierFull; full: boolean; onSaved: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [f, setF] = useState({
    name: s.name, name_ar: s.nameAr ?? "", phone: s.phone ?? "", notes: s.notes ?? "", active: s.active,
    type: s.type, category: s.category ?? "", tax_registration_no: s.taxRegistrationNo ?? "", commercial_reg_no: s.commercialRegNo ?? "", email: s.email ?? "",
    city: s.city ?? "", address: s.address ?? "", payment_terms_days: String(s.paymentTermsDays), lead_time_days: s.leadTimeDays == null ? "" : String(s.leadTimeDays),
  });
  const [busy, setBusy] = useState(false);
  type TextKey = "name" | "name_ar" | "phone" | "tax_registration_no" | "commercial_reg_no" | "email" | "city" | "address" | "payment_terms_days" | "lead_time_days";
  const identity: [TextKey, string, string?][] = [["name", "purchasing.supplier.form.name", "auto"], ["name_ar", "purchasing.supplier.form.name_ar", "rtl"], ["phone", "sales.customer.phone", "ltr"]];
  const commercial: [TextKey, string, string?][] = [["tax_registration_no", "sales.customer.tax", "ltr"], ["commercial_reg_no", "sales.customer.commercial-reg", "ltr"], ["email", "sales.customer.email", "ltr"], ["city", "sales.customer.city"], ["address", "sales.customer.address"], ["payment_terms_days", "sales.credit-terms-field", "ltr"], ["lead_time_days", "purchasing.col.lead-time", "ltr"]];
  const input = ([k, label, dir]: [TextKey, string, string?]) => {
    // The Arabic name is a commercial field on the server (purchasing's), like the rest below.
    const enabled = full || k === "name" || k === "phone";
    return <Field key={k} label={t(label)}><input className="field" dir={dir} lang={k === "name_ar" ? "ar" : undefined} inputMode={k.endsWith("_days") ? "numeric" : undefined} value={f[k]} disabled={!enabled} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  };
  return (
    <form className="grid grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        const body: Record<string, unknown> = { name: f.name.trim(), phone: f.phone.trim() || null, notes: f.notes.trim() || null, active: f.active, expected_version: s.version };
        if (full) Object.assign(body, {
          name_ar: f.name_ar.trim() || null, type: f.type, ...(f.category ? { category: f.category } : {}), tax_registration_no: f.tax_registration_no.trim() || null, commercial_reg_no: f.commercial_reg_no.trim() || null,
          email: f.email.trim() || null, city: f.city.trim() || null, address: f.address.trim() || null, payment_terms_days: Number(f.payment_terms_days || 0), lead_time_days: f.lead_time_days.trim() === "" ? null : Number(f.lead_time_days),
        });
        await apiPatch(`/api/purchasing/suppliers/${s.id}`, body);
        toast.show(t("sales.toast.saved"), "success");
        onSaved();
      } catch (err) { toast.show(errorMsg(err), "error"); }
      finally { setBusy(false); }
    }}>
      {identity.map(input)}
      <Field label={t("purchasing.col.supplier-type")}>
        <select className="field" value={f.type} disabled={!full} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {["farm", "grower", "wholesaler", "market_trader", "importer", "packaging", "services", "other"].map((k) => <option key={k} value={k}>{t(`purchasing.supplier.type.${k}`)}</option>)}
        </select>
      </Field>
      <Field label={t("purchasing.supplier.category")}>
        <select className="field" value={f.category} disabled={!full} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {/* Unclassified is shown only while it is the current state; it cannot be chosen again. */}
          {!s.category && <option value="" disabled>{categoryLabel(t, null)}</option>}
          {SUPPLIER_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(t, c)}</option>)}
        </select>
      </Field>
      {commercial.map(input)}
      <Field label={t("profile.notes")} className="sm:col-span-2"><textarea className="field" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-sm font-bold sm:col-span-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t("sales.col.active")}</label>
      {!full && <p className="text-xs font-bold text-united-muted sm:col-span-2">{t("purchasing.supplier.edit.purchasing-only")}</p>}
      <button className="btn-primary sm:col-span-2" disabled={busy || !f.name.trim()}>{busy ? t("sales.form.saving") : t("ui.save")}</button>
    </form>
  );
}

function SupplierContacts({ supplierId, contacts, canEdit, onSaved }: { supplierId: string; contacts: SupplierContact[]; canEdit: boolean; onSaved: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const empty = { name: "", role: "", phone: "", email: "", primary: false };
  const [f, setF] = useState(empty);
  const [edit, setEdit] = useState<SupplierContact | null>(null);
  const save = async (body: Record<string, unknown>, contactId?: string) => {
    try {
      if (contactId) await apiPatch(`/api/purchasing/suppliers/${supplierId}/contacts/${contactId}`, body);
      else await apiPost(`/api/purchasing/suppliers/${supplierId}/contacts`, body);
      setF(empty); setEdit(null); onSaved();
    } catch (err) { toast.show(errorMsg(err), "error"); }
  };
  const shown = contacts.filter((c) => c.active || canEdit);
  return (
    <section className="card p-4 flex flex-col gap-2">
      <h3 className="font-extrabold">{t("contacts-heading")}</h3>
      {shown.length === 0 && <p className="text-sm font-bold text-united-muted">—</p>}
      {shown.map((c) => (
        <div key={c.id} className={`flex flex-wrap justify-between gap-2 text-sm font-bold border-b border-united-dark/5 py-1 ${c.active ? "" : "text-united-muted line-through"}`}>
          <span>{c.name}{c.role ? ` · ${c.role}` : ""}{c.isPrimary && <span className="ms-1 pill-success">{t("label-primary")}</span>}</span>
          <span className="flex items-center gap-3">
            {c.phone && <a dir="ltr" href={`tel:${c.phone}`} className="text-united-green">{c.phone}</a>}
            {c.email && <span dir="ltr" className="text-united-muted">{c.email}</span>}
            {canEdit && <button type="button" className="text-xs font-extrabold text-united-green underline" onClick={() => { setEdit(c); setF({ name: c.name, role: c.role ?? "", phone: c.phone ?? "", email: c.email ?? "", primary: c.isPrimary }); }}>{t("ui.edit")}</button>}
            {canEdit && <button type="button" className="text-xs font-extrabold text-united-muted underline" onClick={() => save({ name: c.name, role: c.role, phone: c.phone, email: c.email, is_primary: c.isPrimary, active: !c.active, expected_version: c.version }, c.id)}>{c.active ? t("profile.contact.deactivate") : t("profile.contact.activate")}</button>}
          </span>
        </div>
      ))}
      {canEdit && (
        <form className="grid grid-cols-1 sm:grid-cols-2 gap-2" onSubmit={(e) => {
          e.preventDefault();
          const body = { name: f.name, role: f.role || null, phone: f.phone || null, email: f.email || null, is_primary: f.primary };
          void save(edit ? { ...body, active: edit.active, expected_version: edit.version } : body, edit?.id);
        }}>
          <Field label={t("placeholder-contact-name")}><input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t("placeholder-contact-role")}><input className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
          <Field label={t("placeholder-contact-phone")}><input className="field" dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={t("sales.customer.email")}><input className="field" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <label className="tap-target flex items-center gap-2 font-bold"><input type="checkbox" className="w-6 h-6" checked={f.primary} onChange={(e) => setF({ ...f, primary: e.target.checked })} />{t("label-primary")}</label>
          <div className="flex gap-2 sm:col-span-2">
            <button className="btn-secondary" disabled={!f.name.trim()}>{edit ? t("ui.save") : t("button-add-contact")}</button>
            {edit && <button type="button" className="btn-secondary" onClick={() => { setEdit(null); setF(empty); }}>{t("ui.cancel")}</button>}
          </div>
        </form>
      )}
    </section>
  );
}
