"use client";

import { unitLabel } from "@/lib/format";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { useToast } from "@/components/ui/Toast";
import { MovementRow } from "@/components/stock/MovementRow";
import { invalidateStockData } from "@/lib/stockInvalidation";
import { fmtKg } from "@/lib/stockPresentation";
import { todayLocalISO } from "@/lib/localDate";
import type { MovementDTO, StockBalanceDTO } from "@/lib/stock-client-types";
import { useLocale } from "@/lib/locale";
import { PageHeader } from "@/components/ui/PageHeader";
import { localName } from "@/lib/locale/names";

export function LedgerView() {
  const { t, locale } = useLocale();
  const [productId, setProductId] = useState("");
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["stock", "ledger", productId],
    queryFn: () =>
      apiFetch<{ movements: MovementDTO[]; currentStock: StockBalanceDTO[] }>(
        `/api/stock/ledger?limit=100${productId ? `&product_id=${productId}` : ""}`
      ),
    refetchInterval: 20_000,
  });

  const stock = data?.currentStock ?? [];
  const selected = stock.find((s) => s.productId === productId);

  return (
    <div className="page-narrow">
      <PageHeader title={t("ledger.title")} description={t("ledger.note")} actions={<LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />} />

      {/* One labelled picker instead of a chip per product: the list grows with the catalogue. */}
      {stock.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
            <span className="field-label">{t("ledger.filter-product")}</span>
            <select className="field" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">{t("ledger.all")}</option>
              {stock.map((s) => (
                <option key={s.productId} value={s.productId}>
                  {localName({ name: s.productName, nameAr: s.productNameAr }, locale)} · {fmtKg(s.balanceKg)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {selected && (
        <div className="card p-4 flex items-center justify-between">
          <span className="font-semibold text-united-dark">{t("ledger.balance-of", { name: localName({ name: selected.productName, nameAr: selected.productNameAr }, locale) })}</span>
          <span dir="ltr" className="text-2xl font-bold text-united-green">
            {fmtKg(selected.balanceKg)} {unitLabel(selected.unit)}
          </span>
        </div>
      )}

      <AdjustmentForm products={stock} />

      <section className="card px-4 py-1">
        {isLoading && <LoadingState />}
        {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
        {!isLoading && !isError && (data?.movements.length ?? 0) === 0 && (
          <EmptyState icon="🧾" title={t("ledger.empty")} />
        )}
        <ul className="flex flex-col divide-y divide-united-border">
          {data?.movements.map((m) => (
            <MovementRow key={m.id} movement={m} />
          ))}
        </ul>
      </section>
    </div>
  );
}


/**
 * Manual stock correction — a stock count that disagrees with the ledger, spoilage, a
 * receipt that was never entered. Reason is mandatory because an unexplained balance
 * change is exactly the thing a ledger exists to prevent.
 */
function AdjustmentForm({ products }: { products: StockBalanceDTO[] }) {
  const { t, locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-secondary self-start text-sm">
        {t("ledger.adjust-open")}
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const n = Number(qty);
    if (!productId) return setError(t("ledger.choose-product"));
    if (!Number.isFinite(n) || n === 0) return setError(t("ledger.qty-nonzero"));
    if (!reason.trim()) return setError(t("ledger.reason-required"));
    setBusy(true);
    try {
      await apiPost("/api/stock/adjustments", {
        product_id: productId,
        quantity_kg: n,
        effective_date: todayLocalISO(),
        reason,
      });
      await invalidateStockData(qc);
      toast.show(t("ledger.toast-saved"), "success");
      setQty("");
      setReason("");
      setOpen(false);
    } catch (err) {
      const msg = err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-4 flex flex-col gap-3">
      <h2 className="font-extrabold text-united-dark">{t("ledger.adjust-title")}</h2>
      {error && <p className="text-united-danger font-bold text-sm">{error}</p>}
      <select value={productId} onChange={(e) => setProductId(e.target.value)} className="field font-bold">
        <option value="">{t("ledger.product-placeholder")}</option>
        {products.map((p) => (
          <option key={p.productId} value={p.productId}>
            {localName({ name: p.productName, nameAr: p.productNameAr }, locale)} ({fmtKg(p.balanceKg)} {unitLabel(p.unit)})
          </option>
        ))}
      </select>
      <input
        type="number"
        inputMode="decimal"
        step="any"
        placeholder={t("ledger.qty-placeholder")}
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        className="field text-center text-xl font-extrabold"
      />
      <input
        placeholder={t("ledger.reason-placeholder")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="field"
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn-primary flex-1 text-sm">
          {t("ledger.submit")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary flex-1 text-sm">
          {t("ledger.back")}
        </button>
      </div>
    </form>
  );
}
