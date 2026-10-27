"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { storageLocationTypeLabel } from "@/lib/core/reference-data";
import { localName } from "@/lib/locale/names";
import { activeLocale } from "@/lib/locale/active";
import { useLocale } from "@/lib/locale";

/** Quantities arrive as decimal strings (exact). Display only — never computed on. */
export function fmtQty(q: string | number | null | undefined, unit?: string) {
  if (q === null || q === undefined || q === "") return "—";
  const n = Number(q);
  const s = Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 3 }) : String(q);
  return unit ? `${s} ${unit}` : s;
}

export function fmtMoney(v: string | number | null | undefined) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  // The currency suffix follows the UI language (see lib/locale/active.ts).
  const currency = activeLocale() === "en" ? "EGP" : "ج.م";
  return Number.isFinite(n) ? `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}` : String(v);
}

export type LocationDTO = { id: string; code: string; name: string; nameAr: string | null; type: string; active: boolean };
export type WarehouseDTO = { id: string; code: string; name: string; nameAr: string | null; locations: LocationDTO[] };

/** Active warehouses and their locations, for the pickers. */
export function useLocations() {
  const q = useQuery({
    queryKey: ["stock", "reference"],
    queryFn: () => apiFetch<{ warehouses: WarehouseDTO[]; uoms: { code: string; nameAr: string | null; name: string; category: string }[] }>("/api/core/reference"),
    staleTime: 60_000,
  });
  const warehouses = q.data?.warehouses ?? [];
  return { ...q, warehouses, locations: warehouses.flatMap((w) => w.locations), uoms: q.data?.uoms ?? [] };
}

export const locationTypeLabel = storageLocationTypeLabel;

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string; badge?: number }[] }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`tap-target shrink-0 rounded-xl px-4 font-extrabold text-sm ${value === t.key ? "bg-united-green text-white" : "bg-united-dark/5 text-united-dark"}`}
        >
          {t.label}
          {t.badge ? <span className="ms-2 rounded-full bg-united-danger text-white px-2 text-xs">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-extrabold text-united-muted">{label}</span>
      {children}
    </label>
  );
}

export function LocationSelect({ value, onChange, allowAny, anyLabel }: { value: string; onChange: (v: string) => void; allowAny?: boolean; anyLabel?: string }) {
  const { locations } = useLocations();
  const { locale, t } = useLocale();
  return (
    <select className="field font-bold" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAny ? <option value="">{anyLabel ?? t("stock-move-any-location")}</option> : <option value="">{t("stock.release-select-default")}</option>}
      {locations.map((l) => (
        <option key={l.id} value={l.id}>
          {l.code} · {localName(l, locale)} ({locationTypeLabel(l.type, locale)})
        </option>
      ))}
    </select>
  );
}

export type StockRow = {
  productId: string;
  productName: string;
  productNameAr: string | null;
  unit: string;
  active: boolean;
  onHand: string;
  quarantined: string;
  reserved: string;
  available: string;
  averageCost: string | null;
  stockValue: string | null;
  reorderPointQty: string | null;
  minStockQty: string | null;
  belowReorder: boolean;
  belowMin: boolean;
};

export function ProductSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { locale, t } = useLocale();
  const q = useQuery({
    queryKey: ["stock", "inventory", "stock"],
    queryFn: () => apiFetch<{ rows: StockRow[] }>("/api/inventory/stock"),
    staleTime: 15_000,
  });
  return (
    <select className="field font-bold" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("stock.required-product")}</option>
      {(q.data?.rows ?? []).filter((r) => r.active).map((r) => (
        <option key={r.productId} value={r.productId}>
          {localName({ name: r.productName, nameAr: r.productNameAr }, locale)} — {t("stock.stat.available")} {fmtQty(r.available, r.unit)}
        </option>
      ))}
    </select>
  );
}
