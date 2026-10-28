"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { invalidateStockData } from "@/lib/stockInvalidation";
import { Field, Tabs, fmtMoney, fmtQty, locationTypeLabel, useLocations, type StockRow } from "./shared";
import { Segmented } from "@/components/ui/Segmented";
import { MoveForms } from "./MoveForms";
import { Pagination } from "@/components/ui/Pagination";
import { useLocale } from "@/lib/locale";
import { intlLocale } from "@/lib/format";
import { localName } from "@/lib/locale/names";

/**
 * The stock controller's screen: what is where, what is free to sell, what is about
 * to expire, what did not add up when an order left — and the forms that move stock.
 * Supervisors additionally see value. Everything shown is derived from the ledger on
 * the server; this screen never adds quantities itself.
 */

type Tab = "stock" | "move" | "expiring" | "exceptions" | "documents" | "valuation";

// Dictionary keys, translated at render with the active locale (resolving `.ar` here
// left these labels Arabic in English mode).
const KIND_LABEL: Record<string, string> = {
  intake: "stock.kind-intake", intake_correction: "stock.kind-intake-correction", intake_void: "stock.kind-intake-void", adjustment: "stock.kind-adjustment",
  transfer_out: "stock.kind-transfer-out", transfer_in: "stock.kind-transfer-in", issue: "stock.kind-issue", customer_return: "stock.kind-customer-return",
  supplier_return: "stock.kind-supplier-return", scrap: "stock.kind-scrap",
};

const EXCEPTION_REASON: Record<ExceptionDTO["reason"], string> = {
  unmapped: "stock.exception-unmapped",
  unit_mismatch: "stock.exception-unit-mismatch",
  insufficient: "stock.exception-insufficient",
};

export function InventoryView() {
  const { can, isLoading } = usePermissions();
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("stock");
  const [productId, setProductId] = useState<string | null>(null);

  // Deep links: /stock/inventory?tab=exceptions, ?doc=<id> (from the approvals inbox).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t2 = sp.get("tab") as Tab | null;
    if (t2) setTab(t2);
    if (sp.get("doc")) setTab("documents");
    if (sp.get("product")) setProductId(sp.get("product"));
  }, []);

  const exceptions = useQuery({
    queryKey: ["stock", "inventory", "exceptions", "open"],
    queryFn: () => apiFetch<{ exceptions: ExceptionDTO[] }>("/api/inventory/exceptions"),
    refetchInterval: 30_000,
  });

  if (isLoading) return <LoadingState />;
  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "stock", label: t("stock.tab.stock") },
    { key: "move", label: t("stock.tab.move") },
    { key: "expiring", label: t("stock.tab.expiring") },
    { key: "exceptions", label: t("stock.tab.exceptions"), badge: exceptions.data?.exceptions.length },
    { key: "documents", label: t("stock.tab.documents") },
    ...(can("stock.valuation.view") ? [{ key: "valuation" as Tab, label: t("stock.tab.valuation") }] : []),
  ];

  return (
    <div className="page-container">
      <h1 className="page-title">{t("stock.inventory")}</h1>
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {productId ? (
        <ProductPanel productId={productId} onClose={() => setProductId(null)} />
      ) : (
        <>
          {tab === "stock" && <StockList onOpen={setProductId} />}
          {tab === "move" && <MoveForms />}
          {tab === "expiring" && <Expiring onOpen={setProductId} />}
          {tab === "exceptions" && <Exceptions />}
          {tab === "documents" && <Documents />}
          {tab === "valuation" && <Valuation />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function StockList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, locale } = useLocale();
  const [filter, setFilter] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const q = useQuery({
    queryKey: ["stock", "inventory", "stock"],
    queryFn: () => apiFetch<{ warehouse: { code: string; name: string; nameAr?: string | null; nameEn?: string | null }; rows: StockRow[] }>("/api/inventory/stock"),
    refetchInterval: 20_000,
  });
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data?.rows ?? []).filter((r) => (!onlyLow || r.belowReorder) && (!f || r.productName.toLowerCase().includes(f) || (r.productNameAr ?? "").includes(f)));
  }, [q.data, filter, onlyLow]);
  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const showValue = rows.some((r) => r.stockValue !== null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input className="field" type="search" aria-label={t("stock.search-placeholder")} placeholder={t("stock.search-placeholder")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" onClick={() => setOnlyLow(!onlyLow)} aria-pressed={onlyLow} className="chip chip-warn">
          {t("stock.low-stock-btn")}
        </button>
      </div>
      <p className="text-xs text-united-muted">{q.data ? localName(q.data.warehouse, locale) : ""} · {t("stock.warehouse-available-desc")}</p>
      {rows.length === 0 && <EmptyState icon="📦" title={t("stock.empty-products")} />}
      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <li key={r.productId}>
            <button type="button" onClick={() => onOpen(r.productId)} className="card p-4 w-full text-start flex flex-col gap-2 active:scale-[0.99] transition">
              <div className="flex items-center justify-between gap-2">
                <span className="font-extrabold text-united-dark">{localName({ name: r.productName, nameAr: r.productNameAr }, locale)}</span>
                {r.belowMin ? (
                  <span className="rounded-full bg-united-danger/10 text-united-danger px-2 text-xs font-extrabold">{t("stock.badge-below-min")}</span>
                ) : r.belowReorder ? (
                  <span className="rounded-full bg-united-warn/10 text-united-warn px-2 text-xs font-extrabold">{t("stock.badge-reorder")}</span>
                ) : null}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat label={t("stock.stat.on-hand")} value={fmtQty(r.onHand)} />
                <Stat label={t("stock.stat.reserved")} value={fmtQty(r.reserved)} />
                <Stat label={t("stock.stat.available")} value={fmtQty(r.available)} strong />
              </div>
              <div className="flex justify-between text-xs font-bold text-united-muted">
                <span>{r.unit}</span>
                {showValue && <span dir="ltr">{fmtMoney(r.stockValue)}</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-xl px-2 py-2 ${strong ? "bg-united-green/10" : "bg-united-dark/[0.03]"}`}>
      <div className="text-[11px] font-extrabold text-united-muted">{label}</div>
      <div dir="ltr" className={`font-extrabold ${strong ? "text-united-green text-lg" : "text-united-dark"}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type Bucket = { locationId: string; locationCode: string; locationType: string; lotId: string | null; lotNumber: string | null; receivedDate: string | null; expiryDate: string | null; quantity: string };
type ProductDetail = {
  product: {
    id: string; name: string; nameAr: string | null; unit: string; version: number;
    shelfLifeDays: number | null; removalStrategy: string; costingMethod: string; standardCost: string | null; coldChain: boolean;
    reorderPointQty: string | null; minStockQty: string | null; maxStockQty: string | null;
    packagings: { id: string; uomCode: string; qtyInBaseUnit: string; active: boolean; uom: { nameAr: string | null; name: string } }[];
  };
  onHand: string; quarantined: string; expired: string; sellableOnHand: string; reserved: string; available: string; today: string;
  buckets: Bucket[];
  reservations: { id: string; quantity: string; sourceType: string; sourceId: string; createdBy: string; createdAt: string }[];
  movements: { id: string; kind: string; quantity: string; occurredAt: string; actorName: string; unitCost: string | null; location: { code: string }; lot: { lotNumber: string } | null; document: { number: string } | null; intake: { receiptNumber: string } | null }[];
  valuation: { averageCost: string | null; value: string } | null;
};

function ProductPanel({ productId, onClose }: { productId: string; onClose: () => void }) {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const q = useQuery({
    queryKey: ["stock", "inventory", "product", productId],
    queryFn: () => apiFetch<ProductDetail>(`/api/inventory/products/${productId}`),
    refetchInterval: 20_000,
  });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const d = q.data;
  const u = d.product.unit;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-extrabold text-united-dark">{localName(d.product, locale)}</h2>
        <button type="button" className="btn-secondary" onClick={onClose}>{t("stock.btn-back")}</button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
        <Stat label={t("stock.stat.on-hand")} value={fmtQty(d.onHand, u)} />
        <Stat label={t("stock.stat.quarantined")} value={fmtQty(d.quarantined, u)} />
        <Stat label={t("stock.stat.expired")} value={fmtQty(d.expired, u)} />
        <Stat label={t("stock.stat.reserved")} value={fmtQty(d.reserved, u)} />
        <Stat label={t("stock.stat.available")} value={fmtQty(d.available, u)} strong />
      </div>
      {d.valuation && (
        <div className="card p-3 flex justify-between font-extrabold">
          <span>{t("stock.stat-value")}: <span dir="ltr">{fmtMoney(d.valuation.value)}</span></span>
          <span>{t("stock.stat-avg-cost")}: <span dir="ltr">{d.valuation.averageCost ?? "—"}</span></span>
        </div>
      )}

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold text-united-dark">{t("stock.heading-stock-location")} ({d.product.removalStrategy === "fefo" ? "FEFO" : "FIFO"})</h3>
        {d.buckets.length === 0 && <p className="text-sm font-bold text-united-muted">{t("stock.empty-balance")}</p>}
        <ul className="flex flex-col divide-y divide-united-dark/5">
          {d.buckets.map((b) => (
            <BucketRow key={`${b.locationId}:${b.lotId}`} b={b} unit={u} today={d.today} canEditLot={can("stock.sort")} productId={d.product.id} />
          ))}
        </ul>
      </section>

      {d.reservations.length > 0 && (
        <section className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold text-united-dark">{t("stock.heading-reservations")}</h3>
          {d.reservations.map((r) => (
            <ReservationRow key={r.id} r={r} unit={u} canRelease={can("stock.reserve")} />
          ))}
        </section>
      )}

      {can("stock.manage_products") && <ProductSettings d={d} />}

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold text-united-dark">{t("stock.heading-movements")}</h3>
        <ul className="flex flex-col divide-y divide-united-dark/5 text-sm">
          {d.movements.map((m) => (
            <li key={m.id} className="py-2 flex items-center justify-between gap-2">
              <div className="flex flex-col">
                <span className="font-extrabold">{KIND_LABEL[m.kind] ? t(KIND_LABEL[m.kind]) : m.kind} · {m.document?.number ?? m.intake?.receiptNumber ?? ""}</span>
                <span className="text-xs font-bold text-united-muted">{m.location.code}{m.lot ? ` · ${m.lot.lotNumber}` : ""} · {m.actorName} · {new Date(m.occurredAt).toLocaleString(intlLocale(locale), { dateStyle: "short", timeStyle: "short" })}</span>
              </div>
              <span dir="ltr" className={`font-extrabold ${Number(m.quantity) < 0 ? "text-united-danger" : "text-united-green"}`}>{Number(m.quantity) > 0 ? "+" : ""}{fmtQty(m.quantity)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function BucketRow({ b, unit, today, canEditLot, productId }: { b: Bucket; unit: string; today: string; canEditLot: boolean; productId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const [expiry, setExpiry] = useState(b.expiryDate ?? "");
  const [reason, setReason] = useState("");
  const expired = b.expiryDate && b.expiryDate < today;
  return (
    <li className="py-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-extrabold">
            {b.locationCode}{" "}
            <span className="text-xs text-united-muted">
              ({locationTypeLabel(b.locationType, locale)}
              {b.locationCode === "GRADE-B" ? ` · ${t("stock.exception-grade-b")}` : ""})
            </span>
          </span>
          <span className="text-xs font-bold text-united-muted">
            {b.lotNumber ?? t("stock.exception-pre-lot")}
            {b.expiryDate && <span className={expired ? "text-united-danger" : ""}> · {t("stock.lot-expiry-label")} {b.expiryDate}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span dir="ltr" className="font-extrabold">{fmtQty(b.quantity, unit)}</span>
          {canEditLot && b.lotId && (
            <button type="button" className="text-xs font-extrabold text-united-green underline" onClick={() => setEditing(!editing)}>{t("stock.lot-expiry-label")}</button>
          )}
          {b.locationType === "quarantine" && <ReleaseButton productId={productId} bucket={b} />}
        </div>
      </div>
      {editing && b.lotId && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await apiPatch(`/api/inventory/lots/${b.lotId}`, { expiry_date: expiry || null, reason });
              invalidateStockData(qc);
              toast.show(t("stock.toast-expiry-updated"), "success");
              setEditing(false);
            } catch (err) {
              toast.show(err instanceof ApiClientError ? err.message : t("stock.toast-error"), "error");
            }
          }}
        >
          <input type="date" className="field flex-1" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          <input className="field flex-[2]" placeholder={t("stock.form-required-reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn-primary">{t("stock.form-lot-expiry-save")}</button>
        </form>
      )}
    </li>
  );
}

function ReservationRow({ r, unit, canRelease }: { r: ProductDetail["reservations"][number]; unit: string; canRelease: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-b border-united-dark/5 pb-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-bold">{r.sourceType === "order" ? t("stock.exception-ordered") : t("stock.form-release")} · {r.createdBy}</span>
        <span className="flex items-center gap-2">
          <span dir="ltr" className="font-extrabold">{fmtQty(r.quantity, unit)}</span>
          {canRelease && <button type="button" className="text-xs font-extrabold text-united-danger underline" onClick={() => setOpen(!open)}>{t("stock.form-release")}</button>}
        </span>
      </div>
      {open && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await apiPost(`/api/inventory/reservations/${r.id}/release`, { reason });
              invalidateStockData(qc);
              toast.show(t("stock.toast-reservation-released"), "success");
            } catch (err) {
              toast.show(err instanceof ApiClientError ? err.message : t("stock.toast-error"), "error");
            }
          }}
        >
          <input className="field" placeholder={t("stock.form-required-reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn-danger">{t("stock.form-release")}</button>
        </form>
      )}
    </div>
  );
}

function ProductSettings({ d }: { d: ProductDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const { uoms } = useLocations();
  const p = d.product;
  const [form, setForm] = useState({
    shelf_life_days: p.shelfLifeDays?.toString() ?? "",
    removal_strategy: p.removalStrategy,
    reorder_point_qty: p.reorderPointQty ?? "",
    min_stock_qty: p.minStockQty ?? "",
    max_stock_qty: p.maxStockQty ?? "",
    cold_chain: p.coldChain,
  });
  const [pack, setPack] = useState({ uom: "", qty: "" });
  const set = (k: keyof typeof form, v: string | boolean) => setForm({ ...form, [k]: v });
  const blankToNull = (v: string) => (v.trim() === "" ? null : v.trim());
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiPatch(`/api/inventory/products/${p.id}/settings`, {
        shelf_life_days: form.shelf_life_days.trim() === "" ? null : Number(form.shelf_life_days),
        removal_strategy: form.removal_strategy,
        reorder_point_qty: blankToNull(form.reorder_point_qty),
        min_stock_qty: blankToNull(form.min_stock_qty),
        max_stock_qty: blankToNull(form.max_stock_qty),
        cold_chain: form.cold_chain,
        expected_version: p.version,
      });
      invalidateStockData(qc);
      toast.show(t("stock.toast-settings-saved"), "success");
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("stock.toast-error"), "error");
    }
  }
  async function addPack(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiPost(`/api/inventory/products/${p.id}/packagings`, { uom: pack.uom, qty_in_base_unit: pack.qty });
      invalidateStockData(qc);
      toast.show(t("stock.toast-packaging-saved"), "success");
      setPack({ uom: "", qty: "" });
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("stock.toast-error"), "error");
    }
  }
  return (
    <section className="card p-4 flex flex-col gap-3">
      <h3 className="font-extrabold text-united-dark">{t("stock.heading-product-settings")}</h3>
      <form onSubmit={save} className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Field label={t("stock.shelf-life-field")}><input className="field" inputMode="numeric" dir="ltr" value={form.shelf_life_days} onChange={(e) => set("shelf_life_days", e.target.value)} /></Field>
        <Field label={t("stock.removal-order-field")}>
          <select className="field font-bold" value={form.removal_strategy} onChange={(e) => set("removal_strategy", e.target.value)}>
            <option value="fefo">{t("stock.fefo-option")}</option>
            <option value="fifo">{t("stock.fifo-option")}</option>
          </select>
        </Field>
        <Field label={t("stock.reorder-point-field")}><input className="field" inputMode="decimal" dir="ltr" value={form.reorder_point_qty} onChange={(e) => set("reorder_point_qty", e.target.value)} /></Field>
        <Field label={t("stock.min-stock-field")}><input className="field" inputMode="decimal" dir="ltr" value={form.min_stock_qty} onChange={(e) => set("min_stock_qty", e.target.value)} /></Field>
        <Field label={t("stock.max-stock-field")}><input className="field" inputMode="decimal" dir="ltr" value={form.max_stock_qty} onChange={(e) => set("max_stock_qty", e.target.value)} /></Field>
        <label className="tap-target flex items-center gap-2 font-extrabold">
          <input type="checkbox" className="w-6 h-6" checked={form.cold_chain} onChange={(e) => set("cold_chain", e.target.checked)} />
          {t("stock.cold-chain-label")}
        </label>
        <button className="btn-primary col-span-full">{t("stock.form-lot-expiry-save")}</button>
      </form>
      <h4 className="font-extrabold text-united-dark text-sm">{t("stock.packaging-heading-units", { unit: p.unit })}</h4>
      <ul className="flex flex-wrap gap-2">
        {p.packagings.map((x) => (
          <li key={x.id} className="rounded-xl bg-united-dark/5 px-3 py-2 text-sm font-extrabold" dir="ltr">
            1 {x.uomCode} = {fmtQty(x.qtyInBaseUnit)} {p.unit}{x.active ? "" : ` (${t("stock.suspended")})`}
          </li>
        ))}
      </ul>
      <form onSubmit={addPack} className="flex gap-2">
        <select className="field font-bold" value={pack.uom} onChange={(e) => setPack({ ...pack, uom: e.target.value })}>
          <option value="">{t("stock.unit-choice")}</option>
          {uoms.filter((x) => x.code !== p.unit).map((x) => (
            <option key={x.code} value={x.code}>{localName(x, locale)} ({x.code})</option>
          ))}
        </select>
        <input className="field" inputMode="decimal" dir="ltr" placeholder={t("stock.packaging-qty-placeholder", { unit: p.unit })} value={pack.qty} onChange={(e) => setPack({ ...pack, qty: e.target.value })} />
        <button className="btn-secondary shrink-0">{t("stock.add-button")}</button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Expiring({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, locale } = useLocale();
  const [days, setDays] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["stock", "inventory", "expiring", days],
    queryFn: () =>
      apiFetch<{ today: string; until: string; rows: { lotId: string; lotNumber: string; expiryDate: string; expired: boolean; daysLeft: number; product: { id: string; name: string; nameAr: string | null; unit: string }; supplier: string | null; locationCode: string; quantity: string }[] }>(
        `/api/inventory/reports/expiring${days !== null ? `?days=${days}` : ""}`
      ),
    refetchInterval: 60_000,
  });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={String(days ?? "default")}
        onChange={(v) => setDays(v === "default" ? null : Number(v))}
        items={[{ key: "default", label: t("stock.tab.default") }, { key: "0", label: t("stock.tab.today") }, { key: "3", label: `3 ${t("stock.tab.days-days")}` }, { key: "7", label: t("stock.tab.week") }]}
      />
      {q.data.rows.length === 0 && <EmptyState icon="🍃" title={t("stock.expiring-nothing-until", { until: q.data.until })} />}
      <ul className="flex flex-col gap-2">
        {q.data.rows.map((r) => (
          <li key={`${r.lotId}:${r.locationCode}`}>
            <button type="button" onClick={() => onOpen(r.product.id)} className={`card p-3 w-full text-start flex items-center justify-between gap-2 ${r.expired ? "border-2 border-united-danger/40" : ""}`}>
              <div className="flex flex-col">
                <span className="font-extrabold">{localName(r.product, locale)}</span>
                <span className="text-xs font-bold text-united-muted">{r.lotNumber} · {r.locationCode}{r.supplier ? ` · ${r.supplier}` : ""}</span>
              </div>
              <div className="flex flex-col items-end">
                <span dir="ltr" className="font-extrabold">{fmtQty(r.quantity, r.product.unit)}</span>
                <span className={`text-xs font-extrabold ${r.expired ? "text-united-danger" : r.daysLeft <= 1 ? "text-united-warn" : "text-united-muted"}`}>
                  {r.expired ? `${t("stock.expired-since")} ${-r.daysLeft} ${t("stock.tab.days-days")}` : r.daysLeft === 0 ? t("stock.expiring-today") : `${t("stock.expiring-left")} ${r.daysLeft} ${t("stock.tab.days-days")}`}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

type ExceptionDTO = {
  id: string; orderId: string; productName: string; unit: string; requestedQty: string; issuedQty: string;
  reason: "unmapped" | "unit_mismatch" | "insufficient"; status: string; resolution: string | null; resolvedBy: string | null; version: number; createdAt: string;
  order: { orderNumber: string; customerName: string; deliveryDate: string };
  document: { number: string } | null;
};

function Exceptions() {
  const { can } = usePermissions();
  const { t } = useLocale();
  const [status, setStatus] = useState<"open" | "resolved" | "voided">("open");
  const q = useQuery({
    queryKey: ["stock", "inventory", "exceptions", status],
    queryFn: () => apiFetch<{ exceptions: ExceptionDTO[] }>(`/api/inventory/exceptions?status=${status}`),
    refetchInterval: 30_000,
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-bold text-united-muted">{t("stock.variance-explain")}</p>
      <Segmented value={status} onChange={setStatus} items={[{ key: "open", label: t("stock.variance-open") }, { key: "resolved", label: t("stock.variance-resolved") }, { key: "voided", label: t("stock.variance-voided") }]} />
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && q.data.exceptions.length === 0 && <EmptyState icon="✅" title={t("stock.empty-variance")} />}
      <ul className="flex flex-col gap-2">
        {q.data?.exceptions.map((x) => (
          <ExceptionCard key={x.id} x={x} canResolve={can("stock.adjust") && x.status === "open"} />
        ))}
      </ul>
    </div>
  );
}

function ExceptionCard({ x, canResolve }: { x: ExceptionDTO; canResolve: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const [text, setText] = useState("");
  return (
    <li className="card p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-extrabold">{x.productName}</span>
        <span className="text-xs font-bold text-united-muted">{t("stock.exception-ordered")} {x.order.orderNumber} · {x.order.customerName}</span>
      </div>
      <p className="text-sm font-bold text-united-warn">{EXCEPTION_REASON[x.reason] ? t(EXCEPTION_REASON[x.reason]) : x.reason}</p>
      <p className="text-sm font-bold" dir="rtl">
        exited <span dir="ltr">{fmtQty(x.requestedQty, x.unit)}</span> · {t("stock.exception-issued-from-books")} <span dir="ltr">{fmtQty(x.issuedQty, x.unit)}</span>
        {x.document ? ` · ${x.document.number}` : ""}
      </p>
      {x.resolution && <p className="text-sm text-united-muted font-bold">{t("stock.resolution-solution")}: {x.resolution} {x.resolvedBy ? `— ${x.resolvedBy}` : ""}</p>}
      {canResolve && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await apiPost(`/api/inventory/exceptions/${x.id}/resolve`, { resolution: text, expected_version: x.version });
              invalidateStockData(qc);
              toast.show(t("stock.toast-variance-closed"), "success");
            } catch (err) {
              toast.show(err instanceof ApiClientError ? err.message : t("stock.toast-error"), "error");
            }
          }}
        >
          <input className="field" placeholder={t("stock.form-how-solved")} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn-primary shrink-0">{t("stock.btn-close")}</button>
        </form>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

type DocumentDTO = {
  id: string; number: string; type: string; status: string; businessDate: string; reason: string | null; createdBy: string; reversalOfId: string | null;
  movements: { id: string; quantity: string; kind: string; location: { code: string }; lot: { lotNumber: string } | null; product: { name: string; unit: string } }[];
};

const DOC_TYPE_MAP: Record<string, string> = {
  transfer: "تحويل", adjustment: "تسوية", scrap: "هالك", customer_return: "مرتجع عميل", supplier_return: "مرتجع مورد", issue: "صرف",
};
const DOC_TYPE_MAP_EN: Record<string, string> = {
  transfer: "Transfer", adjustment: "Adjustment", scrap: "Scrap", customer_return: "Customer Return", supplier_return: "Supplier Return", issue: "Issue",
};

const DOC_STATUS_MAP: Record<string, { label: string; cls: string }> = {
  posted: { label: "متسجل", cls: "bg-united-green/10 text-united-green" },
  pending_approval: { label: "مستني موافقة", cls: "bg-united-warn/10 text-united-warn" },
  rejected: { label: "مرفوض", cls: "bg-united-danger/10 text-united-danger" },
  reversed: { label: "اتلغى", cls: "bg-united-dark/5 text-united-muted" },
};
const DOC_STATUS_MAP_EN: Record<string, { label: string; cls: string }> = {
  posted: { label: "Posted", cls: "bg-united-green/10 text-united-green" },
  pending_approval: { label: "Pending Approval", cls: "bg-united-warn/10 text-united-warn" },
  rejected: { label: "Rejected", cls: "bg-united-danger/10 text-united-danger" },
  reversed: { label: "Reversed", cls: "bg-united-dark/5 text-united-muted" },
};

function Documents() {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const [type, setType] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [dPage, setDPage] = useState(1);
  const dPageSize = 50;
  useEffect(() => setHighlight(new URLSearchParams(window.location.search).get("doc")), []);
  const onTypeChange = (t2: string) => { setType(t2); setDPage(1); };
  const dm = locale === "en" ? DOC_TYPE_MAP_EN : DOC_TYPE_MAP;
  const q = useQuery({
    queryKey: ["stock", "inventory", "documents", type, dPage],
    queryFn: () => apiFetch<{ documents: DocumentDTO[]; pagination: { total: number } }>(`/api/inventory/documents?limit=${dPageSize}&offset=${(dPage - 1) * dPageSize}${type ? `&type=${type}` : ""}`),
    refetchInterval: 30_000,
  });
  return (
    <div className="flex flex-col gap-3">
      <Segmented value={type} onChange={onTypeChange} items={[{ key: "", label: t("stock.doc-all") }, ...Object.entries(dm).map(([k, v]) => ({ key: k, label: v }))]} />
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && q.data.documents.length === 0 && <EmptyState icon="🗂️" title={t("stock.empty-documents")} />}
      <ul className="flex flex-col gap-2">
        {q.data?.documents.map((d) => (
          <DocumentCard key={d.id} d={d} highlight={d.id === highlight} canReverse={can("stock.adjust") && d.status === "posted" && d.type !== "issue" && !d.reversalOfId} />
        ))}
      </ul>
      {q.data && <Pagination page={dPage} pageSize={dPageSize} total={q.data.pagination?.total ?? 0} onChange={setDPage} />}
    </div>
  );
}

function DocumentCard({ d, highlight, canReverse }: { d: DocumentDTO; highlight: boolean; canReverse: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(highlight);
  const [reason, setReason] = useState("");
  const dtm = locale === "en" ? DOC_TYPE_MAP_EN : DOC_TYPE_MAP;
  const st = (locale === "en" ? DOC_STATUS_MAP_EN : DOC_STATUS_MAP)[d.status] ?? { label: d.status, cls: "" };
  return (
    <li className={`card p-4 flex flex-col gap-2 ${highlight ? "border-2 border-united-green" : ""}`}>
      <button type="button" className="flex items-center justify-between gap-2 text-start" onClick={() => setOpen(!open)}>
        <span className="font-extrabold" dir="ltr">{d.number}</span>
        <span className="flex items-center gap-2">
          <span className="text-xs font-bold text-united-muted">{dtm[d.type] ?? d.type} · {d.businessDate}</span>
          <span className={`rounded-full px-2 text-xs font-extrabold ${st.cls}`}>{st.label}</span>
        </span>
      </button>
      {d.reason && <p className="text-sm font-bold text-united-muted">{d.reason} — {d.createdBy}</p>}
      {open && (
        <>
          <ul className="text-sm flex flex-col gap-1">
            {d.movements.map((m) => (
              <li key={m.id} className="flex justify-between">
                <span className="font-bold">{m.product.name} · {m.location.code}{m.lot ? ` · ${m.lot.lotNumber}` : ""}</span>
                <span dir="ltr" className="font-extrabold">{fmtQty(m.quantity, m.product.unit)}</span>
              </li>
            ))}
            {d.movements.length === 0 && <li className="text-united-muted font-bold">{t("stock.no-movement-yet")}</li>}
          </ul>
          {canReverse && (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const res = await apiPost<{ document: { number: string } }>(`/api/inventory/documents/${d.id}/reverse`, { reason });
                  invalidateStockData(qc);
                  toast.show(`${t("stock.toast-document-reversed")} ${res.document.number}`, "success");
                } catch (err) {
                  toast.show(err instanceof ApiClientError ? err.message : t("stock.toast-error"), "error");
                }
              }}
            >
              <input className="field" placeholder={t("stock.reverse-reason-placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="btn-danger shrink-0">{t("stock.btn-reverse-doc")}</button>
            </form>
          )}
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

function Valuation() {
  const { t, locale } = useLocale();
  const q = useQuery({
    queryKey: ["stock", "inventory", "valuation"],
    queryFn: () =>
      apiFetch<{ totalValue: string; rows: { productId: string; productName: string; productNameAr: string | null; unit: string; costingMethod: string; quantity: string; value: string; averageCost: string | null; receivedWithoutCost: string }[] }>(
        "/api/inventory/reports/valuation"
      ),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="card p-4 flex justify-between font-extrabold text-lg">
        <span>{t("stock.val-total-title")}</span>
        <span dir="ltr">{fmtMoney(q.data.totalValue)}</span>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-united-muted text-xs">
              <th className="p-2 text-start">{t("stock.val-col-item")}</th>
              <th className="p-2">{t("stock.val-col-method")}</th>
              <th className="p-2">{t("stock.val-col-qty")}</th>
              <th className="p-2">{t("stock.val-col-avg-cost")}</th>
              <th className="p-2">{t("stock.val-col-total-value")}</th>
              <th className="p-2">{t("stock.val-col-nocode")}</th>
            </tr>
          </thead>
          <tbody>
            {q.data.rows.map((r) => (
              <tr key={r.productId} className="border-t border-united-dark/5 font-bold">
                <td className="p-2">{localName({ name: r.productName, nameAr: r.productNameAr }, locale)}</td>
                <td className="p-2 text-center uppercase">{r.costingMethod}</td>
                <td className="p-2 text-center" dir="ltr">{fmtQty(r.quantity, r.unit)}</td>
                <td className="p-2 text-center" dir="ltr">{r.averageCost ?? "—"}</td>
                <td className="p-2 text-center" dir="ltr">{fmtMoney(r.value)}</td>
                <td className="p-2 text-center" dir="ltr">{Number(r.receivedWithoutCost) > 0 ? fmtQty(r.receivedWithoutCost, r.unit) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs font-bold text-united-muted">{t("stock.val-info-uncosted")}</p>
    </div>
  );
}

function ReleaseButton({ productId, bucket: b }: { productId: string; bucket: Bucket }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(b.quantity);
  const [destId, setDestId] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The release endpoint requires stock.adjust; don't offer a form that can only be refused.
  if (!can("stock.adjust")) return null;
  if (!open) {
    return (
      <button type="button" className="text-xs font-extrabold text-united-green underline" onClick={() => setOpen(true)}>
        {t("stock.release-btn")}
      </button>
    );
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost(`/api/inventory/release`, {
        product_id: productId,
        location_id: b.locationId,
        destination_id: destId || undefined,
        quantity: Number(qty) || 0,
        lot_id: b.lotId,
        reason: reason.trim(),
        inspection_note: note.trim() || undefined,
      });
      toast.show(t("stock.toast-released"), "success");
      invalidateStockData(qc);
      setOpen(false);
    } catch (e) {
      const msg = e instanceof ApiClientError ? e.message : t("stock.toast-error");
      setErr(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl bg-united-warn/10 border border-united-warn/30 p-3 flex flex-col gap-2 mt-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-extrabold text-united-muted">{t("stock.release-qty-label")}</span>
          <input type="number" inputMode="decimal" step="0.001" min={0} value={qty} onChange={(e) => setQty(e.target.value)} className="field text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-extrabold text-united-muted">{t("stock.release-to-label")}</span>
          <select className="field text-sm" value={destId} onChange={(e) => setDestId(e.target.value)}>
            <option value="">{t("stock.release-select-default")}</option>
            <option value="loc_recv">{t("stock.release-dest-receiving")}</option>
            <option value="loc_disp">{t("stock.release-dest-loading")}</option>
            <option value="loc_cold_1">{t("stock.release-dest-cold-1")}</option>
            <option value="loc_cold_2">{t("stock.release-dest-cold-2")}</option>
          </select>
        </label>
      </div>
      <input placeholder={t("stock.release-reason-placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} className="field text-sm" />
      <input placeholder={t("stock.release-notes-placeholder")} value={note} onChange={(e) => setNote(e.target.value)} className="field text-sm" />
      {err && <p className="text-united-danger font-bold text-sm">{err}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy || !qty || Number(qty) <= 0 || !destId || !reason.trim()} className="btn-primary flex-1 text-sm">
          {busy ? t("stock.saving") : t("stock.btn-confirm-release")}
        </button>
        <button onClick={() => setOpen(false)} className="btn-secondary text-sm">{t("stock.btn-back")}</button>
      </div>
    </div>
  );
}
