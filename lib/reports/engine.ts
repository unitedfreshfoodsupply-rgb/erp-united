import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/rbac";
import { isValidISODate } from "@/lib/dates";
import { todayLocalISO } from "@/lib/localDate";
import { REPORTS, reportByKey } from "@/lib/reports/definitions";
import { mayOpenLink } from "@/lib/reports/page-access";
import type { ReportColumn, ReportDef, ReportParams, ReportResult } from "@/lib/reports/types";
import type { Permission } from "@/lib/permissions";
import { systemText } from "@/lib/locale/system-text";
import { csvCell } from "@/lib/core/csv-export";

type Viewer = { can: (p: Permission) => boolean };

const mayRun = (def: ReportDef, viewer: Viewer) => def.permissions.some((p) => viewer.can(p));

/** A link the viewer can follow: its page's gate (page-access.ts) and, for another report, that report's own permissions. */
function mayFollow(href: string, viewer: Viewer) {
  if (!mayOpenLink(href, (p) => viewer.can(p))) return false;
  const key = /^\/reports\/([^/?#]+)/.exec(href)?.[1];
  const target = key ? reportByKey(key) : null;
  return !key || (!!target && mayRun(target, viewer));
}

/** The catalogue a user sees: only reports they may open — a linked one only when they can open its screen too. */
export function reportCatalogue(viewer: Viewer) {
  return REPORTS.filter((r) => mayRun(r, viewer) && (!r.href || mayFollow(r.href, viewer))).map((r) => ({ key: r.key, category: r.category, title: r.title, description: r.description, href: r.href ?? null }));
}

/** Filters from a URL, validated, with defaults: this month to date, monthly, 7 days. */
export function reportParams(sp: URLSearchParams): ReportParams {
  const today = todayLocalISO();
  const from = sp.get("from") || `${today.slice(0, 7)}-01`;
  const to = sp.get("to") || today;
  if (!isValidISODate(from) || !isValidISODate(to)) throw new ApiError(400, "التاريخ لازم يكون YYYY-MM-DD");
  if (from > to) throw new ApiError(400, "تاريخ البداية بعد تاريخ النهاية");
  const g = sp.get("group_by");
  const days = Number(sp.get("days") || 7);
  const id = (k: string) => { const v = sp.get(k); return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined; };
  const category = sp.get("category")?.trim().slice(0, 100) || undefined;
  return {
    from, to, category,
    customerId: id("customer_id"), supplierId: id("supplier_id"), productId: id("product_id"), accountId: id("account_id"), cashAccountId: id("cash_account_id"),
    groupBy: g === "day" || g === "week" || g === "year" ? g : "month",
    days: Number.isInteger(days) && days >= 0 && days <= 365 ? days : 7,
  };
}

export const columnsOf = (def: ReportDef, p: ReportParams): ReportColumn[] => (typeof def.columns === "function" ? def.columns(p) : def.columns);

/** Runs a report for a viewer; totals are the sums of the total-columns unless the report sets them. */
export async function runReport(key: string, p: ReportParams, viewer: Viewer) {
  const def = reportByKey(key);
  if (!def || !def.run) throw new ApiError(404, "التقرير مش موجود");
  if (!mayRun(def, viewer)) throw new ApiError(403, "مالكش صلاحية تشوف التقرير ده");
  const result: ReportResult = await def.run(p);
  // Cost columns follow the stock-valuation permission, as every stock response does (redact.ts).
  const all = columnsOf(def, p);
  const hidden = viewer.can("stock.valuation.view") ? [] : all.filter((c) => c.cost).map((c) => c.key);
  const columns = all.filter((c) => !hidden.includes(c.key));
  if (hidden.length) {
    for (const row of result.rows) for (const k of hidden) delete row[k];
    for (const k of hidden) delete result.totals?.[k];
  }
  // A drill-down the viewer cannot open is dropped: the row stays, without the link.
  for (const row of result.rows) if (row._href && !mayFollow(row._href, viewer)) row._href = null;
  const totals: Record<string, string | number | null> = {};
  for (const c of columns.filter((c) => c.total)) {
    const sum = result.rows.reduce((s, r) => s.plus(new Prisma.Decimal(r[c.key] ?? 0)), new Prisma.Decimal(0));
    totals[c.key] = c.type === "money" ? sum.toFixed(2) : c.type === "qty" ? Number(sum.toFixed(3)) : Number(sum.toFixed(0));
  }
  return {
    key: def.key, category: def.category, title: def.title, description: def.description, notes: def.notes ?? null, filters: def.filters,
    params: p, columns, rows: result.rows, totals: { ...totals, ...(result.totals ?? {}) }, warnings: result.warnings ?? [], scope: result.scope ?? null,
  };
}

type Ran = Awaited<ReturnType<typeof runReport>>;
/** Stored system text ("رصيد أول المدة", movement kinds…) in the export's language; names and user text stay as stored. */
const localRows = (r: Ran, lang: "ar" | "en") => (lang === "ar" ? r.rows : r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && r.columns.some((c) => c.key === k && c.type === "text" && !/_(ar|en)$/.test(k)) ? systemText(v, lang) : v]))));
const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** CSV in the chosen language: UTF-8 with a BOM (Excel opens Arabic correctly), header row, rows, totals row. */
export function reportCsv(r: Ran, lang: "ar" | "en") {
  const head = r.columns.map((c) => c.label[lang]);
  const lines = [head, ...localRows(r, lang).map((row) => r.columns.map((c) => cell(row[c.key])))];
  if (Object.keys(r.totals).length) lines.push(r.columns.map((c, i) => (i === 0 ? (lang === "ar" ? "الإجمالي" : "Total") : cell(r.totals[c.key]))));
  return "﻿" + lines.map((l) => l.map((x) => csvCell(x)).join(",")).join("\r\n") + "\r\n";
}

/**
 * Excel workbook (SpreadsheetML 2003 — opens in Excel and LibreOffice, no library needed):
 * a title, the period, typed cells (numbers stay numbers), a totals row; right-to-left in Arabic.
 */
export function reportXls(r: Ran, lang: "ar" | "en") {
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const numeric = (c: ReportColumn) => ["money", "qty", "number", "percent"].includes(c.type);
  const data = (c: ReportColumn, v: unknown) => (v === null || v === undefined || v === "" ? `<Cell/>` : numeric(c) && !isNaN(Number(v)) ? `<Cell${c.type === "money" ? ' ss:StyleID="m"' : ""}><Data ss:Type="Number">${Number(v)}</Data></Cell>` : `<Cell><Data ss:Type="String">${x(String(v))}</Data></Cell>`);
  const rows = [
    `<Row><Cell ss:StyleID="t"><Data ss:Type="String">${x(r.title[lang])}</Data></Cell></Row>`,
    `<Row><Cell><Data ss:Type="String">${x(`${r.params.from} → ${r.params.to}`)}</Data></Cell></Row>`,
    ...(r.scope ? [`<Row><Cell><Data ss:Type="String">${x(r.scope[lang])}</Data></Cell></Row>`] : []),
    `<Row>${r.columns.map((c) => `<Cell ss:StyleID="h"><Data ss:Type="String">${x(c.label[lang])}</Data></Cell>`).join("")}</Row>`,
    ...localRows(r, lang).map((row) => `<Row>${r.columns.map((c) => data(c, row[c.key])).join("")}</Row>`),
    ...(Object.keys(r.totals).length ? [`<Row>${r.columns.map((c, i) => (i === 0 ? `<Cell ss:StyleID="h"><Data ss:Type="String">${lang === "ar" ? "الإجمالي" : "Total"}</Data></Cell>` : data(c, r.totals[c.key]))).join("")}</Row>`] : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="t"><Font ss:Bold="1" ss:Size="13"/></Style><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#EEF2ED" ss:Pattern="Solid"/></Style><Style ss:ID="m"><NumberFormat ss:Format="#,##0.00"/></Style></Styles>
<Worksheet ss:Name="${x(r.key.slice(0, 31))}"${lang === "ar" ? ' ss:RightToLeft="1"' : ""}><Table>${rows.join("")}</Table></Worksheet>
</Workbook>`;
}
