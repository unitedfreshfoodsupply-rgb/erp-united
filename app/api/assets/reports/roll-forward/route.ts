import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { rollForward } from "@/lib/accounting/fixed-assets";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "assets.view");
    const q = new URL(req.url).searchParams;
    return NextResponse.json({ report: await rollForward(q.get("from") ?? "", q.get("to") ?? "") });
  } catch (err) {
    return handleApiError(err, req);
  }
}
