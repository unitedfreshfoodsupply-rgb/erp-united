import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { saveEmployee } from "@/lib/hr/service";
import { employeeProfile } from "@/lib/hr/employment";
import { postHandler } from "@/lib/route-handlers";

/** The employee file: identity, current placement and employment history (no money, no private data). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.employees.view", "hr.employees.manage"]));
    return NextResponse.json(await employeeProfile(params.id, actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const PATCH = postHandler("hr.employees.manage", async (body, actor, params) => ({ employee: await saveEmployee(params.id, body, actor) }), () => 200);
