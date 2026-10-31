import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { removeLine } from "@/lib/accounting/opening-batches";

export async function DELETE(req: NextRequest, { params }: { params: { id: string; lineId: string } }) {
  try {
    const ctx = await requirePermission(req, "accounting.manage");
    return NextResponse.json(await removeLine(params.id, params.lineId, serviceActorFromContext(ctx)));
  } catch (err) {
    return handleApiError(err, req);
  }
}
