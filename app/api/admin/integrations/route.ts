import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createIntegration, listIntegrations } from "@/lib/integrations/service";
import { postHandler } from "@/lib/route-handlers";
import { requestLocale } from "@/lib/locale/server-messages";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "integrations.manage");
    return NextResponse.json(await listIntegrations(requestLocale(req)));
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Returns the new key once; only its hash is stored. */
export const POST = postHandler("integrations.manage", async (body, actor) => createIntegration(body, actor));
