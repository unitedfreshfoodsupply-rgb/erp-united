import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { custodyStatement } from "@/lib/hr/custody";

/** One employee's purchasing custody statement: issued, paid to suppliers (with bills), returned, held. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.advances.manage", "hr.employees.manage", "accounting.view", "accounting.payments.manage"]));
    return NextResponse.json({ statement: await custodyStatement(params.id, actor) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
