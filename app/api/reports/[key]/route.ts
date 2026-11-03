import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAuth } from "@/lib/authz";
import { reportParams, runReport } from "@/lib/reports/engine";

/** One report: its columns, rows, totals and warnings for the filters given (permission checked per report). */
export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  try {
    const ctx = await requireAuth(req);
    return NextResponse.json(await runReport(params.key, reportParams(new URL(req.url).searchParams), ctx));
  } catch (err) {
    return handleApiError(err, req);
  }
}
