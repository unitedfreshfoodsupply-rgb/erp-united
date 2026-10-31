import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { costCenterReport } from "@/lib/accounting/cost-centers";

/** Revenue and expenses per cost center and account (totals equal the P&L for the range). */
export async function GET(req: NextRequest) {
  try {
    await requireAnyPermission(req, ["accounting.view", "reports.finance"]);
    const q = new URL(req.url).searchParams;
    return NextResponse.json({ report: await costCenterReport(q.get("from") ?? "", q.get("to") ?? "") });
  } catch (err) {
    return handleApiError(err, req);
  }
}
