import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { acquireAsset, listAssets } from "@/lib/accounting/fixed-assets";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "assets.view");
    const q = new URL(req.url).searchParams;
    return NextResponse.json(await listAssets({ status: q.get("status") ?? undefined, categoryId: q.get("category_id") ?? undefined, q: q.get("q") ?? undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** An asset bought for cash or from the bank (a supplier's invoice is booked as a bill capital line instead). */
export const POST = postHandler("assets.manage", async (body, actor) => ({ asset: await acquireAsset(body, actor) }));
