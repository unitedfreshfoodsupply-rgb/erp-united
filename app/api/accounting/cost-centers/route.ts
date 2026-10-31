import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { createCostCenter, listCostCenters } from "@/lib/accounting/cost-centers";
import { postHandler } from "@/lib/route-handlers";

/** Cost centers for the forms that take one (expenses, service bills, journals, assets) and the accountant. */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAnyPermission(req, ["accounting.view", "hr.expenses.submit", "purchasing.bills.manage", "accounting.assets.manage"]);
    const all = new URL(req.url).searchParams.get("all") === "1" && ctx.can("accounting.view");
    return NextResponse.json({ costCenters: await listCostCenters({ includeInactive: all }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("accounting.manage", async (body, actor) => ({ costCenter: await createCostCenter(body, actor) }));
