"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { storageLocationTypeLabel } from "@/lib/core/reference-data";
import { localName } from "@/lib/locale/names";
import { money, qty, unitLabel } from "@/lib/format";
import { useLocale } from "@/lib/locale";

/** Quantities arrive as decimal strings (exact). Display only — never computed on. */
/** Display helpers kept for their many callers; the format itself lives in lib/format.ts. */
export function fmtQty(q: string | number | null | undefined, unit?: string) {
  if (q === null || q === undefined || q === "") return "—";
  const s = qty(q);
  return unit ? `${s} ${unitLabel(unit)}` : s;
}

export function fmtMoney(v: string | number | null | undefined) {
  return money(v);
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

  // UX-02: a mouse user has no scrollbar to reach hidden tabs (the strip hides it), so a
  // small button appears at whichever edge has more tabs behind it.
  const scrollBy = (towardsEnd: boolean) => {
    const el = ref.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    const step = Math.max(160, el.clientWidth * 0.7) * (towardsEnd ? 1 : -1) * (rtl ? -1 : 1);
    el.scrollBy({ left: step, behavior: "smooth" });
  };
  const edgeButton = (towardsEnd: boolean) => (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={() => scrollBy(towardsEnd)}
      className={`absolute top-0 bottom-px z-10 flex w-8 items-center justify-center bg-white/90 text-united-muted hover:text-united-dark ${towardsEnd ? "end-0" : "start-0"}`}
    >
      <span className={`inline-block text-lg leading-none ${towardsEnd ? "rtl:rotate-180" : "ltr:rotate-180"}`}>›</span>
    </button>
  );

  return (
    <div className="u-tabs relative mb-4 border-b border-united-border">
      {edge.start && edgeButton(false)}
      {edge.end && edgeButton(true)}
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
/** The shared labelled field (components/ui/Field.tsx), re-exported for this module's callers. */
export { Field } from "@/components/ui/Field";

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
