import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { assetCountReport, recordAssetCount } from "@/lib/accounting/fixed-assets";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.assets.view");
    return NextResponse.json({ report: await assetCountReport() });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Records a physical count (found / condition / location per asset); posts nothing. */
export const POST = postHandler("accounting.assets.manage", async (body, actor) => ({ count: await recordAssetCount(body, actor) }));
