import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { dailyOperationsSummary } from "@/lib/orders-service";
import { jsonResponse } from "@/lib/http-response";

export async function GET(req: NextRequest) {
  try {
    await requireOrderActor(req, "reports.view");
    return jsonResponse(req, await dailyOperationsSummary());
  } catch (err) {
    return handleApiError(err, req);
  }
}
