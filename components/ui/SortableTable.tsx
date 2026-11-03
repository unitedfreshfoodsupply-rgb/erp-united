"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

/**
 * Sorting for the ERP's data tables (UX-04, maturity 2026-11). A table keeps its own markup
 * (`.data-table`, `.num` cells); this adds a header button per sortable column with
 * aria-sort, keyboard operation (it is a real button) and a stable sort. Numbers sort as
 * numbers, text in the reader's collation.
 */
export type SortDir = "asc" | "desc";

export function useSorted<T>(rows: readonly T[], columns: Record<string, (row: T) => string | number | null | undefined>, initial?: { key: string; dir: SortDir }) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initial ?? null);
  const sorted = useMemo(() => {
    if (!sort || !columns[sort.key]) return rows;
    const get = columns[sort.key];
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    return rows
      .map((row, i) => ({ row, i, v: get(row) }))
      .sort((a, b) => {
        const av = a.v, bv = b.v;
        let c: number;
        if (av == null && bv == null) c = 0;
        else if (av == null) c = 1;
        else if (bv == null) c = -1;
        else if (typeof av === "number" && typeof bv === "number") c = av - bv;
        else c = collator.compare(String(av), String(bv));
        if (c === 0) return a.i - b.i;
        return sort.dir === "asc" ? c : -c;
      })
      .map((x) => x.row);
  }, [rows, columns, sort]);
  const toggle = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: typeof columns[key]?.(rows[0] as T) === "number" ? "desc" : "asc" }));
  return { sorted, sort, toggle };
}

/** A header cell whose label sorts the column; `numeric` aligns it with `.num` cells. */
export function SortHeader({ label, sortKey, sort, onSort, numeric, className }: { label: string; sortKey: string; sort: { key: string; dir: SortDir } | null; onSort: (key: string) => void; numeric?: boolean; className?: string }) {
  const active = sort?.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort!.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"} className={[numeric ? "num" : "", className ?? ""].filter(Boolean).join(" ") || undefined}>
      <button type="button" onClick={() => onSort(sortKey)} className={`inline-flex items-center gap-1 font-semibold hover:text-united-dark ${active ? "text-united-dark" : ""}`}>
        {label}
        <Icon size={12} aria-hidden className={active ? "" : "opacity-40"} />
      </button>
    </th>
  );
}
