import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { previewDepreciation, runDepreciation } from "@/lib/accounting/fixed-assets";
import { postHandler } from "@/lib/route-handlers";
import { todayLocalISO } from "@/lib/localDate";

/** What the month's run would post, asset by asset. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.assets.view");
    return NextResponse.json({ preview: await previewDepreciation(new URL(req.url).searchParams.get("period") ?? todayLocalISO().slice(0, 7)) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("accounting.assets.manage", async (body, actor) => ({ run: await runDepreciation(body, actor) }));
