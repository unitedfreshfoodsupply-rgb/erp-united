import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { getBatch } from "@/lib/accounting/opening-batches";

/** The batch, its lines and its validation as an opening trial balance. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json({ batch: await getBatch(params.id) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
