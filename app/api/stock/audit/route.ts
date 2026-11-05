import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireStockActor } from "@/lib/stock-auth";
import { stockAuditFor } from "@/lib/security/stock-audit";

/**
 * The stock module's slice of the shared audit trail. Kept separate from /api/audit
 * (supervisor-only, order-scoped) so the stock controller can see the history of their
 * own entries without being handed the order pipeline's log. Rows follow the same money
 * rules as /api/audit and the supplier profile (lib/security/stock-audit.ts): agreed
 * supplier prices only with purchasing.prices.view, a receipt's provisional cost only
 * with stock.valuation.view.
 */
export async function GET(req: NextRequest) {
  try {
    const viewer = await requireStockActor(req, "stock.view");
    return NextResponse.json(await stockAuditFor(viewer, new URL(req.url).searchParams.get("entity_id")));
  } catch (err) {
    return handleApiError(err, req);
  }
}
