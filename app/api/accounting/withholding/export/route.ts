import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { withholdingReport } from "@/lib/accounting/cash";
import { todayLocalISO } from "@/lib/localDate";
import { csvResponse, exportLang, nameIn, toCsv, toCsvColumns, tr } from "@/lib/core/csv-export";

/** Excel-safe CSV of the withholding report, for reconciling certificates or filing. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const params = new URL(req.url).searchParams;
    const today = todayLocalISO();
    const side = params.get("side") === "payable" ? "payable" : "receivable";
    const from = params.get("from") ?? `${today.slice(0, 4)}-01-01`;
    const to = params.get("to") ?? today;
    const r = await withholdingReport(side, from, to);
    // No ?lang: the original output (machine-key header). ?lang=ar|en: titled, translated.
    const lang = exportLang(params);
    const rows: Record<string, unknown>[] = r.rows.map((x) => ({
      date: x.date, document: x.document, party_code: x.party.code, party_name: nameIn(lang ?? "ar", x.party),
      document_amount: x.documentAmount, withheld: x.amount, certificate: x.reference ?? "", account: x.accountCode,
    }));
    rows.push({ date: "", document: tr(lang ?? "ar", "الإجمالي", "Total"), party_code: "", party_name: "", document_amount: "", withheld: r.total, certificate: "", account: "" });
    const columns = [
      { key: "date", ar: "التاريخ", en: "Date" }, { key: "document", ar: "المستند", en: "Document" }, { key: "party_code", ar: "الكود", en: "Code" }, { key: "party_name", ar: "الاسم", en: "Name" },
      { key: "document_amount", ar: "قيمة المستند", en: "Document amount" }, { key: "withheld", ar: "المخصوم", en: "Withheld" }, { key: "certificate", ar: "رقم الشهادة", en: "Certificate" }, { key: "account", ar: "الحساب", en: "Account" },
    ];
    return csvResponse(lang ? toCsvColumns(rows, columns, lang) : toCsv(rows), `withholding-${side}-${from}-${to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}
