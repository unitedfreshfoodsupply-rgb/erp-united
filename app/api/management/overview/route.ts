import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { managementOverview } from "@/lib/management/overview";
import { jsonResponse } from "@/lib/http-response";

/** Figures behind the management dashboard (weekly trends, aging, top customers). Finance only. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "reports.finance");
    const sp = new URL(req.url).searchParams;
    return jsonResponse(req, await managementOverview({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
