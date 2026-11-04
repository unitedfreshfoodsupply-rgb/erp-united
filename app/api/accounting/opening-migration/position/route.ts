import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { openingPosition } from "@/lib/accounting/opening-migration";

/** Whether the books' opening figures are final or still provisional (the reports' banner). */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json({ opening: await openingPosition() });
  } catch (err) {
    return handleApiError(err, req);
  }
}
