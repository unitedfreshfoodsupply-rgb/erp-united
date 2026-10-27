"use client";

import { useState } from "react";
import { useLocale } from "@/lib/locale";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { newClientKey } from "@/lib/clientKey";
import { invalidateStockData } from "@/lib/stockInvalidation";
import type { SupplierDTO } from "@/lib/stock-client-types";
import { Field, LocationSelect, ProductSelect, Tabs } from "./shared";

/**
 * Stock movements, one form each, built for a tablet on the warehouse floor:
 * pick the product, the place, type the number, say why. Every form sends a fresh
 * idempotency key per attempt, so a double tap or a retry on a bad connection never
 * posts twice; the key is renewed only after a success.
 */

type Kind = "transfer" | "count" | "scrap" | "return_customer" | "return_supplier";

const newKey = newClientKey;

export function MoveForms({ initial }: { initial?: Kind }) {
  const { can } = usePermissions();
  const { t } = useLocale();
  const kinds: { key: Kind; label: string; allowed: boolean }[] = [
    { key: "transfer", label: t("stock.move-tab.transfer"), allowed: can("stock.transfer") },
    { key: "count", label: t("stock.move-tab.count"), allowed: can("stock.adjust") },
    { key: "scrap", label: t("stock.move-tab.scrap"), allowed: can("stock.adjust") },
    { key: "return_customer", label: t("stock.move-tab.return-customer"), allowed: can("stock.receive") },
    { key: "return_supplier", label: t("stock.move-tab.return-supplier"), allowed: can("stock.receive") },
  ];
  const allowed = kinds.filter((k) => k.allowed);
  const [kind, setKind] = useState<Kind>(initial && allowed.some((k) => k.key === initial) ? initial : allowed[0]?.key ?? "transfer");
  if (allowed.length === 0) return <p className="card p-4 font-bold text-united-muted">{t("stock.move-no-access")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <Tabs value={kind} onChange={setKind} items={allowed.map((k) => ({ key: k.key, label: k.label }))} />
      {kind === "transfer" && <TransferForm />}
      {kind === "count" && <CountForm />}
      {kind === "scrap" && <ScrapForm />}
      {kind === "return_customer" && <ReturnForm direction="customer" />}
      {kind === "return_supplier" && <ReturnForm direction="supplier" />}
    </div>
  );
}

/** Shared submit plumbing: busy state, error line, toast, stock refresh, key rotation. */
function useSubmit() {
  const { t } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  async function run(path: string, body: Record<string, unknown>, onDone: (res: any) => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<any>(path, { ...body, idempotency_key: key });
      invalidateStockData(qc);
      setKey(newKey());
      onDone(res);
    } catch (err) {
      const msg = err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run, toast };
}

function QtyInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  const { t } = useLocale();
  return (
    <Field label={label ?? t("stock.qty")}>
      <input inputMode="decimal" dir="ltr" className="field text-2xl font-extrabold text-center" value={value} onChange={(e) => onChange(e.target.value.replace(",", "."))} />
    </Field>
  );
}

function TransferForm() {
  const s = useSubmit();
  const { t } = useLocale();
  const [productId, setProductId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="card p-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!productId || !from || !to || !qty) return s.setError(t("stock.move-validation-fill-data"));
        void s.run("/api/inventory/transfers", { reason: reason.trim() || undefined, lines: [{ product_id: productId, quantity: qty, location_id: from, to_location_id: to }] }, (res) => {
          s.toast.show(`${t("stock.move-recorded")} ${res.document.number}`, "success");
          setQty("");
        });
      }}
    >
      {s.error && <p className="text-united-danger font-bold text-sm">{s.error}</p>}
      <Field label={t("stock.move-field-product")}><ProductSelect value={productId} onChange={setProductId} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("stock.move-field-from")}><LocationSelect value={from} onChange={setFrom} /></Field>
        <Field label={t("stock.move-field-to")}><LocationSelect value={to} onChange={setTo} /></Field>
      </div>
      <QtyInput value={qty} onChange={setQty} />
      <input className="field" placeholder={t("stock-move-note-placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn-primary w-full text-lg" disabled={s.busy}>{s.busy ? t("stock-move-btn-recorded") : t("stock.move-btn-save-transfer")}</button>
    </form>
  );
}

function CountForm() {
  const s = useSubmit();
  const { t } = useLocale();
  const [productId, setProductId] = useState("");
  const [location, setLocation] = useState("");
  const [mode, setMode] = useState<"counted" | "delta">("counted");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="card p-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!productId || qty === "") return s.setError(t("stock.move-validation-item-qty"));
        if (mode === "counted" && !location) return s.setError(t("stock.move-validation-count-location"));
        if (!reason.trim()) return s.setError(t("stock.move-validation-adjustment-reason"));
        const line = mode === "counted" ? { product_id: productId, location_id: location, counted_quantity: qty } : { product_id: productId, quantity: qty, location_id: location || undefined };
        void s.run("/api/inventory/adjustments", { reason, lines: [line] }, (res) => {
          s.toast.show(res.document.status === "pending_approval" ? `${res.document.number} ${t("stock.move-pending-approval")}` : `${t("stock.move-recorded")} ${res.document.number}`, "success");
          setQty("");
        });
      }}
    >
      {s.error && <p className="text-united-danger font-bold text-sm">{s.error}</p>}
      <Tabs value={mode} onChange={setMode} items={[{ key: "counted", label: t("stock.move-adjustment-counted") }, { key: "delta", label: t("stock.move-adjustment-delta") }]} />
      <Field label={t("stock.move-field-product")}><ProductSelect value={productId} onChange={setProductId} /></Field>
      <Field label={t("stock.move-field-location")}><LocationSelect value={location} onChange={setLocation} allowAny={mode === "delta"} anyLabel={t("stock.move-field-any")} /></Field>
      <QtyInput value={qty} onChange={setQty} label={mode === "counted" ? t("stock.move-qty-counted") : t("stock.move-qty-delta")} />
      <input className="field" placeholder={t("stock.move-reason-placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="text-xs font-bold text-united-muted">{t("stock-move-large-diff")}</p>
      <button className="btn-primary w-full text-lg" disabled={s.busy}>{s.busy ? t("stock-move-btn-recorded") : t("stock-move-btn-submit")}</button>
    </form>
  );
}

function ScrapForm() {
  const s = useSubmit();
  const { t } = useLocale();
  const [productId, setProductId] = useState("");
  const [location, setLocation] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="card p-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!productId || !qty) return s.setError(t("stock.move-validation-item-qty"));
        if (!reason.trim()) return s.setError(t("stock.move-scrap-reason-required"));
        void s.run("/api/inventory/scrap", { reason, lines: [{ product_id: productId, quantity: qty, location_id: location || undefined }] }, (res) => {
          s.toast.show(`${t("stock.move-recorded")} ${res.document.number}`, "success");
          setQty("");
        });
      }}
    >
      {s.error && <p className="text-united-danger font-bold text-sm">{s.error}</p>}
      <Field label={t("stock.move-field-product")}><ProductSelect value={productId} onChange={setProductId} /></Field>
      <Field label={t("stock-move-field-from-location")}><LocationSelect value={location} onChange={setLocation} allowAny /></Field>
      <QtyInput value={qty} onChange={setQty} />
      <input className="field" placeholder={t("stock-move-scrap-reason-placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn-danger w-full text-lg" disabled={s.busy}>{s.busy ? t("stock-move-btn-recorded") : t("stock-move-btn-save-scrap")}</button>
    </form>
  );
}

function ReturnForm({ direction }: { direction: "customer" | "supplier" }) {
  const s = useSubmit();
  const { t } = useLocale();
  const suppliers = useQuery({
    queryKey: ["stock", "suppliers"],
    queryFn: () => apiFetch<{ suppliers: SupplierDTO[] }>("/api/stock/suppliers"),
    enabled: direction === "supplier",
    staleTime: 60_000,
  });
  const [productId, setProductId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [location, setLocation] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="card p-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!productId || !qty) return s.setError(t("stock.move-validation-item-qty"));
        if (direction === "supplier" && !supplierId) return s.setError(t("stock-move-choose-supplier"));
        if (!reason.trim()) return s.setError(t("stock-move-return-reason-required"));
        void s.run(
          "/api/inventory/returns",
          { direction, reason, supplier_id: supplierId || undefined, order_id: orderId.trim() || undefined, lines: [{ product_id: productId, quantity: qty, location_id: location || undefined }] },
          (res) => {
            s.toast.show(`${t("stock.move-recorded")} ${res.document.number}`, "success");
            setQty("");
          }
        );
      }}
    >
      {s.error && <p className="text-united-danger font-bold text-sm">{s.error}</p>}
      {direction === "supplier" ? (
        <Field label={t("stock-move-field-supplier")}>
          <select className="field font-bold" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">{t("stock-move-choose-supplier")}</option>
            {(suppliers.data?.suppliers ?? []).map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label={t("stock-move-field-order")}>
          <input className="field" dir="ltr" value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder={t("stock-move-order-placeholder")} />
        </Field>
      )}
      <Field label={t("stock.move-field-product")}><ProductSelect value={productId} onChange={setProductId} /></Field>
      <Field label={direction === "customer" ? t("stock-move-field-enter-location") : t("stock-move-field-exit-location")}>
        <LocationSelect value={location} onChange={setLocation} allowAny anyLabel={direction === "customer" ? t("stock-move-quarantine-label") : t("stock-move-any-location")} />
      </Field>
      <QtyInput value={qty} onChange={setQty} />
      <input className="field" placeholder={t("stock.move-reason-placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn-primary w-full text-lg" disabled={s.busy}>{s.busy ? t("stock-move-btn-recorded") : t("stock-move-btn-save-return")}</button>
    </form>
  );
}
