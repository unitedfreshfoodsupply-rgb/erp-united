import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { listCustody } from "@/lib/hr/custody";

/** Purchasing custody per holder: held, pending, available, missing receipts (HR money or finance). */
export async function GET(req: NextRequest) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.advances.manage", "hr.employees.manage", "accounting.view", "accounting.payments.manage"]));
    return NextResponse.json(await listCustody(actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}
