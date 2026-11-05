import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { listExceptions, recordException } from "@/lib/accounting/opening-migration";
import { postHandler } from "@/lib/route-handlers";

/** The exception register: source rows not posted, with their evidence and decision. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const sp = new URL(req.url).searchParams;
    return NextResponse.json({ exceptions: await listExceptions({ status: sp.get("status"), segment: sp.get("segment") }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Records a question about the source by hand (a figure or a column to decide). */
export const POST = postHandler("accounting.manage", async (body, actor) => ({ exception: await recordException(body, actor) }));
