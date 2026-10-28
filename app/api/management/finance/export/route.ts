import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { financeReport } from "@/lib/management/reports";
import { toCsv, csvResponse } from "@/lib/core/csv-export";

/** Excel-safe CSV export of the management finance report (sales by product, P&L, aging, movement). */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.finance");
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from") ?? undefined;
    const to = sp.get("to") ?? undefined;
    const r = await financeReport({ from, to });

    const rows: Record<string, unknown>[] = [];
    rows.push({ section: `تقرير مالي من ${r.from} إلى ${r.to}`, amount: "", extra: "" });
    rows.push({ section: "المبيعات", amount: r.sales.revenue, extra: `تكلفة ${r.sales.cost} · هامش ${r.sales.grossMargin}` });
    for (const p of r.sales.byProduct) rows.push({ section: `  بند: ${p.product}`, amount: p.revenue, extra: `تكلفة ${p.cost} · هامش ${p.margin}` });
    rows.push({ section: "أرباح/خسائر", amount: r.profitAndLoss.net, extra: `إيرادات ${r.profitAndLoss.revenue} · مصروفات ${r.profitAndLoss.expenses}` });
    for (const l of r.profitAndLoss.lines) rows.push({ section: `  ${l.code} ${l.name}`, amount: l.amount, extra: l.type });
    rows.push({ section: "عملاء (كبار)", amount: r.receivables.totals.total, extra: "" });
    for (const t of r.receivables.top) rows.push({ section: `  ${t.customer.name}`, amount: t.total, extra: "" });
    rows.push({ section: "موردون (كبار)", amount: r.payables.totals.total, extra: "" });
    for (const t of r.payables.top) rows.push({ section: `  ${t.supplier.name}`, amount: t.total, extra: "" });
    rows.push({ section: "المخزون", amount: r.inventory.value, extra: "" });
    for (const t of r.inventory.top) rows.push({ section: `  ${t.product}`, amount: t.value, extra: `${t.quantity} ${t.unit}` });
    rows.push({ section: "حركة المخزون", amount: "", extra: "" });
    for (const m of r.stockMovement) rows.push({ section: `  ${m.kind}`, amount: m.value, extra: m.quantity });

    return csvResponse(toCsv(rows), `finance-report-${r.from}-${r.to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}