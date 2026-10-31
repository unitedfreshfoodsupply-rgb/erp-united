import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createBatch, listBatches } from "@/lib/accounting/opening-batches";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json({ batches: await listBatches() });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("accounting.manage", async (body, actor) => ({ batch: await createBatch(body, actor) }));
