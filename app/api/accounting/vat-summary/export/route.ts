import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { vatSummary } from "@/lib/accounting/vat-summary";
import { todayLocalISO } from "@/lib/localDate";
import { csvResponse, exportLang, toCsv, toCsvColumns, tr } from "@/lib/core/csv-export";

/** Excel-safe CSV export of the VAT summary for a date range. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const params = new URL(req.url).searchParams;
    const today = todayLocalISO();
    const from = params.get("from") ?? `${today.slice(0, 4)}-01-01`;
    const to = params.get("to") ?? today;
    const s = await vatSummary(from, to);
    // No ?lang: the original output (machine-key header). ?lang=ar|en: titled, translated.
    const lang = exportLang(params);
    const L = lang ?? "ar";
    const rows: Record<string, unknown>[] = [
      { section: tr(L, `ملخص ضريبة القيمة المضافة من ${s.from} إلى ${s.to}`, `VAT summary ${s.from} to ${s.to}`), output: "", input: "", diff: "" },
      { section: tr(L, "الإجمالي", "Total"), output: s.totals.outputTax, input: s.totals.inputTax, diff: s.totals.netPayable },
    ];
    for (const l of s.lines) rows.push({ section: `  ${lang === "en" ? l.taxNameEn : l.taxName} (${l.taxCode} @${l.rate}%)`, output: l.outputTax, input: l.inputTax, diff: "" });
    rows.push({ section: tr(L, "التسوية مع الأستاذ", "Reconciliation with the ledger"), output: s.ledger.reconciled ? tr(L, "مطابق", "Reconciled") : tr(L, "فيه فرق", "Difference"), input: "", diff: "" });
    const columns = [{ key: "section", ar: "البند", en: "Item" }, { key: "output", ar: "ضريبة المبيعات", en: "Output tax" }, { key: "input", ar: "ضريبة المشتريات", en: "Input tax" }, { key: "diff", ar: "الصافي المستحق", en: "Net payable" }];
    return csvResponse(lang ? toCsvColumns(rows, columns, lang) : toCsv(rows), `vat-summary-${from}-${to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}