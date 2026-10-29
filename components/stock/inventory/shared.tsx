"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * The one tab bar every module uses. An underlined row (ARIA tabs pattern: arrow keys move
 * between tabs, mirrored in RTL; Home/End jump), scrolling sideways inside itself when the
 * labels do not fit, with a fade on whichever edge still hides tabs so the overflow is visible.
 */
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string; badge?: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const pos = Math.abs(el.scrollLeft); // negative in RTL
    setEdge({ start: pos > 2, end: max - pos > 2 });
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, items.length]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((x) => x.key === value);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    let next = -1;
    if (e.key === "ArrowRight") next = rtl ? i - 1 : i + 1;
    else if (e.key === "ArrowLeft") next = rtl ? i + 1 : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    const k = items[(next + items.length) % items.length].key;
    onChange(k);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  const fade = edge.start || edge.end
    ? `linear-gradient(to var(--u-tabs-end), ${edge.start ? "transparent 0, #000 2.5rem" : "#000 0"}, ${edge.end ? "#000 calc(100% - 2.5rem), transparent 100%" : "#000 100%"})`
    : undefined;

  return (
    <div className="u-tabs mb-4 border-b border-united-border">
      <div
        ref={ref}
        role="tablist"
        onScroll={measure}
        onKeyDown={onKeyDown}
        className="no-scrollbar -mb-px flex gap-1 overflow-x-auto"
        style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      >
        {items.map((t) => {
          const active = value === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(t.key)}
              className={`inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap border-b-2 px-3.5 text-sm transition-colors ${
                active ? "border-united-green font-semibold text-united-dark" : "border-transparent font-medium text-united-muted hover:border-united-border-strong hover:text-united-dark"
              }`}
            >
              {t.label}
              {t.badge ? <span className="ms-2 rounded-full bg-united-danger px-1.5 text-xs font-semibold text-white">{t.badge}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A labelled form control. `required` adds a visible marker (the control itself should also
 * carry `required` / `aria-required`); `hint` is a short line under the control. */
export function Field({ label, children, required, hint }: { label: string; children: React.ReactNode; required?: boolean; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="field-label">
        {label}
        {required && <span aria-hidden className="ms-0.5 text-united-danger">*</span>}
      </span>
      {children}
      {hint && <span className="text-xs text-united-muted">{hint}</span>}
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
          {localName(l, locale)} ({locationTypeLabel(l.type, locale)})
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
