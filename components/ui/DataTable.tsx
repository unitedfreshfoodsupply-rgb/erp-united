"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { EmptyState, ErrorState } from "@/components/States";
import { Pagination } from "@/components/ui/Pagination";
import { SortHeader, useSorted } from "@/components/ui/SortableTable";

/*
 * THE list experience (maturity 2026-11). Every module list is the same three parts:
 *   useListState — search text, filters and page, kept in the URL (a drill-down link or a
 *                  bookmark opens the list exactly as it was; Back works);
 *   FilterBar    — a labelled search box, the module's filters, removable chips, reset;
 *   DataTable    — sticky head, sortable columns, end-aligned figures, totals, row links
 *                  and actions, and the empty / loading / error states.
 * Search, filters and paging run on the server (lib/core/search.ts): the browser never
 * loads a whole table to filter it, and the server applies its permissions first.
 */

export type FilterDef =
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[] }
  | { key: string; label: string; kind: "date-range" };

/** List state in the URL: q, each filter key, from/to, page. */
export function useListState(filterKeys: readonly string[] = [], opts: { pageSize?: number; prefix?: string } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const p = opts.prefix ?? "";
  const read = (k: string) => sp.get(p + k) ?? "";
  const state = { q: read("q"), page: Math.max(1, Number(read("page")) || 1), from: read("from"), to: read("to"), filters: Object.fromEntries(filterKeys.map((k) => [k, read(k)])) as Record<string, string> };
  const set = useCallback(
    (patch: Record<string, string | number | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || v === undefined) next.delete(p + k);
        else next.set(p + k, String(v));
      }
      // Any change but paging starts again at page 1.
      if (!("page" in patch)) next.delete(p + "page");
      router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
    },
    [router, pathname, sp, p]
  );
  const reset = () => set(Object.fromEntries(["q", "from", "to", "page", ...filterKeys].map((k) => [k, null])));
  const pageSize = opts.pageSize ?? 50;
  /** Query string for the API: q, from, to, filters (as given), limit/offset. */
  const apiQuery = (map: Record<string, string> = {}) => {
    const u = new URLSearchParams();
    if (state.q) u.set("q", state.q);
    if (state.from) u.set("from", state.from);
    if (state.to) u.set("to", state.to);
    for (const [k, v] of Object.entries(state.filters)) if (v) u.set(map[k] ?? k, v);
    u.set("limit", String(pageSize));
    u.set("offset", String((state.page - 1) * pageSize));
    return u.toString();
  };
  return { ...state, set, reset, pageSize, apiQuery, active: !!(state.q || state.from || state.to || Object.values(state.filters).some(Boolean)) };
}

/** Fetch a list page for the current state (keeps the previous page on screen while loading). */
export function useListQuery<T>(key: readonly unknown[], url: string | null) {
  return useQuery({ queryKey: [...key, url], queryFn: () => apiFetch<T>(url!), enabled: !!url, placeholderData: keepPreviousData });
}

export function FilterBar({ list, filters = [], searchLabel, searchHint, children }: { list: ReturnType<typeof useListState>; filters?: FilterDef[]; searchLabel?: string; searchHint?: string; children?: ReactNode }) {
  const { t } = useLocale();
  const [text, setText] = useState(list.q);
  const first = useRef(true);
  useEffect(() => setText(list.q), [list.q]);
  // Debounced: the server is asked once the typing pauses.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const h = setTimeout(() => { if (text.trim() !== list.q) list.set({ q: text.trim() || null }); }, 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const chips: { key: string; label: string; clear: Record<string, null> }[] = [];
  if (list.q) chips.push({ key: "q", label: `${t("list.search")}: ${list.q}`, clear: { q: null } });
  for (const f of filters) {
    if (f.kind === "select" && list.filters[f.key]) chips.push({ key: f.key, label: `${f.label}: ${f.options.find((o) => o.value === list.filters[f.key])?.label ?? list.filters[f.key]}`, clear: { [f.key]: null } });
  }
  if (list.from || list.to) chips.push({ key: "dates", label: `${list.from || "…"} → ${list.to || "…"}`, clear: { from: null, to: null } });
  return (
    <div className="flex flex-col gap-2" role="search">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <span className="field-label">{searchLabel ?? t("list.search")}</span>
          <span className="relative">
            <Search size={16} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-united-muted" />
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={searchHint} className="field-sm ps-9" />
          </span>
        </label>
        {filters.map((f) =>
          f.kind === "select" ? (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="field-label">{f.label}</span>
              <select className="field-sm min-w-[9rem]" value={list.filters[f.key] ?? ""} onChange={(e) => list.set({ [f.key]: e.target.value || null })}>
                <option value="">{t("list.all")}</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ) : (
            <fieldset key={f.key} className="flex items-end gap-1">
              <legend className="field-label mb-1">{f.label}</legend>
              <label className="sr-only" htmlFor={`${f.key}-from`}>{t("list.from")}</label>
              <input id={`${f.key}-from`} type="date" className="field-sm" value={list.from} onChange={(e) => list.set({ from: e.target.value || null })} />
              <span aria-hidden className="pb-2 text-united-muted">–</span>
              <label className="sr-only" htmlFor={`${f.key}-to`}>{t("list.to")}</label>
              <input id={`${f.key}-to`} type="date" className="field-sm" value={list.to} onChange={(e) => list.set({ to: e.target.value || null })} />
            </fieldset>
          )
        )}
        {children}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
          {chips.map((c) => (
            <button key={c.key} type="button" onClick={() => list.set(c.clear)} className="filter-pill-inactive gap-1 !min-h-[30px] text-xs" aria-label={`${t("list.remove-filter")}: ${c.label}`}>
              {c.label} <X size={12} aria-hidden />
            </button>
          ))}
          <button type="button" onClick={list.reset} className="text-xs font-semibold text-united-green hover:underline">{t("list.reset")}</button>
        </div>
      )}
    </div>
  );
}

export type Column<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** Sorting value (client-side, within the loaded rows). Omit to make the column unsortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  numeric?: boolean;
  /** Hidden below the tablet breakpoint (secondary detail). */
  secondary?: boolean;
};

export function DataTable<T>({ rows, columns, rowKey, rowHref, onRowOpen, rowActions, totals, loading, error, onRetry, empty, caption, maxHeight = "70vh", initialSort, total, page, pageSize, onPage }: {
  rows: readonly T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string | null;
  /** Opens the row in place (a detail panel) instead of navigating. */
  onRowOpen?: (row: T) => void;
  rowActions?: (row: T) => ReactNode;
  totals?: Record<string, ReactNode>;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: { title: string; hint?: string };
  caption?: string;
  maxHeight?: string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  total?: number;
  page?: number;
  pageSize?: number;
  onPage?: (page: number) => void;
}) {
  const { t } = useLocale();
  const sorters = useMemo(() => Object.fromEntries(columns.filter((c) => c.sortValue).map((c) => [c.key, c.sortValue!])), [columns]);
  const { sorted, sort, toggle } = useSorted(rows ?? [], sorters, initialSort);
  if (error) return <ErrorState message={errorMessage(error)} onRetry={onRetry} />;
  const cols = columns.length + (rowActions ? 1 : 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="card overflow-auto" style={{ maxHeight }} aria-busy={loading || undefined}>
        <table className="data-table">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-[1]">
            <tr>
              {columns.map((c) =>
                c.sortValue ? (
                  <SortHeader key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={toggle} numeric={c.numeric} className={c.secondary ? "hidden md:table-cell" : undefined} />
                ) : (
                  <th key={c.key} className={`${c.numeric ? "num" : ""} ${c.secondary ? "hidden md:table-cell" : ""}`}>{c.label}</th>
                )
              )}
              {rowActions && <th><span className="sr-only">{t("list.actions")}</span></th>}
            </tr>
          </thead>
          <tbody className={loading ? "opacity-60 transition-opacity" : undefined}>
            {loading && !rows?.length &&
              Array.from({ length: 5 }, (_, i) => (
                <tr key={`sk${i}`}>{Array.from({ length: cols }, (_, j) => <td key={j}><span className="block h-3 w-full max-w-[8rem] animate-pulse rounded bg-united-subtle" /></td>)}</tr>
              ))}
            {sorted.map((r) => {
              const href = rowHref?.(r) ?? null;
              return (
                <tr key={rowKey(r)}>
                  {columns.map((c, i) => (
                    <td key={c.key} className={`${c.numeric ? "num" : ""} ${c.secondary ? "hidden md:table-cell" : ""}`} dir={c.numeric ? "ltr" : undefined}>
                      {i === 0 && href ? <Link href={href} className="font-medium text-united-dark hover:text-united-green hover:underline">{c.render(r)}</Link>
                        : i === 0 && onRowOpen ? <button type="button" onClick={() => onRowOpen(r)} className="text-start font-medium text-united-dark hover:text-united-green hover:underline">{c.render(r)}</button>
                        : c.render(r)}
                    </td>
                  ))}
                  {rowActions && <td className="whitespace-nowrap text-end">{rowActions(r)}</td>}
                </tr>
              );
            })}
          </tbody>
          {totals && sorted.length > 0 && (
            <tfoot>
              <tr>
                {columns.map((c, i) => (
                  <td key={c.key} className={`${c.numeric ? "num" : ""} ${c.secondary ? "hidden md:table-cell" : ""}`} dir={c.numeric ? "ltr" : undefined}>{totals[c.key] ?? (i === 0 ? t("list.total") : "")}</td>
                ))}
                {rowActions && <td />}
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && rows && rows.length === 0 && (
          <div className="p-6"><EmptyState title={empty?.title ?? t("list.empty")} />{empty?.hint && <p className="mt-1 text-center text-sm text-united-muted">{empty.hint}</p>}</div>
        )}
      </div>
      {onPage && total !== undefined && pageSize && total > pageSize && <Pagination page={page ?? 1} pageSize={pageSize} total={total} onChange={onPage} />}
    </div>
  );
}
