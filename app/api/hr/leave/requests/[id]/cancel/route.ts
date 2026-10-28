import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { readJson } from "@/lib/http";
import { serviceActorFromContext } from "@/lib/core/actor";
import { cancelLeave } from "@/lib/hr/leave";

/** Withdraws a pending request (its recorder or an approver), or cancels an approved one (an approver, with a reason). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.leave.request", "hr.leave.approve"]));
    return NextResponse.json({ request: await cancelLeave(params.id, await readJson(req), actor) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
