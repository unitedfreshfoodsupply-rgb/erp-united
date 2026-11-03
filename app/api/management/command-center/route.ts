import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { commandCenter } from "@/lib/management/command-center";

/** The management command center for a period (each section gated by its own permission). */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAnyPermission(req, ["reports.finance", "reports.view"]);
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await commandCenter(ctx, { from: sp.get("from"), to: sp.get("to") }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
