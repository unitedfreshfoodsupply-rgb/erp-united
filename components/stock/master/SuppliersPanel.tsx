"use client";

import { useState } from "react";
import { useLocale } from "@/lib/locale";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { invalidateStockData } from "@/lib/stockInvalidation";
import type { SupplierDTO } from "@/lib/stock-client-types";
import { localName } from "@/lib/locale/names";

/** Suppliers. Unchanged behaviour, moved here so the Product Master screen owns all
 * three reference lists in one place. */
export function SuppliersPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const { data, isLoading, isError, error: queryError, refetch } = useQuery({
    queryKey: ["stock", "suppliers", "all"],
    queryFn: () => apiFetch<{ suppliers: SupplierDTO[] }>("/api/stock/suppliers?all=1"),
  });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/stock/suppliers", { name, phone: phone || undefined });
      await invalidateStockData(qc);
      toast.show(t("suppliers.toast-added"), "success");
      setName("");
      setPhone("");
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("ui.error");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: SupplierDTO) {
    if (togglingId) return;
    setTogglingId(s.id);
    try {
      await apiPatch(`/api/stock/suppliers/${s.id}`, { active: !s.active, expected_version: s.version });
      await invalidateStockData(qc);
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("ui.error"), "error");
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <>
      {canManage && <form onSubmit={add} className="card p-4 flex flex-col gap-3">
        <h2 className="font-extrabold text-united-dark">{t("suppliers.form-title")}</h2>
        {error && <p className="text-united-danger font-bold text-sm">{error}</p>}
        <input placeholder={t("suppliers.name-field")} value={name} onChange={(e) => setName(e.target.value)} className="field" />
        <input placeholder={t("suppliers.phone-field")} value={phone} onChange={(e) => setPhone(e.target.value)} className="field" inputMode="tel" />
        <button type="submit" disabled={busy || !name.trim()} className="btn-primary text-sm">
          {t("suppliers.btn-add")}
        </button>
      </form>}

      <section className="card p-4">
        {isLoading && <LoadingState />}
        {isError && <ErrorState message={errorMessage(queryError)} onRetry={() => refetch()} />}
        {!isLoading && !isError && (data?.suppliers.length ?? 0) === 0 && <EmptyState icon="🚚" title={t("suppliers.empty")} />}
        <ul className="flex flex-col divide-y divide-united-border">
          {data?.suppliers.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-3 gap-2">
              <div className="min-w-0">
                <div className="font-bold text-united-dark truncate">{localName(s, locale)}</div>
                {s.phone && <div dir="ltr" className="text-xs font-bold text-united-muted">{s.phone}</div>}
              </div>
              {canManage && <button
                onClick={() => toggle(s)}
                disabled={togglingId === s.id}
                className={`px-3 py-2 rounded-lg text-xs font-extrabold shrink-0 disabled:opacity-50 ${
                  s.active ? "bg-united-green/10 text-united-green" : "bg-united-dark/10 text-united-muted"
                }`}
              >
                {togglingId === s.id ? "…" : s.active ? t("suppliers.status-active") : t("suppliers.status-inactive")}
              </button>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
