"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Download, Info, Printer } from "lucide-react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { isValidISODate } from "@/lib/dates";
import { replaceQuery, withParams } from "@/lib/hooks/urlQuery";
import { useLocale } from "@/lib/locale";
import { formatNumber } from "@/lib/format";
import { localName } from "@/lib/locale/names";
import { systemText } from "@/lib/locale/system-text";
import { codedText } from "@/lib/reports/labels";
import { todayLocalISO } from "@/lib/localDate";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ErrorState } from "@/components/States";
import { CardSkeleton } from "@/components/Skeleton";
import { useToast } from "@/components/ui/Toast";

type Bi = { ar: string; en: string };
type Col = { key: string; label: Bi; type: "text" | "code" | "date" | "money" | "qty" | "number" | "percent"; total?: boolean; labels?: string };
type Row = Record<string, string | number | null> & { _href?: string | null; _tone?: "warn" | "danger" | null };
type Ran = { key: string; title: Bi; description: Bi; notes: Bi | null; filters: string[]; params: Record<string, string>; columns: Col[]; rows: Row[]; totals: Record<string, string | number | null>; warnings: Bi[]; scope: Bi | null };

/** The URL keys of each filter (the API reads the same names). */
const FILTER_PARAM: Record<string, string> = { customer: "customer_id", supplier: "supplier_id", product: "product_id", category: "category", account: "account_id", cashAccount: "cash_account_id", groupBy: "group_by", days: "days" };

/**
 * One viewer for every report (maturity 2026-11): filters in the URL (shareable, Back
 * works), period presets, totals, warnings when a figure is incomplete, how it is
 * calculated, drill-down to the source, print, and CSV / Excel in Arabic or English.
 */
export function ReportViewer({ reportKey }: { reportKey: string }) {
  const { t, locale } = useLocale();
  const lang = locale === "en" ? "en" : "ar";
  const sp = useSearchParams();
  const toast = useToast();
  const qs = sp.toString();
  const q = useQuery({ queryKey: ["report", reportKey, qs], queryFn: () => apiFetch<Ran>(`/api/reports/${reportKey}${qs ? `?${qs}` : ""}`), placeholderData: keepPreviousData });
  // Written in place from the current address (lib/hooks/urlQuery.ts): no server round trip
  // before the report's own request, and a second quick change does not drop the first.
  const set = (patch: Record<string, string | null>) => replaceQuery(withParams(window.location.search, patch));
  // The last result that loaded stays on screen when a filter is refused (the error shows above
  // the table, with the filters to correct it), instead of the whole viewer disappearing.
  const [last, setLast] = useState<Ran>();
  useEffect(() => { if (q.data) setLast(q.data); }, [q.data]);
  const r = [q.data, last].find((x) => x?.key === reportKey);
  const has = (f: string) => !!r?.filters.includes(f);

  // What is typed in the period and days fields: sent to the URL only once it is a valid filter,
  // so a half-typed date or number is neither replaced by the last response nor sent to be refused.
  const [draft, setDraft] = useState({ from: "", to: "", days: "" });
  const [pFrom, pTo, pDays] = [r?.params.from ?? "", r?.params.to ?? "", r ? String(r.params.days) : ""];
  useEffect(() => { setDraft((d) => ({ ...d, from: pFrom })); }, [pFrom]);
  useEffect(() => { setDraft((d) => ({ ...d, to: pTo })); }, [pTo]);
  useEffect(() => { setDraft((d) => ({ ...d, days: pDays })); }, [pDays]);
  const period = (patch: { from?: string; to?: string }) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (isValidISODate(next.from) && isValidISODate(next.to) && next.from <= next.to) set({ from: next.from, to: next.to });
  };
  const daysOk = (v: string) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 365;
  const inverted = isValidISODate(draft.from) && isValidISODate(draft.to) && draft.from > draft.to;

  // Names come in both languages (x_ar / x_en, for the exports); the screen shows the reader's one.
  const keys = new Set(r?.columns.map((c) => c.key));
  const twin = (k: string) => (k.endsWith("_ar") ? `${k.slice(0, -3)}_en` : k.endsWith("_en") ? `${k.slice(0, -3)}_ar` : null);
  const cols = r ? r.columns.filter((c) => { const tw = twin(c.key); return !tw || !keys.has(tw) || c.key.endsWith(lang === "ar" ? "_ar" : "_en"); }) : [];
  const fmt = (c: Col, v: unknown) => {
    if (v === null || v === undefined || v === "") return "—";
    // A stored status code reads as its words ("ready_for_loading" → جاهز للتحميل / Ready for Loading).
    const coded = codedText(c, v, lang);
    if (coded) return coded;
    if (c.type === "money") return formatNumber(v as string, { minDp: 2, maxDp: 2 });
    if (c.type === "qty") return formatNumber(v as number, { maxDp: 3 });
    if (c.type === "number") return formatNumber(v as number, { maxDp: 1 });
    if (c.type === "percent") return `${formatNumber(v as number, { maxDp: 1 })}%`;
    if (c.type === "text" && !/_(ar|en)$/.test(c.key)) return systemText(String(v), lang);
    return String(v);
  };
  const columns: Column<Row>[] = cols.map((c) => ({
    key: c.key,
    label: c.key === "name_ar" || c.key === "name_en" ? (lang === "ar" ? "الاسم" : "Name") : c.label[lang],
    numeric: ["money", "qty", "number", "percent"].includes(c.type),
    sortValue: (row) => (["money", "qty", "number", "percent"].includes(c.type) ? Number(row[c.key] ?? 0) : String(row[c.key] ?? "")),
    render: (row) => <span dir={c.type === "code" || c.type === "date" ? "ltr" : undefined} className={[c.type === "code" || c.type === "date" ? "whitespace-nowrap" : "", row._tone === "danger" ? "font-semibold text-united-danger" : row._tone === "warn" ? "text-united-warn" : ""].filter(Boolean).join(" ") || undefined}>{fmt(c, row[c.key])}</span>,
  }));
  const totals = r && Object.keys(r.totals).length ? Object.fromEntries(cols.filter((c) => r.totals[c.key] !== undefined).map((c) => [c.key, <span key={c.key} className="font-semibold">{fmt(c, r.totals[c.key])}</span>])) : undefined;

  async function download(format: "csv" | "xls", l: "ar" | "en") {
    try {
      const token = window.sessionStorage.getItem("united_token");
      const res = await fetch(`/api/reports/${reportKey}/export?${new URLSearchParams({ ...Object.fromEntries(sp), format, lang: l })}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Accept-Language": lang } });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `${reportKey}.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : t("ui.error.generic"), "error");
    }
  }

  const today = todayLocalISO();
  const presets: [string, string, string][] = [
    [t("reports.preset.this-month"), `${today.slice(0, 7)}-01`, today],
    [t("reports.preset.last-month"), ...lastMonth(today)] as [string, string, string],
    [t("reports.preset.last-30"), shift(today, -29), today],
    [t("reports.preset.this-year"), `${today.slice(0, 4)}-01-01`, today],
  ];

  return (
    <div className="page-container">
      <div className="no-print flex items-center justify-between gap-2">
        <Link href="/reports" className="inline-flex min-h-[44px] items-center gap-1.5 font-medium text-united-muted hover:text-united-dark"><ArrowLeft size={16} className="rtl:rotate-180" aria-hidden /> {t("reports.back")}</Link>
        {r && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => window.print()}><Printer size={15} aria-hidden /> {t("reports.print")}</button>
            <ExportMenu onPick={download} t={t} />
          </div>
        )}
      </div>
      {/* Until the first result arrives: a loading state, not an empty page. */}
      {q.isPending && !r && (
        <div className="flex flex-col gap-3">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={6} />
        </div>
      )}
      {/* A refusal (no permission, unknown report) is final: no Retry; the back link stays. */}
      {q.isError && !r && <ErrorState message={errorMessage(q.error) ?? t("ui.error.generic")} onRetry={refusal(q.error) ? undefined : () => q.refetch()} />}
      {r && (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="page-title">{r.title[lang]}</h1>
            <p className="page-subtitle">{r.description[lang]}</p>
            {/* The line follows the page direction; the range itself is one left-to-right run. */}
            {has("period") && <p className="text-sm font-semibold text-united-dark"><bdi dir="ltr">{r.params.from} → {r.params.to}</bdi></p>}
            {r.scope && <p className="text-sm font-semibold text-united-dark">{r.scope[lang]}</p>}
          </header>
          <section className="no-print card flex flex-wrap items-end gap-3 p-4" aria-label={t("reports.filters")}>
            {has("period") && (
              <>
                <label className="flex flex-col gap-1"><span className="field-label">{t("list.from")}</span><input type="date" className="field-sm" value={draft.from} aria-invalid={inverted || undefined} onChange={(e) => period({ from: e.target.value })} onBlur={() => { if (!isValidISODate(draft.from)) setDraft({ ...draft, from: pFrom }); }} /></label>
                <label className="flex flex-col gap-1"><span className="field-label">{t("list.to")}</span><input type="date" className="field-sm" value={draft.to} aria-invalid={inverted || undefined} onChange={(e) => period({ to: e.target.value })} onBlur={() => { if (!isValidISODate(draft.to)) setDraft({ ...draft, to: pTo }); }} /></label>
                <div className="flex flex-wrap gap-1" role="group" aria-label={t("reports.presets")}>
                  {presets.map(([label, from, to]) => (
                    <button key={label} type="button" aria-pressed={r.params.from === from && r.params.to === to} className="chip !min-h-[36px] text-xs" onClick={() => period({ from, to })}>{label}</button>
                  ))}
                </div>
                {inverted && <p className="basis-full text-xs font-semibold text-united-danger" role="alert">{t("reports.range-invalid")}</p>}
              </>
            )}
            {has("groupBy") && (
              <label className="flex flex-col gap-1"><span className="field-label">{t("reports.group-by")}</span>
                <select className="field-sm" value={r.params.groupBy} onChange={(e) => set({ group_by: e.target.value })}>
                  {(["day", "week", "month", "year"] as const).map((g) => <option key={g} value={g}>{t(`reports.group.${g}`)}</option>)}
                </select>
              </label>
            )}
            {has("days") && <label className="flex flex-col gap-1"><span className="field-label">{t("reports.days")}</span><input type="number" min={0} max={365} className="field-sm w-24" value={draft.days} onChange={(e) => { setDraft({ ...draft, days: e.target.value }); if (daysOk(e.target.value)) set({ days: e.target.value }); }} onBlur={() => { if (!daysOk(draft.days)) setDraft({ ...draft, days: pDays }); }} /></label>}
            {(["customer", "supplier", "product", "category", "account", "cashAccount"] as const).filter(has).map((f) => (
              <PartyFilter key={f} kind={f} value={sp.get(FILTER_PARAM[f]) ?? ""} onChange={(v) => set({ [FILTER_PARAM[f]]: v || null })} />
            ))}
          </section>
          {q.isError && (
            <div className="card flex flex-wrap items-center justify-between gap-2 border-s-4 !border-s-united-danger p-3" role="alert">
              <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-united-danger"><AlertTriangle size={15} aria-hidden /> {errorMessage(q.error) ?? t("ui.error.generic")}</p>
              <button type="button" className="btn-secondary btn-sm" onClick={() => q.refetch()}>{t("ui.retry")}</button>
            </div>
          )}
          {r.warnings.length > 0 && (
            <div className="card flex flex-col gap-1 border-s-4 !border-s-united-warn p-3" role="status">
              {r.warnings.map((w, i) => <p key={i} className="inline-flex items-center gap-1.5 text-sm font-semibold text-united-warn"><AlertTriangle size={15} aria-hidden /> {w[lang]}</p>)}
            </div>
          )}
          <DataTable
            rows={r.rows}
            columns={columns}
            rowKey={(row) => r.rows.indexOf(row).toString()}
            rowHref={(row) => row._href ?? null}
            totals={totals}
            loading={q.isFetching}
            empty={{ title: t("reports.empty") }}
            caption={r.title[lang]}
            maxHeight="none"
          />
          {r.notes && <p className="inline-flex items-start gap-1.5 text-xs text-united-muted"><Info size={14} className="mt-0.5 shrink-0" aria-hidden /> {r.notes[lang]}</p>}
          <p className="print-only text-xs">{t("reports.printed", { date: new Date().toLocaleString(lang === "en" ? "en-GB" : "ar-EG-u-nu-latn") })}</p>
        </>
      )}
    </div>
  );
}

/** A 4xx other than a timeout or rate limit: asking again gives the same answer. */
function refusal(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  return !!status && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function ExportMenu({ onPick, t }: { onPick: (f: "csv" | "xls", l: "ar" | "en") => void; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className="btn-secondary btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Download size={15} aria-hidden /> {t("reports.export")}</button>
      {open && (
        <div role="menu" className="absolute end-0 z-20 mt-1 flex w-52 flex-col rounded-xl border border-united-border bg-white p-1 shadow-pop">
          {([["xls", "ar"], ["xls", "en"], ["csv", "ar"], ["csv", "en"]] as const).map(([f, l]) => (
            <button key={`${f}${l}`} role="menuitem" type="button" className="rounded-lg px-3 py-2 text-start text-sm hover:bg-united-subtle" onClick={() => { setOpen(false); onPick(f, l); }}>
              {t(`reports.export.${f}`)} · {l === "ar" ? "عربي" : "English"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A select of customers / suppliers / products / categories / accounts / cash accounts — from the existing APIs (hidden when the user may not read them). */
function PartyFilter({ kind, value, onChange }: { kind: "customer" | "supplier" | "product" | "category" | "account" | "cashAccount"; value: string; onChange: (v: string) => void }) {
  const { t, locale } = useLocale();
  const src: Record<typeof kind, string> = { customer: "/api/sales/customers?limit=500", supplier: "/api/purchasing/suppliers", product: "/api/stock/products", category: "/api/stock/products", account: "/api/accounting/accounts", cashAccount: "/api/accounting/cash-accounts" };
  const q = useQuery({ queryKey: ["report-filter", kind], queryFn: () => apiFetch<Record<string, { id: string; code?: string; name: string; nameAr?: string | null; category?: string | null; postable?: boolean }[]>>(src[kind]), staleTime: 300_000, retry: false });
  if (q.isError) return null;
  const list = (q.data ? Object.values(q.data).find(Array.isArray) ?? [] : []) as { id: string; code?: string; name: string; nameAr?: string | null; category?: string | null; postable?: boolean }[];
  const options = kind === "category"
    ? [...new Set(list.map((p) => p.category).filter((c): c is string => !!c))].sort().map((c) => ({ value: c, label: c }))
    : list.filter((x) => kind !== "account" || x.postable !== false).map((x) => ({ value: x.id, label: `${x.code ? `${x.code} · ` : ""}${localName({ name: x.name, nameAr: x.nameAr ?? null }, locale)}` }));
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label">{t(`reports.filter.${kind}`)}</span>
      <select className="field-sm min-w-[12rem]" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{kind === "account" ? t("reports.choose") : t("list.all")}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function shift(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function lastMonth(today: string): [string, string] {
  const [y, m] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1));
  const end = new Date(Date.UTC(y, m - 1, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}
