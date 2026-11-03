import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { financeReport } from "@/lib/management/reports";
import { csvResponse, exportLang, nameIn, toCsvColumns, tr } from "@/lib/core/csv-export";
import { printT } from "@/lib/locale/print";

/** Excel-safe CSV export of the management finance report (sales by product, P&L, aging, movement). */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.finance");
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from") ?? undefined;
    const to = sp.get("to") ?? undefined;
    const r = await financeReport({ from, to });

    const lang = exportLang(sp);
    const T = printT(lang);
    const kind = (k: string) => { const key = `stock.movement.${k}`; const v = T(key); return v === key ? k : v; };
    const rows: Record<string, unknown>[] = [];
    rows.push({ section: tr(lang, `تقرير مالي من ${r.from} إلى ${r.to}`, `Finance report ${r.from} to ${r.to}`), amount: "", extra: "" });
    rows.push({ section: tr(lang, "المبيعات", "Sales"), amount: r.sales.revenue, extra: tr(lang, `تكلفة ${r.sales.cost} · هامش ${r.sales.grossMargin}`, `cost ${r.sales.cost} · margin ${r.sales.grossMargin}`) });
    for (const p of r.sales.byProduct) rows.push({ section: `  ${tr(lang, "بند", "Item")}: ${lang === "en" ? p.productNameEn || p.product : p.productNameAr || p.product}`, amount: p.revenue, extra: tr(lang, `تكلفة ${p.cost} · هامش ${p.margin}`, `cost ${p.cost} · margin ${p.margin}`) });
    rows.push({ section: tr(lang, "أرباح/خسائر", "Profit / loss"), amount: r.profitAndLoss.net, extra: tr(lang, `إيرادات ${r.profitAndLoss.revenue} · مصروفات ${r.profitAndLoss.expenses}`, `revenue ${r.profitAndLoss.revenue} · expenses ${r.profitAndLoss.expenses}`) });
    for (const l of r.profitAndLoss.lines) rows.push({ section: `  ${l.code} ${lang === "en" ? l.nameEn || l.name : l.nameAr || l.name}`, amount: l.amount, extra: l.type });
    rows.push({ section: tr(lang, "عملاء (كبار)", "Customers (largest)"), amount: r.receivables.totals.total, extra: "" });
    for (const t of r.receivables.top) rows.push({ section: `  ${nameIn(lang, t.customer)}`, amount: t.total, extra: "" });
    rows.push({ section: tr(lang, "موردون (كبار)", "Suppliers (largest)"), amount: r.payables.totals.total, extra: "" });
    for (const t of r.payables.top) rows.push({ section: `  ${nameIn(lang, t.supplier)}`, amount: t.total, extra: "" });
    rows.push({ section: tr(lang, "المخزون", "Inventory"), amount: r.inventory.value, extra: "" });
    for (const t of r.inventory.top) rows.push({ section: `  ${lang === "en" ? t.productNameEn || t.product : t.productNameAr || t.product}`, amount: t.value, extra: `${t.quantity} ${t.unit}` });
    rows.push({ section: tr(lang, "حركة المخزون", "Stock movement"), amount: "", extra: "" });
    for (const m of r.stockMovement) rows.push({ section: `  ${kind(m.kind)}`, amount: m.value, extra: m.quantity });
    const columns = [{ key: "section", ar: "البند", en: "Item" }, { key: "amount", ar: "المبلغ", en: "Amount" }, { key: "extra", ar: "تفاصيل", en: "Details" }];

    return csvResponse(toCsvColumns(rows, columns, lang), `finance-report-${r.from}-${r.to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}