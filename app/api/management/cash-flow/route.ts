import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { cashFlowReport } from "@/lib/management/reports";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.finance");
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from");
    const to = sp.get("to");
    if (!from || !to) return NextResponse.json({ error: localizeServerMessage("حدد تاريخ البداية والنهاية", requestLocale(req)) }, { status: 400 });
    return NextResponse.json({ report: await cashFlowReport({ from, to }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}