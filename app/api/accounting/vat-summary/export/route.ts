import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { vatSummary } from "@/lib/accounting/vat-summary";
import { todayLocalISO } from "@/lib/localDate";
import { csvResponse, exportLang, toCsvColumns, tr } from "@/lib/core/csv-export";

/** Excel-safe CSV export of the VAT summary for a date range. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const params = new URL(req.url).searchParams;
    const today = todayLocalISO();
    const from = params.get("from") ?? `${today.slice(0, 4)}-01-01`;
    const to = params.get("to") ?? today;
    const s = await vatSummary(from, to);
    const lang = exportLang(params);
    const rows: Record<string, unknown>[] = [
      { section: tr(lang, `ملخص ضريبة القيمة المضافة من ${s.from} إلى ${s.to}`, `VAT summary ${s.from} to ${s.to}`), output: "", input: "", diff: "" },
      { section: tr(lang, "الإجمالي", "Total"), output: s.totals.outputTax, input: s.totals.inputTax, diff: s.totals.netPayable },
    ];
    for (const l of s.lines) rows.push({ section: `  ${lang === "en" ? l.taxNameEn : l.taxName} (${l.taxCode} @${l.rate}%)`, output: l.outputTax, input: l.inputTax, diff: "" });
    rows.push({ section: tr(lang, "التسوية مع الأستاذ", "Reconciliation with the ledger"), output: s.ledger.reconciled ? tr(lang, "مطابق", "Reconciled") : tr(lang, "فيه فرق", "Difference"), input: "", diff: "" });
    const columns = [{ key: "section", ar: "البند", en: "Item" }, { key: "output", ar: "ضريبة المبيعات", en: "Output tax" }, { key: "input", ar: "ضريبة المشتريات", en: "Input tax" }, { key: "diff", ar: "الصافي المستحق", en: "Net payable" }];
    return csvResponse(toCsvColumns(rows, columns, lang), `vat-summary-${from}-${to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}