"use client";

import { ErrorState } from "@/components/States";
import { unitLabel } from "@/lib/format";
import { useState } from "react";
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

type Row = { stock_product_id: string; quantity: string; unit: string };
type CatalogProduct = {
  id: string;
  name: string;
  nameAr: string | null;
  unit: string;
  packagings: { uomCode: string }[];
};

export function CreateOrderForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const { t, locale } = useLocale();
  // Manual orders use master-data IDs. Names are snapshots for this document, not
  // independent identities that can drift from the customer/product cards.
  const { can } = usePermissions();
  const [accountId, setAccountId] = useState("");
  const accounts = useQuery({
    queryKey: ["sales", "customers", "", false],
    queryFn: () => apiFetch<{ customers: { id: string; code: string; name: string; nameAr: string | null; creditHold: boolean }[] }>("/api/sales/customers?q="),
    enabled: can("sales.customers.view"),
    staleTime: 60_000,
  });
  const catalog = useQuery({
    queryKey: ["sales", "catalog"],
    queryFn: () => apiFetch<{ products: CatalogProduct[] }>("/api/sales/catalog"),
    enabled: can("sales.quotations.view"),
    staleTime: 60_000,
  });
  const [date, setDate] = useState(todayLocalISO());
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Row[]>([{ stock_product_id: "", quantity: "", unit: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const items = rows
      .filter((r) => r.stock_product_id && Number(r.quantity) > 0)
      .map((r) => ({ stock_product_id: r.stock_product_id, quantity: Number(r.quantity), unit: r.unit }));
    if (!accountId || !date || items.length === 0 || items.some((i) => !i.unit)) {
      setError(t("create.error-invalid"));
      return;
    }
    setBusy(true);
    try {
      const { order } = await apiPost<{ order: OrderDTO }>("/api/orders", {
        customer_name: accounts.data?.customers.find((c) => c.id === accountId)?.nameAr
          ?? accounts.data?.customers.find((c) => c.id === accountId)?.name,
        customer_account_id: accountId,
        delivery_date: date,
        delivery_time: time || undefined,
        notes: notes || undefined,
        items,
      });
      await invalidateOrderData(qc);
      toast.show(t("create.success-toast", { orderNumber: order.orderNumber }), "success");
      onDone();
      router.push(`/orders/${order.id}`);
    } catch (err) {
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
        <p className="text-sm text-united-muted">
          {t("create.desc")}
        </p>
      </div>
      {error && <p className="text-united-danger font-bold">{error}</p>}

      {can("sales.customers.view") && (
        <select
          className="field font-bold"
          value={accountId}
          onChange={(e) => {
            setAccountId(e.target.value);
          }}
         aria-label={t("create.customer-placeholder")}>
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
      {catalog.data && catalog.data.products.length === 0 && <p className="text-sm text-united-warn">{t("create.no-products")}</p>}
      {accountId && <p className="text-sm text-united-muted">{t("create.account-info")}</p>}
      <div className="flex gap-3">
        <input type="date" aria-label={t("orders.delivery-date")} value={date} onChange={(e) => setDate(e.target.value)} className="field flex-1" />
        <input type="time" aria-label={t("orders.delivery-time-label")} value={time} onChange={(e) => setTime(e.target.value)} className="field flex-1" />
      </div>
      <input
        placeholder={t("create.notes-placeholder")}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="field"
       aria-label={t("create.notes-placeholder")}/>

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <select
              className="field flex-1 min-w-0"
              value={row.stock_product_id}
              onChange={(e) => {
                const product = catalog.data?.products.find((p) => p.id === e.target.value);
                updateRow(i, { stock_product_id: e.target.value, unit: product?.unit ?? "" });
              }}
            >
              <option value="">{t("create.product-placeholder")}</option>
              {catalog.data?.products.map((p) => (
                <option key={p.id} value={p.id}>{localName(p, locale)}</option>
              ))}
            </select>
            <input
              placeholder={t("create.qty-placeholder")}
              type="number"
              value={row.quantity}
              onChange={(e) => updateRow(i, { quantity: e.target.value })}
              className="field w-24"
             aria-label={t("create.qty-placeholder")}/>
            <select
              aria-label={t("ui.qty.unit")}
              value={row.unit}
              onChange={(e) => updateRow(i, { unit: e.target.value })}
              className="field w-28"
            >
              {(() => {
                const product = catalog.data?.products.find((p) => p.id === row.stock_product_id);
                const units = product ? [product.unit, ...product.packagings.map((x) => x.uomCode)] : [];
                return <>
                  {!row.unit && <option value="">{t("create.unit-placeholder")}</option>}
                  {[...new Set(units)].map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}
                </>;
              })()}
            </select>
            <button type="button" onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))} className="btn-danger px-3" aria-label={t("ui.delete")}>
              <X size={18} aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setRows((r) => [...r, { stock_product_id: "", quantity: "", unit: "" }])}
          className="btn-secondary self-start text-sm"
        >
          {t("create.add-item")}
        </button>
      </div>

      <button disabled={busy} className="btn-primary text-lg">
        {t("create.save-btn")}
      </button>
    </form>
  );
}
