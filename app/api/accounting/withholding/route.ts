import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { withholdingReport } from "@/lib/accounting/cash";
import { todayLocalISO } from "@/lib/localDate";

/** GET ?side=receivable|payable&from=&to= — tax withheld in the period, per document. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const params = new URL(req.url).searchParams;
    const today = todayLocalISO();
    const side = params.get("side") === "payable" ? "payable" : "receivable";
    return NextResponse.json({ report: await withholdingReport(side, params.get("from") ?? `${today.slice(0, 4)}-01-01`, params.get("to") ?? today) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
