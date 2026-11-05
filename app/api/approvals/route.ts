import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAuth } from "@/lib/authz";
import { listApprovalInbox } from "@/lib/core/approval-handlers";

/**
 * Requests the caller may decide, plus the ones they raised, newest first, with the number
 * that match (`total`). ?status=pending|approved|rejected|cancelled &type= &limit= &offset=
 * &id= (one request) &entity_id= (the requests about one record) &approvers=1 (name who can
 * decide each pending one even when the caller can too).
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const sp = new URL(req.url).searchParams;
    const { approvals, total } = await listApprovalInbox(
      { id: ctx.id, role: ctx.role, permissions: [...ctx.permissions] },
      {
        status: sp.get("status") ?? undefined,
        limit: Number(sp.get("limit")) || undefined,
        offset: Number(sp.get("offset")) || undefined,
        type: sp.get("type") || undefined,
        id: sp.get("id") || undefined,
        entityId: sp.get("entity_id") || undefined,
        withApprovers: sp.get("approvers") === "1",
      }
    );
    return NextResponse.json({ approvals, total });
  } catch (err) {
    return handleApiError(err, req);
  }
}
