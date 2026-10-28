import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { listEmployees, saveEmployee } from "@/lib/hr/service";
import { postHandler } from "@/lib/route-handlers";

/** Employees and departments — names for anyone recording expenses (to pick who), placement for the directory (hr.employees.view), balances and contact details for HR/finance only. */
export async function GET(req: NextRequest) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.expenses.submit", "hr.employees.view"]));
    return NextResponse.json(await listEmployees(actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("hr.employees.manage", async (body, actor) => ({ employee: await saveEmployee(null, body, actor) }));
