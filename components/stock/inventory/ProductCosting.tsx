"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { invalidateStockData } from "@/lib/stockInvalidation";
import { useLocale } from "@/lib/locale";
import { Field, fmtMoney } from "./shared";

type Change = { id: string; effectiveDate: string; oldStandardCost: string | null; newStandardCost: string; onHandQty: string; revaluation: string; reason: string; createdBy: string };

/**
 * Finance's side of a product: costing method and standard cost, changed by accounting.manage
 * and read by whoever sees stock value. A new standard on a product holding stock needs a
 * reason — the server revalues that stock and records the change (DEFECT-SC-01); the history
 * below is that record.
 */
export function ProductCosting({ p, onHand, canEdit = true }: { p: { id: string; version: number; costingMethod: string; standardCost: string | null }; onHand: string; canEdit?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const [method, setMethod] = useState(p.costingMethod);
  const [standard, setStandard] = useState(p.standardCost ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useQuery({ queryKey: ["standard-cost", p.id], queryFn: () => apiFetch<{ changes: Change[] }>(`/api/inventory/products/${p.id}/standard-cost`) });
  const holding = Number(onHand) > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiPatch(`/api/inventory/products/${p.id}/settings`, {
        ...(method !== p.costingMethod ? { costing_method: method } : {}),
        ...(method === "standard" && standard.trim() !== (p.standardCost ?? "") ? { standard_cost: standard.trim() } : {}),
        ...(reason.trim() ? { standard_cost_reason: reason.trim() } : {}),
        expected_version: p.version,
      });
      invalidateStockData(qc);
      await qc.invalidateQueries({ queryKey: ["standard-cost", p.id] });
      setReason("");
      toast.show(t("stock.costing-saved"), "success");
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("stock.toast-error"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4 flex flex-col gap-3" aria-labelledby={`costing-${p.id}`}>
      <h3 id={`costing-${p.id}`} className="font-extrabold text-united-dark">{t("stock.costing-heading")}</h3>
      {!canEdit && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div><dt className="text-xs font-extrabold text-united-muted">{t("stock.costing-method-field")}</dt><dd className="font-bold">{t(`stock.costing.${p.costingMethod}`)}</dd></div>
          {p.costingMethod === "standard" && <div><dt className="text-xs font-extrabold text-united-muted">{t("stock.costing-standard-field")}</dt><dd className="font-bold tabular-nums" dir="ltr">{p.standardCost ? fmtMoney(p.standardCost) : "—"}</dd></div>}
        </dl>
      )}
      {canEdit && <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label={t("stock.costing-method-field")} hint={holding ? t("stock.costing-method-locked") : undefined}>
          <select className="field font-bold" value={method} disabled={holding} onChange={(e) => setMethod(e.target.value)}>
            {(["avco", "fifo", "standard"] as const).map((m) => (
              <option key={m} value={m}>{t(`stock.costing.${m}`)}</option>
            ))}
          </select>
        </Field>
        {method === "standard" && (
          <>
            <Field label={t("stock.costing-standard-field")} required>
              <input className="field tabular-nums" inputMode="decimal" dir="ltr" value={standard} onChange={(e) => setStandard(e.target.value)} required />
            </Field>
            <Field label={t("stock.costing-reason-field")} required={holding} hint={t("stock.costing-reason-hint")}>
              <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} required={holding && standard.trim() !== (p.standardCost ?? "")} />
            </Field>
            <p className="col-span-full text-sm text-united-dark/70">{t("stock.costing-variance-note")}</p>
          </>
        )}
        <button className="btn-primary col-span-full" disabled={busy}>{t("stock.costing-save")}</button>
      </form>}
      <h4 className="font-extrabold text-united-dark text-sm">{t("stock.costing-history")}</h4>
      {history.data && history.data.changes.length === 0 && <p className="text-sm text-united-dark/60">{t("stock.costing-history-empty")}</p>}
      <ul className="flex flex-col divide-y divide-united-dark/5 text-sm">
        {(history.data?.changes ?? []).map((c) => (
          <li key={c.id} className="py-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-bold tabular-nums">
              {t("stock.costing-history-row", { from: c.oldStandardCost ? fmtMoney(c.oldStandardCost) : "—", to: fmtMoney(c.newStandardCost), qty: c.onHandQty, value: fmtMoney(c.revaluation) })}
            </span>
            <span className="text-united-dark/60">{c.effectiveDate} · {c.createdBy} · {c.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
