import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { listRuns } from "@/lib/accounting/fixed-assets";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "assets.view");
    return NextResponse.json({ runs: await listRuns() });
  } catch (err) {
    return handleApiError(err, req);
  }
}
