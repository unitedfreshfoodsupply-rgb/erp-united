import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { homeSummary } from "@/lib/home/summary";
import { jsonResponse } from "@/lib/http-response";

/** The home dashboard for desk roles; each section is filtered by the caller's permissions. */
export async function GET(req: NextRequest) {
  try {
    // Written out (not spread from HOME_PERMISSIONS) so the RBAC snapshot records the real gate;
    // tests/unit/ui-components.test.ts keeps the two lists equal.
    const ctx = await requireAnyPermission(req, ["users.view", "reports.view", "reports.finance", "sales.customers.view", "purchasing.orders.view", "accounting.view", "accounting.receipts.manage", "accounting.payments.manage", "stock.view", "hr.employees.view"]);
    return jsonResponse(req, await homeSummary({ id: ctx.id, permissions: ctx.permissions }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
