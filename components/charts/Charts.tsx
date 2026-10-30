"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Table2, BarChart3 } from "lucide-react";
import { useLocale } from "@/lib/locale";

/**
 * Charts — plain SVG/HTML, no chart library (bundle cost ~0).
 *
 * Rules (see docs/erp/DESIGN_SYSTEM.md §9, from the data-viz method):
 *  - one value axis, thin marks, recessive grid; colour by the job (categorical slots 1–2 for
 *    series, one ordinal blue ramp for ordered parts), palettes validated for colour-blind
 *    separation and 3:1 against the white card;
 *  - text never wears the series colour; a legend whenever there are two series or more;
 *  - every chart has a hover/focus tooltip and a table view (the accessible equivalent);
 *  - time runs left → right in both languages (like the printed reports and the numbers),
 *    so the plot area is LTR; labels, legend and tooltip follow the page language.
 */

export const SERIES = ["var(--viz-1)", "var(--viz-2)"] as const;
/** Ordered parts, lightest first: the darkest step goes to the part that needs attention (waste). */
export const ORDINAL = ["var(--viz-ord-3)", "var(--viz-ord-2)", "var(--viz-ord-1)"] as const;

export type Series = { key: string; label: string; color: string; values: number[] };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round tick values: 0 and 3–5 steps of 1/2/2.5/5 × 10^n up to the maximum. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

export function useChartFormat() {
  const { locale } = useLocale();
  const tag = locale === "en" ? "en-GB" : "ar-EG-u-nu-latn";
  const compact = new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 1 });
  const full = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  const dayMonth = new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", timeZone: "UTC" });
  return {
    compact: (n: number) => compact.format(n),
    full: (n: number) => full.format(n),
    week: (iso: string) => dayMonth.format(new Date(`${iso}T00:00:00Z`)),
  };
}

/** Title, subtitle, legend, and a switch between the chart and its table. */
export function ChartCard({ title, subtitle, legend, table, children, footer }: {
  title: string; subtitle?: string; legend?: { label: string; color: string }[]; table: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  const { t } = useLocale();
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <section className="card viz flex min-w-0 flex-col gap-3 p-4 sm:p-5" aria-labelledby={id}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="section-title">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-united-muted">{subtitle}</p>}
        </div>
        <button type="button" className="btn-ghost btn-sm shrink-0" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)} title={asTable ? t("viz.show-chart") : t("viz.show-table")}>
          {asTable ? <BarChart3 size={16} aria-hidden /> : <Table2 size={16} aria-hidden />}
          <span className="sr-only sm:not-sr-only">{asTable ? t("viz.show-chart") : t("viz.show-table")}</span>
        </button>
      </header>
      {legend && legend.length > 1 && !asTable && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-united-muted" aria-label={t("viz.legend")}>
          {legend.map((l) => (
            <li key={l.label} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      {asTable ? <div className="overflow-x-auto">{table}</div> : children}
      {footer}
    </section>
  );
}

const H = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

/** Shared hover state for an indexed plot: pointer, touch and arrow keys move the same index. */
function useIndex(n: number) {
  const [i, setI] = useState<number | null>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowRight") { e.preventDefault(); setI((v) => Math.min(n - 1, v === null ? 0 : v + 1)); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setI((v) => Math.max(0, v === null ? n - 1 : v - 1)); }
    if (e.key === "Escape") setI(null);
  };
  return { i, setI, onKey };
}

function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { label: string; value: string; color: string }[] }) {
  const { locale } = useLocale();
  const flip = x > width - 170;
  return (
    <div
      role="status"
      dir={locale === "ar" ? "rtl" : "ltr"}
      className="pointer-events-none absolute top-1 z-10 min-w-[9rem] rounded-lg border border-united-border bg-white px-3 py-2 text-xs shadow-pop"
      style={flip ? { right: width - x + 10 } : { left: x + 10 }}
    >
      <div className="mb-1 font-semibold text-united-dark">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-united-muted"><span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />{r.label}</span>
          <span className="num font-semibold text-united-dark" dir="ltr">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** `edges`: the first and last labels sit on the plot edges (lines), so they anchor inward. */
function Axes({ w, ticks, y, labels, x, every, edges = false }: { w: number; ticks: number[]; y: (v: number) => number; labels: string[]; x: (i: number) => number; every: number; edges?: boolean }) {
  const f = useChartFormat();
  return (
    <g aria-hidden className="text-[10px]" fill="var(--viz-axis-text)">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--viz-baseline)" : "var(--viz-grid)"} strokeWidth={1} />
          <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">{f.compact(t)}</text>
        </g>
      ))}
      {/* Counted back from the newest week, so the latest label always shows and spacing stays even. */}
      {labels.map((l, i) => (labels.length - 1 - i) % every === 0 && (
        <text key={i} x={x(i)} y={H - 8} textAnchor={edges && i === 0 ? "start" : edges && i === labels.length - 1 ? "end" : "middle"}>{l}</text>
      ))}
    </g>
  );
}

/** Lines over an indexed axis (weeks). Crosshair + tooltip on hover, touch and arrow keys. */
export function LineChart({ labels, series, format, label }: { labels: string[]; series: Series[]; format: (n: number) => string; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = labels.length;
  const { i, setI, onKey } = useIndex(n);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const x = (k: number) => PAD.left + (n <= 1 ? 0 : (k * (w - PAD.left - PAD.right)) / (n - 1));
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));
  const pick = (clientX: number, rect: DOMRect) => {
    const k = Math.round(((clientX - rect.left - PAD.left) / Math.max(1, w - PAD.left - PAD.right)) * (n - 1));
    setI(Math.max(0, Math.min(n - 1, k)));
  };
  return (
    <div ref={ref} dir="ltr" className="relative" onPointerLeave={() => setI(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setI(null)}
          className="block touch-pan-y rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-united-green"
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())} onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}>
          <Axes w={w} ticks={ticks} y={y} labels={labels} x={x} every={every} edges />
          {i !== null && <line x1={x(i)} x2={x(i)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--viz-baseline)" strokeWidth={1} />}
          {series.map((s) => (
            <polyline key={s.key} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, k) => `${x(k)},${y(v)}`).join(" ")} />
          ))}
          {i !== null && series.map((s) => <circle key={s.key} cx={x(i)} cy={y(s.values[i])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />)}
        </svg>
      )}
      {i !== null && w > 0 && <Tooltip x={x(i)} width={w} title={labels[i]} rows={series.map((s) => ({ label: s.label, value: format(s.values[i]), color: s.color }))} />}
    </div>
  );
}

/** Columns over an indexed axis; `stacked` piles the series (parts of one whole) with a 2px gap. */
export function ColumnChart({ labels, series, format, label, stacked = false }: { labels: string[]; series: Series[]; format: (n: number) => string; label: string; stacked?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = labels.length;
  const { i, setI, onKey } = useIndex(n);
  const totals = labels.map((_, k) => series.reduce((s, x) => s + x.values[k], 0));
  const max = stacked ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const band = n ? (w - PAD.left - PAD.right) / n : 0;
  const bar = Math.max(4, Math.min(28, band * 0.6));
  const x = (k: number) => PAD.left + band * (k + 0.5);
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));
  return (
    <div ref={ref} dir="ltr" className="relative" onPointerLeave={() => setI(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setI(null)}
          className="block touch-pan-y rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-united-green">
          <Axes w={w} ticks={ticks} y={y} labels={labels} x={x} every={every} />
          {labels.map((_, k) => {
            let base = 0;
            return (
              <g key={k} opacity={i === null || i === k ? 1 : 0.55}>
                {/* Hit target: the whole band, taller and wider than the bar. */}
                <rect x={PAD.left + band * k} y={PAD.top} width={band} height={H - PAD.top - PAD.bottom} fill="transparent" onPointerEnter={() => setI(k)} onPointerDown={() => setI(k)} />
                {series.map((s, si) => {
                  const v = s.values[k];
                  if (!(v > 0)) return null;
                  const x0 = stacked ? x(k) - bar / 2 : x(k) - bar / 2 + (si - (series.length - 1) / 2) * (bar / series.length + 2);
                  const width = stacked ? bar : bar / series.length;
                  const y1 = y(base + v), y0 = y(base);
                  if (stacked) base += v;
                  const h = Math.max(0, y0 - y1 - (stacked && base > v ? 2 : 0));
                  return <rect key={s.key} x={x0} y={y1} width={width} height={h} rx={stacked && si < series.length - 1 ? 0 : 3} fill={s.color} pointerEvents="none" />;
                })}
              </g>
            );
          })}
        </svg>
      )}
      {i !== null && w > 0 && (
        <Tooltip x={x(i)} width={w} title={labels[i]} rows={[...series].reverse().map((s) => ({ label: s.label, value: format(s.values[i]), color: s.color }))} />
      )}
    </div>
  );
}

/** Ranked horizontal bars in HTML (mirrors naturally in Arabic): label, bar, value. */
export function BarList({ rows, format, color = SERIES[0] }: { rows: { key: string; label: string; value: number; hint?: string }[]; format: (n: number) => string; color?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(6rem,38%)_1fr_auto] items-center gap-3 text-sm" title={r.hint}>
          <span className="truncate text-united-dark">{r.label}</span>
          <span className="h-2.5 rounded-full bg-united-subtle" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="num min-w-[5.5rem] font-semibold text-united-dark" dir="ltr">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The table view of an indexed chart. */
export function ChartTable({ caption, labels, series, format, total }: { caption: string; labels: string[]; series: { label: string; values: number[] }[]; format: (n: number) => string; total?: boolean }) {
  const { t } = useLocale();
  return (
    <table className="data-table">
      <caption className="sr-only">{caption}</caption>
      <thead><tr><th scope="col">{t("viz.period")}</th>{series.map((s) => <th key={s.label} scope="col" className="num">{s.label}</th>)}</tr></thead>
      <tbody>
        {labels.map((l, k) => (
          <tr key={l + k}><th scope="row" className="font-medium">{l}</th>{series.map((s) => <td key={s.label} className="num" dir="ltr">{format(s.values[k])}</td>)}</tr>
        ))}
      </tbody>
      {total && (
        <tfoot><tr><th scope="row">{t("viz.total")}</th>{series.map((s) => <td key={s.label} className="num" dir="ltr">{format(s.values.reduce((a, b) => a + b, 0))}</td>)}</tr></tfoot>
      )}
    </table>
  );
}
