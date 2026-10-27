import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { withholdingReport } from "@/lib/accounting/cash";
import { todayLocalISO } from "@/lib/localDate";
import { toCsv, csvResponse } from "@/lib/core/csv-export";

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
    const rows: Record<string, unknown>[] = r.rows.map((x) => ({
      date: x.date, document: x.document, party_code: x.party.code, party_name: x.party.nameAr || x.party.name,
      document_amount: x.documentAmount, withheld: x.amount, certificate: x.reference ?? "", account: x.accountCode,
    }));
    rows.push({ date: "", document: "الإجمالي", party_code: "", party_name: "", document_amount: "", withheld: r.total, certificate: "", account: "" });
    return csvResponse(toCsv(rows), `withholding-${side}-${from}-${to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}
