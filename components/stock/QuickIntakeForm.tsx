"use client";

import { forwardRef, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { todayLocalISO } from "@/lib/localDate";
import { fmtKg, fmtYield, YIELD_TONE_CLASS, yieldTone } from "@/lib/stockPresentation";
import { invalidateStockData } from "@/lib/stockInvalidation";
import type { IntakeDTO, StockProductDTO, SupplierDTO } from "@/lib/stock-client-types";
import { usePermissions } from "@/lib/use-session";
import { LocationSelect } from "@/components/stock/inventory/shared";
import { newClientKey } from "@/lib/clientKey";
import Link from "next/link";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

type OpenPoLine = { lineId: string; poNumber: string; expectedDate: string | null; supplier: { id: string; name: string }; product: { id: string; name: string; unit: string }; ordered: string; receivedGood: string; remaining: string };
type Packaging = { uomCode: string; qtyInBaseUnit: string; active: boolean; uom: { nameAr: string | null; name: string } };

/**
 * The screen this module exists for: one receipt, recorded on a tablet, in seconds.
 *
 * Choices that matter for speed on site:
 *  - supplier and product are tap-to-pick chips, not dropdowns — no second tap to open,
 *    no scrolling a native picker with wet or gloved hands
 *  - good output and yield are computed live as the numbers are typed, so the operator
 *    sees the result of the entry before committing it (the server recomputes both —
 *    nothing derived is ever sent from here)
 *  - after saving, the supplier and product stay selected and only the weights clear,
 *    because deliveries arrive in runs from the same supplier
 */
export function QuickIntakeForm({ date }: { date: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const receivedRef = useRef<HTMLInputElement>(null);

  const suppliersQ = useQuery({
    queryKey: ["stock", "suppliers"],
    queryFn: () => apiFetch<{ suppliers: SupplierDTO[] }>("/api/stock/suppliers"),
    staleTime: 60_000,
  });
  const productsQ = useQuery({
    queryKey: ["stock", "products"],
    queryFn: () => apiFetch<{ products: StockProductDTO[] }>("/api/stock/products"),
    staleTime: 60_000,
  });

  const suppliers = suppliersQ.data?.suppliers ?? [];
  const products = productsQ.data?.products ?? [];

  const [supplierId, setSupplierId] = useState("");
  const [productId, setProductId] = useState("");
  const [receivedKg, setReceivedKg] = useState("");
  const [rejectedKg, setRejectedKg] = useState("");
  const [gradeBKg, setGradeBKg] = useState("");
  const [wasteKg, setWasteKg] = useState("");
  const [gradeBProductId, setGradeBProductId] = useState(""); // separate SKU for the فرزة
  const [crates, setCrates] = useState("");
  const [notes, setNotes] = useState("");
  const [receivedDate, setReceivedDate] = useState(date);
  // Optional detail: where it was put, when it expires, what it cost, and whether it
  // was counted in packages (crates) rather than the base unit.
  const { can } = usePermissions();
  const [showMore, setShowMore] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [expiry, setExpiry] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [countUom, setCountUom] = useState("");
  const packagingsQ = useQuery({
    queryKey: ["stock", "inventory", "product", productId],
    queryFn: () => apiFetch<{ product: { unit: string; packagings: Packaging[] } }>(`/api/inventory/products/${productId}`),
    enabled: !!productId,
    staleTime: 60_000,
  });
  const packagings = (packagingsQ.data?.product.packagings ?? []).filter((p) => p.active);
  const baseUnit = packagingsQ.data?.product.unit ?? "KG";
  const factor = countUom ? Number(packagings.find((p) => p.uomCode === countUom)?.qtyInBaseUnit ?? NaN) : 1;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per filled form, kept across a failed or timed-out attempt so the retry
  // returns the receipt the server may already have recorded; renewed after success.
  const [submitKey, setSubmitKey] = useState(newClientKey);
  // Against a purchase order: the line fixes the product and the cost (which the gate
  // never sees); the server holds the quantity to the order's tolerance.
  const [poLineId, setPoLineId] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const openLinesQ = useQuery({
    queryKey: ["purchasing", "receiving", supplierId],
    queryFn: () => apiFetch<{ lines: OpenPoLine[] }>(`/api/purchasing/receiving?supplier_id=${encodeURIComponent(supplierId)}`),
    enabled: !!supplierId,
  });
  const openLines = openLinesQ.data?.lines ?? [];
  const poLine = openLines.find((l) => l.lineId === poLineId) ?? null;
  function pickSupplier(id: string) {
    setSupplierId(id);
    setPoLineId("");
  }
  function pickProduct(id: string) {
    setProductId(id);
    if (poLine && poLine.product.id !== id) setPoLineId("");
  }
  function pickPoLine(l: OpenPoLine | null) {
    setPoLineId(l?.lineId ?? "");
    if (l) {
      setProductId(l.product.id);
      setUnitCost("");
    }
  }

  const preview = useMemo(() => {
    const r = Number(receivedKg) * factor;
    const x = Number(rejectedKg || 0);
    const b = Number(gradeBKg || 0);
    const w = Number(wasteKg || 0);
    if (!Number.isFinite(r) || r <= 0) return null;
    if (!Number.isFinite(x) || x < 0 || x > r) return null;
    if (!Number.isFinite(b) || b < 0 || !Number.isFinite(w) || w < 0) return null;
    if (x + b + w > r) return null;
    const good = Math.round((r - x - b - w) * 1000) / 1000;
    return { good, pct: r > 0 ? Math.round((good / r) * 1000) / 10 : null };
  }, [receivedKg, rejectedKg, gradeBKg, wasteKg, factor]);

  const splitTooHigh =
    (gradeBKg !== "" || wasteKg !== "") &&
    Number(gradeBKg || 0) + Number(wasteKg || 0) + Number(rejectedKg || 0) > Number(receivedKg) * factor;

  const rejectedTooHigh =
    receivedKg !== "" && rejectedKg !== "" && Number(rejectedKg) > Number(receivedKg) * factor;

  const setupIncomplete = !suppliersQ.isLoading && !productsQ.isLoading && (suppliers.length === 0 || products.length === 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!supplierId) return setError(t("stock.required-supplier"));
    if (!productId) return setError(t("stock.required-product"));
    const r = Number(receivedKg);
    if (!Number.isFinite(r) || r <= 0) return setError(t("stock.enter-received-qty"));
    const x = rejectedKg === "" ? 0 : Number(rejectedKg);
    if (!Number.isFinite(x) || x < 0) return setError(t("stock.sorting-qty-positive"));
    if (x > r * factor) return setError(t("stock.rejected-too-high"));
    const gb = gradeBKg === "" ? 0 : Number(gradeBKg);
    const wst = wasteKg === "" ? 0 : Number(wasteKg);
    if (!Number.isFinite(gb) || gb < 0 || !Number.isFinite(wst) || wst < 0) return setError(t("stock.split-quantities-positive"));
    if (x + gb + wst > r * factor) return setError(t("stock.split-exceeds-received"));

    setBusy(true);
    try {
      const { intake } = await apiPost<{ intake: IntakeDTO }>("/api/stock/intakes", {
        supplier_id: supplierId,
        product_id: productId,
        received_date: receivedDate,
        // Counted in packages: the server converts through this product's packaging
        // (exactly, or refuses) — nothing derived is sent from here.
        ...(countUom ? { entered_qty: receivedKg, entered_uom: countUom } : { received_kg: r }),
        rejected_kg: x,
        grade_b_qty: gradeBKg === "" ? 0 : Number(gradeBKg),
        waste_qty: wasteKg === "" ? 0 : Number(wasteKg),
        grade_b_product_id: gradeBProductId || undefined,
        crate_count: crates === "" ? null : Number(crates),
        notes: notes.trim() || undefined,
        location_id: locationId || undefined,
        expiry_date: expiry || undefined,
        unit_cost: poLineId ? undefined : unitCost.trim() || undefined,
        purchase_order_line_id: poLineId || undefined,
        rejection_reason: x > 0 ? rejectionReason.trim() || undefined : undefined,
        idempotency_key: submitKey,
      });
      setSubmitKey(newClientKey());
      await invalidateStockData(qc);
      toast.show(`${t("stock.logged")} ${intake.receiptNumber} · ${fmtKg(intake.goodKg)} ${baseUnit}${intake.lot ? ` · ${intake.lot.lotNumber}` : ""}${poLine ? ` · ${poLine.poNumber}` : ""}`, "success");
      if (poLineId) qc.invalidateQueries({ queryKey: ["purchasing"] });
      // Keep supplier/product — the next delivery is usually from the same truck.
      setReceivedKg("");
      setRejectedKg("");
      setGradeBKg("");
      setWasteKg("");
      setGradeBProductId("");
      setCrates("");
      setNotes("");
      setRejectionReason("");
      setUnitCost("");
      setExpiry("");
      receivedRef.current?.focus();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("stock.error-generic");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  if (setupIncomplete) {
    return (
      <div className="card p-5 flex flex-col gap-2 items-start">
        <h2 className="text-xl font-extrabold text-united-dark">{t("stock.intake-form")}</h2>
        <p className="text-sm font-bold text-united-muted">
          {suppliers.length === 0 && products.length === 0
            ? t("stock.setup-all")
            : suppliers.length === 0
            ? t("stock.setup-suppliers-first")
            : t("stock.setup-products-first")}
        </p>
        <Link href="/stock/setup" className="btn-primary text-sm">
          {t("stock.setup-link")}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold text-united-dark">{t("stock.intake-form")}</h2>
        <input
          type="date"
          value={receivedDate}
          onChange={(e) => setReceivedDate(e.target.value || todayLocalISO())}
          className="tap-target border-2 border-united-dark/10 rounded-xl px-3 font-bold text-sm bg-white focus:border-united-green outline-none"
          aria-label={t("stock.date")}
        />
      </div>

      {error && <p className="text-united-danger font-bold text-sm">{error}</p>}

      <ChipPicker label={t("stock.supplier")} items={suppliers} value={supplierId} onChange={pickSupplier} />
      {supplierId && openLines.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="field-label">{t("stock.on-order")}</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={!poLineId} onClick={() => pickPoLine(null)} className="chip">
              {t("stock.no-order")}
            </button>
            {openLines.map((l) => (
              <button
                key={l.lineId}
                type="button"
                aria-pressed={poLineId === l.lineId}
                onClick={() => pickPoLine(l)}
                className="chip h-auto whitespace-normal py-2 text-start"
              >
                {l.poNumber} · {localName(l.product, locale)} · {t("stock.remaining")} <span dir="ltr">{fmtKg(Number(l.remaining))}</span> {l.product.unit}
              </button>
            ))}
          </div>
        </div>
      )}
      <ChipPicker label={t("stock.product")} items={products} value={productId} onChange={pickProduct} />

      {packagings.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {[{ code: "", label: t("stock.packaging-unit", { unit: baseUnit }) }, ...packagings.map((p) => ({ code: p.uomCode, label: `${t("stock.packaging-in")} ${localName(p.uom, locale)} (${Number(p.qtyInBaseUnit)} ${baseUnit})` }))].map((o) => (
            <button
              key={o.code}
              type="button"
              aria-pressed={countUom === o.code}
              onClick={() => setCountUom(o.code)}
              className="chip"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          ref={receivedRef}
          label={countUom ? `${t("stock.received")} (${localName({ ...packagings.find((p) => p.uomCode === countUom)?.uom, code: countUom }, locale)})` : t("stock.received-k")}
          value={receivedKg}
          onChange={setReceivedKg}
          autoFocusable
        />
        <NumberField label={t("stock.crates-count")} value={crates} onChange={setCrates} integer />
        <NumberField
          label={t("stock.rejected-sort-k")}
          value={rejectedKg}
          onChange={setRejectedKg}
          invalid={rejectedTooHigh}
        />
        <NumberField
          label={t("stock.grade-b-desc-k")}
          value={gradeBKg}
          onChange={setGradeBKg}
          invalid={splitTooHigh}
        />
        <NumberField
          label={t("stock.waste-k")}
          value={wasteKg}
          onChange={setWasteKg}
          invalid={splitTooHigh}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("stock.good-output-k")}</span>
          <div className="tap-target flex items-center justify-center rounded-xl bg-united-green/10 border-2 border-united-green/20">
            <span dir="ltr" className="text-2xl font-extrabold text-united-green">
              {preview ? fmtKg(preview.good) : "—"}
            </span>
          </div>
        </div>
      </div>

      {splitTooHigh && (
        <p className="text-[11px] font-bold text-united-danger">
          {t("stock.split-exceeds-received")}
        </p>
      )}

      {Number(gradeBKg) > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("stock.grade-b-product-hint")}</span>
          <select
            className="field"
            value={gradeBProductId}
            onChange={(e) => setGradeBProductId(e.target.value)}
          >
            <option value="">{t("stock.grade-b-same-product")}</option>
            {products
              .filter((p) => p.stockTracked && p.unit === "KG" && p.id !== productId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {localName(p, locale)}
                </option>
              ))}
          </select>
        </div>
      )}

      {Number(rejectedKg) > 0 && (
        <input placeholder={t("stock.rejection-reason-placeholder")} value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} className="field" />
      )}

      <div className="flex items-center justify-between rounded-xl bg-united-dark/[0.03] px-4 py-3">
        <span className="text-sm font-extrabold text-united-dark">{t("stock.yield-percentage")}</span>
        <span dir="ltr" className={`text-2xl font-extrabold ${YIELD_TONE_CLASS[yieldTone(preview?.pct ?? null)]}`}>
          {fmtYield(preview?.pct ?? null)}
        </span>
      </div>

      <button type="button" className="text-sm font-extrabold text-united-green self-start underline" onClick={() => setShowMore(!showMore)}>
        {showMore ? t("stock.hide-details") : t("stock.more-details-btn")}
      </button>
      {showMore && (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-xs font-extrabold text-united-muted">{t("stock.location-default")}</span>
            <LocationSelect value={locationId} onChange={setLocationId} allowAny anyLabel={t("stock.receive-area")} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-extrabold text-united-muted">{t("stock.expiry-default")}</span>
            <input type="date" className="field" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </label>
          {can("stock.valuation.view") && !poLineId && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-extrabold text-united-muted">{t("stock.unit-cost")}</span>
              <input inputMode="decimal" dir="ltr" className="field" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
            </label>
          )}
        </div>
      )}

      <input
        placeholder={t("stock.notes-input")}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="field"
      />

      <button type="submit" disabled={busy || !preview} className="btn-primary w-full text-lg">
        {busy ? t("stock.saving") : t("stock.record-intake")}
      </button>
    </form>
  );
}

/** Tap-to-pick list. Falls back to a native select past ~12 entries, where a wall of
 * chips stops being faster than a picker. */
function ChipPicker({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLocale();
  if (items.length > 12) {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-xs font-extrabold text-united-muted">{label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)} className="field font-bold">
          <option value="">{t("stock.choose")}</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-extrabold text-united-muted">{label}</span>
      <div className="flex flex-wrap gap-2">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => onChange(i.id)}
            aria-pressed={value === i.id}
            className="chip"
          >
            {i.name}
          </button>
        ))}
      </div>
    </div>
  );
}

const NumberField = forwardRef<
  HTMLInputElement,
  {
    label: string;
    value: string;
    onChange: (v: string) => void;
    integer?: boolean;
    invalid?: boolean;
    autoFocusable?: boolean;
  }
>(function NumberField({ label, value, onChange, integer, invalid, autoFocusable }, ref) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-extrabold text-united-muted">{label}</span>
      <input
        ref={ref}
        type="number"
        // decimal keypad on mobile; "numeric" would hide the decimal point that
        // every weight on this screen needs.
        inputMode={integer ? "numeric" : "decimal"}
        step={integer ? 1 : "any"}
        min={0}
        autoFocus={autoFocusable}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`tap-target w-full text-center text-2xl font-extrabold border-2 rounded-xl outline-none transition ${
          invalid ? "border-united-danger bg-red-50" : "border-united-dark/10 focus:border-united-green"
        }`}
      />
    </label>
  );
});
