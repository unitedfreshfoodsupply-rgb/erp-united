import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { getAsset } from "@/lib/accounting/fixed-assets";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requirePermission(req, "accounting.assets.view");
    return NextResponse.json({ asset: await getAsset(params.id) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
