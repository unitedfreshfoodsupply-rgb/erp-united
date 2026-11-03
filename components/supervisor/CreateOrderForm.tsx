"use client";

import { ErrorState } from "@/components/States";
import { unitLabel } from "@/lib/format";
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { usePermissions } from "@/lib/use-session";
import type { OrderDTO } from "@/lib/client-types";
import { invalidateOrderData } from "@/lib/queryInvalidation";
import { useToast } from "@/components/ui/Toast";
import { todayLocalISO } from "@/lib/localDate";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { formatNumber } from "@/lib/format";
import { Field } from "@/components/ui/Field";
import { lineMissingQuantity, linePriceDiffers, linePricingPayload } from "@/lib/orderEntry";

/**
 * Order entry (remediation 2026-11). Each line shows what can be promised now — the
 * quantity available to sell, in the line's unit — and the line cannot be confirmed
 * above it. Units carry their precision (KG to 3 decimals, PIECE whole). Each line has
 * its own agreed price (list price shown; typing a different one needs the price-
 * override permission and a reason). What the shelf cannot cover is offered as a
 * purchase request instead of an order line. The server enforces every rule again.
 */

type Row = { key: number; stock_product_id: string; quantity: string; unit: string; unit_price: string; discount_pct: string; search: string; prNumber?: string; serverIssue?: string; missingQty?: boolean };
type EntryProduct = {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  unit: string;
  stockTracked: boolean;
  packagings: { uomCode: string; qtyInBaseUnit: string }[];
  available: string | null;
};
type Shortfall = { line: number; productName: string; unit: string; requested: string; available: string; reason: string };

let nextKey = 1;
const emptyRow = (): Row => ({ key: nextKey++, stock_product_id: "", quantity: "", unit: "", unit_price: "", discount_pct: "", search: "" });
const fmt = (n: number, dp = 3) => (Number.isFinite(n) ? String(Math.round(n * 10 ** dp) / 10 ** dp) : "—");
const money = (n: number) => (Number.isFinite(n) ? formatNumber(n, { minDp: 2, maxDp: 2 }) : "—");

export function CreateOrderForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const { t, locale } = useLocale();
  // Manual orders use master-data IDs. Names are snapshots for this document, not
  // independent identities that can drift from the customer/product cards.
  const { can } = usePermissions();
  const canPrice = can("sales.price_override");
  const canRequest = can("purchasing.requests.create");
  const [accountId, setAccountId] = useState("");
  const accounts = useQuery({
    queryKey: ["sales", "customers", "", false],
    queryFn: () => apiFetch<{ customers: { id: string; code: string; name: string; nameAr: string | null; creditHold: boolean }[] }>("/api/sales/customers?q="),
    enabled: can("sales.customers.view"),
    staleTime: 60_000,
  });
  const catalog = useQuery({
    queryKey: ["orders", "entry-catalog"],
    queryFn: () => apiFetch<{ products: EntryProduct[]; precision: Record<string, number> }>("/api/orders/entry/catalog"),
    enabled: can("orders.create"),
    staleTime: 15_000,
  });
  const [date, setDate] = useState(todayLocalISO());
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [priceReason, setPriceReason] = useState("");
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const products = useMemo(() => catalog.data?.products ?? [], [catalog.data]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const precisionOf = (unit: string) => catalog.data?.precision?.[unit] ?? 3;

  // List prices for each (product, unit) on the delivery date for the chosen customer.
  const priceKeys = [...new Set(rows.filter((r) => r.stock_product_id && r.unit).map((r) => `${r.stock_product_id}|${r.unit}`))];
  const prices = useQuery({
    queryKey: ["orders", "entry-prices", accountId, date, priceKeys.join(",")],
    queryFn: async () => {
      const out: Record<string, string | null> = {};
      for (const k of priceKeys) {
        const [productId, unit] = k.split("|");
        const r = await apiFetch<{ unitPrice: string | null }>(`/api/orders/entry/price?product_id=${encodeURIComponent(productId)}&unit=${encodeURIComponent(unit)}&date=${date}${accountId ? `&customer_id=${encodeURIComponent(accountId)}` : ""}`);
        out[k] = r.unitPrice;
      }
      return out;
    },
    enabled: priceKeys.length > 0,
    staleTime: 30_000,
  });

  function factor(p: EntryProduct | undefined, unit: string): number | null {
    if (!p) return null;
    if (unit === p.unit) return 1;
    const pack = p.packagings.find((x) => x.uomCode === unit);
    return pack ? Number(pack.qtyInBaseUnit) : null;
  }

  // Per line: what it asks in the product's base unit, and what is left for it after
  // the lines above it on the same product (the server reserves in the same order).
  const lines = useMemo(() => {
    const used = new Map<string, number>();
    return rows.map((r) => {
      const p = byId.get(r.stock_product_id);
      const q = Number(r.quantity);
      const f = factor(p, r.unit);
      const prec = r.unit ? precisionOf(r.unit) : 3;
      const precisionOk = !r.quantity || (Number.isFinite(q) && Math.abs(Math.round(q * 10 ** prec) - q * 10 ** prec) < 1e-6);
      const base = f !== null && Number.isFinite(q) ? q * f : NaN;
      const totalAvail = p?.available != null ? Number(p.available) : null;
      const left = totalAvail === null || !p ? null : Math.max(0, totalAvail - (used.get(p.id) ?? 0));
      if (p && Number.isFinite(base) && base > 0) used.set(p.id, (used.get(p.id) ?? 0) + base);
      const leftInUnit = left !== null && f ? left / f : null;
      const short = left !== null && Number.isFinite(base) && base > left + 1e-9;
      const listPrice = prices.data?.[`${r.stock_product_id}|${r.unit}`] ?? null;
      const price = r.unit_price !== "" ? Number(r.unit_price) : listPrice !== null ? Number(listPrice) : NaN;
      const disc = r.discount_pct !== "" ? Number(r.discount_pct) : 0;
      const total = Number.isFinite(price) && Number.isFinite(q) ? q * price * (1 - disc / 100) : NaN;
      // A typed discount differs from the list too (list prices carry none): the reason
      // field must appear for it, or the server refuses a reason the user cannot type.
      const priceChanged = linePriceDiffers(r, listPrice);
      return { p, q, prec, precisionOk, short, leftInUnit, listPrice, price, total, priceChanged, unitKnown: f !== null };
    });
  }, [rows, byId, prices.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyShort = lines.some((l) => l.short);
  const anyBadPrecision = lines.some((l) => !l.precisionOk);
  const needsReason = lines.some((l) => l.priceChanged) && !priceReason.trim();
  const orderTotal = lines.reduce((a, l) => (Number.isFinite(l.total) ? a + l.total : a), 0);
  const anyUnpriced = rows.some((r, i) => r.stock_product_id && !Number.isFinite(lines[i].price));

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch, serverIssue: undefined, missingQty: undefined } : row)));
  }

  async function requestPurchase(i: number) {
    const r = rows[i];
    const l = lines[i];
    if (!accountId) {
      setError(t("create.pr-needs-customer"));
      return;
    }
    const missing = l.leftInUnit !== null ? l.q - l.leftInUnit : l.q;
    const prec = l.prec;
    const qtyToBuy = Math.ceil(missing * 10 ** prec - 1e-9) / 10 ** prec;
    try {
      const { request } = await apiPost<{ request: { number: string } }>("/api/purchasing/requests", {
        product_id: r.stock_product_id,
        quantity: qtyToBuy,
        uom: r.unit,
        customer_id: accountId,
        needed_by: date,
        customer_reference: notes || undefined,
      });
      updateRow(i, { prNumber: request.number });
      toast.show(t("create.pr-created", { number: request.number }), "success");
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("create.error-generic"), "error");
    }
  }

  function keepAvailable(i: number) {
    const l = lines[i];
    if (l.leftInUnit === null) return;
    const q = Math.floor(l.leftInUnit * 10 ** l.prec + 1e-9) / 10 ** l.prec;
    updateRow(i, { quantity: q > 0 ? String(q) : "" });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    // A line with a product but no quantity used to be left out of the order without a
    // word: refuse it and mark the line instead.
    if (rows.some(lineMissingQuantity)) {
      setRows((cur) => cur.map((row) => (lineMissingQuantity(row) ? { ...row, missingQty: true } : row)));
      return setError(t("create.error-invalid"));
    }
    const picked = rows.map((r, i) => ({ r, l: lines[i] })).filter(({ r }) => r.stock_product_id && Number(r.quantity) > 0);
    if (!accountId || !date || picked.length === 0 || picked.some(({ r }) => !r.unit)) {
      setError(t("create.error-invalid"));
      return;
    }
    if (anyBadPrecision) return setError(t("create.error-precision"));
    if (anyShort) return setError(t("create.error-short"));
    if (needsReason) return setError(t("create.error-price-reason"));
    setBusy(true);
    try {
      const { order } = await apiPost<{ order: OrderDTO }>("/api/orders", {
        customer_name: accounts.data?.customers.find((c) => c.id === accountId)?.nameAr
          ?? accounts.data?.customers.find((c) => c.id === accountId)?.name,
        customer_account_id: accountId,
        delivery_date: date,
        delivery_time: time || undefined,
        notes: notes || undefined,
        items: picked.map(({ r, l }) => {
          // A discount typed without a price is sent against the list price it was shown on.
          const pricing = canPrice ? linePricingPayload(r, l.listPrice, priceReason) : null;
          return {
            stock_product_id: r.stock_product_id,
            quantity: Number(r.quantity),
            unit: r.unit,
            ...(pricing ?? {}),
          };
        }),
      });
      await invalidateOrderData(qc);
      await qc.invalidateQueries({ queryKey: ["orders", "entry-catalog"] });
      toast.show(t("create.success-toast", { orderNumber: order.orderNumber }), "success");
      onDone();
      router.push(`/orders/${order.id}`);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "stock_unavailable") {
        // Server-side truth (stock moved since the screen loaded): mark the lines.
        const sf = ((err.details as { shortfalls?: Shortfall[] })?.shortfalls ?? []);
        const lineRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.stock_product_id && Number(r.quantity) > 0);
        setRows((cur) => cur.map((row, idx) => {
          const pos = lineRows.findIndex((x) => x.i === idx) + 1;
          const s = sf.find((x) => x.line === pos);
          return s ? { ...row, serverIssue: s.reason === "insufficient" ? t("create.short-server", { available: s.available, requested: s.requested, unit: unitLabel(s.unit, locale) }) : err.message } : row;
        }));
        await qc.invalidateQueries({ queryKey: ["orders", "entry-catalog"] });
      }
      const msg = err instanceof ApiClientError ? err.message : t("create.error-generic");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-5 flex flex-col gap-3">
      <div>
        <h2 className="text-xl font-extrabold text-united-dark">{t("create.title")}</h2>
        <p className="text-sm text-united-muted">{t("create.desc-stock")}</p>
      </div>
      {error && <p className="text-united-danger font-bold" role="alert">{error}</p>}

      {can("sales.customers.view") && (
        <select className="field font-bold" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label={t("create.customer-placeholder")}>
          <option value="">{t("create.customer-placeholder")}</option>
          {accounts.data?.customers.map((c) => (
            <option key={c.id} value={c.id}>{localName(c, locale)}{c.creditHold ? ` ${t("create.credit-hold")}` : ""}</option>
          ))}
        </select>
      )}
      {accounts.isLoading && <p className="text-sm text-united-muted">{t("create.loading-customers")}</p>}
      {accounts.isError && <ErrorState message={errorMessage(accounts.error)} onRetry={() => accounts.refetch()} />}
      {accounts.data && accounts.data.customers.length === 0 && <p className="text-sm text-united-warn">{t("create.no-customers")}</p>}
      {catalog.isLoading && <p className="text-sm text-united-muted">{t("create.loading-products")}</p>}
      {catalog.isError && <ErrorState message={errorMessage(catalog.error)} onRetry={() => catalog.refetch()} />}
      {catalog.data && products.length === 0 && <p className="text-sm text-united-warn">{t("create.no-products")}</p>}
      {accountId && <p className="text-sm text-united-muted">{t("create.account-info")}</p>}
      <div className="flex gap-3">
        <Field label={t("orders.delivery-date")} required className="flex-1"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field" /></Field>
        <Field label={t("orders.delivery-time-label")} className="flex-1"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="field" /></Field>
      </div>
      <Field label={t("create.notes-placeholder")}><input value={notes} onChange={(e) => setNotes(e.target.value)} className="field" /></Field>

      <div className="flex flex-col gap-3">
        {rows.map((row, i) => {
          const l = lines[i];
          const p = l.p;
          const units = p ? [...new Set([p.unit, ...p.packagings.map((x) => x.uomCode)])] : [];
          const q = row.search.trim().toLowerCase();
          const options = q ? products.filter((x) => [x.name, x.nameAr ?? "", x.sku ?? ""].some((s) => s.toLowerCase().includes(q))) : products;
          const bad = l.short || !l.precisionOk || !!row.serverIssue || !!row.missingQty;
          return (
            <div key={row.key} className={`rounded-xl border p-3 flex flex-col gap-2 ${bad ? "border-united-danger" : "border-united-border"}`}>
              <div className="flex gap-2 flex-wrap">
                <input
                  className="field w-40"
                  placeholder={t("create.search-product")}
                  value={row.search}
                  onChange={(e) => updateRow(i, { search: e.target.value })}
                  aria-label={t("create.search-product")}
                />
                <select
                  className="field flex-1 min-w-[12rem]"
                  value={row.stock_product_id}
                  onChange={(e) => {
                    const product = byId.get(e.target.value);
                    updateRow(i, { stock_product_id: e.target.value, unit: product?.unit ?? "", unit_price: "", discount_pct: "", prNumber: undefined });
                  }}
                  aria-label={t("create.product-placeholder")}
                >
                  <option value="">{t("create.product-placeholder")}</option>
                  {options.map((x) => (
                    <option key={x.id} value={x.id}>
                      {localName(x, locale)}
                      {x.available !== null ? ` — ${t("create.available-short", { qty: fmt(Number(x.available)), unit: unitLabel(x.unit, locale) })}` : ""}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setRows((r) => (r.length > 1 ? r.filter((_, idx) => idx !== i) : [emptyRow()]))} className="btn-danger px-3" aria-label={t("ui.delete")}>
                  <X size={18} aria-hidden />
                </button>
              </div>

              {p && (
                <div className="flex gap-2 flex-wrap items-end">
                  <Field label={t("create.qty-placeholder")} required className="w-28">
                    <input
                      type="number"
                      inputMode={l.prec === 0 ? "numeric" : "decimal"}
                      min={0}
                      step={l.prec === 0 ? 1 : 1 / 10 ** l.prec}
                      value={row.quantity}
                      onChange={(e) => updateRow(i, { quantity: e.target.value })}
                      className="field"
                      dir="ltr"
                    />
                  </Field>
                  <Field label={t("ui.qty.unit")} className="w-28">
                    <select value={row.unit} onChange={(e) => updateRow(i, { unit: e.target.value, unit_price: "" })} className="field">
                      {units.map((u) => <option key={u} value={u}>{unitLabel(u, locale)}</option>)}
                    </select>
                  </Field>
                  <span className="text-sm text-united-muted">
                    {l.leftInUnit !== null
                      ? t("create.available-line", { qty: fmt(l.leftInUnit, l.prec), unit: unitLabel(row.unit, locale) })
                      : t("create.not-stock-tracked")}
                  </span>
                </div>
              )}

              {p && (
                <div className="flex gap-2 flex-wrap items-center">
                  <label className="text-sm text-united-muted">{t("create.unit-price", { unit: unitLabel(row.unit, locale) })}</label>
                  {canPrice ? (
                    <>
                      <input
                        type="number" min={0} step="0.01" inputMode="decimal" dir="ltr"
                        className="field w-28"
                        placeholder={l.listPrice ?? "0.00"}
                        value={row.unit_price}
                        onChange={(e) => updateRow(i, { unit_price: e.target.value })}
                        aria-label={t("create.unit-price", { unit: unitLabel(row.unit, locale) })}
                      />
                      <input
                        type="number" min={0} max={100} step="0.5" inputMode="decimal" dir="ltr"
                        className="field w-20"
                        placeholder="0%"
                        value={row.discount_pct}
                        onChange={(e) => updateRow(i, { discount_pct: e.target.value })}
                        aria-label={t("create.discount")}
                      />
                      {l.listPrice === null && <span className="text-xs text-united-muted">{t("create.no-list-price")}</span>}
                    </>
                  ) : (
                    <span className="font-bold" dir="ltr">{l.listPrice ?? t("create.no-list-price")}</span>
                  )}
                  <span className="ms-auto font-extrabold" dir="ltr">{Number.isFinite(l.total) ? money(l.total) : "—"}</span>
                </div>
              )}

              {row.missingQty && <p className="text-sm text-united-danger" role="alert">{t("create.qty-missing")}</p>}
              {!l.precisionOk && <p className="text-sm text-united-danger">{l.prec === 0 ? t("create.whole-units-only", { unit: unitLabel(row.unit, locale) }) : t("create.too-many-decimals", { dp: String(l.prec) })}</p>}
              {(l.short || row.serverIssue) && (
                <div className="text-sm text-united-danger flex flex-col gap-1" role="alert">
                  <span>{row.serverIssue ?? t("create.short-line", { available: fmt(l.leftInUnit ?? 0, l.prec), requested: row.quantity, unit: unitLabel(row.unit, locale) })}</span>
                  <div className="flex gap-2 flex-wrap">
                    {l.leftInUnit !== null && l.leftInUnit > 0 && (
                      <button type="button" className="btn-secondary text-sm" onClick={() => keepAvailable(i)}>{t("create.keep-available")}</button>
                    )}
                    {canRequest && !row.prNumber && (
                      <button type="button" className="btn-secondary text-sm" onClick={() => requestPurchase(i)}>{t("create.request-purchase")}</button>
                    )}
                    {row.prNumber && <span className="text-united-green font-bold">{t("create.pr-linked", { number: row.prNumber })}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <button type="button" onClick={() => setRows((r) => [...r, emptyRow()])} className="btn-secondary self-start text-sm">
          {t("create.add-item")}
        </button>
      </div>

      {canPrice && lines.some((l) => l.priceChanged) && (
        <Field label={t("create.price-reason")}><input className="field" value={priceReason} onChange={(e) => setPriceReason(e.target.value)} /></Field>
      )}
      <div className="flex items-center justify-between border-t border-united-border pt-3">
        <span className="text-united-muted">{t("create.total-before-tax")}{anyUnpriced ? ` ${t("create.some-unpriced")}` : ""}</span>
        <span className="text-xl font-extrabold" dir="ltr">{money(orderTotal)}</span>
      </div>

      <button disabled={busy || anyShort || anyBadPrecision} className="btn-primary text-lg">
        {t("create.save-btn")}
      </button>
    </form>
  );
}
