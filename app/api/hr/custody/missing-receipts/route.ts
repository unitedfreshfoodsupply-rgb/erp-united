import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { missingCustodyReceipts } from "@/lib/hr/custody";

/** Custody payments with no receipt attached yet (?employee_id= for one holder). */
export async function GET(req: NextRequest) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.advances.manage", "hr.employees.manage", "accounting.view", "accounting.payments.manage"]));
    return NextResponse.json(await missingCustodyReceipts(actor, { employeeId: new URL(req.url).searchParams.get("employee_id") ?? undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
