import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { createSupplierRefund, listSupplierRefunds } from "@/lib/accounting/cash";
import { postHandler } from "@/lib/route-handlers";
import { jsonResponse } from "@/lib/http-response";
import { listLimit } from "@/lib/core/list-window";

export async function GET(req: NextRequest) {
  try {
    // Full financial visibility, or the workflow this list serves (a clerk who records
    // these does not need the ledger, balances or reports — see lib/permissions.ts).
    await requireAnyPermission(req, ["accounting.view", "accounting.receipts.manage"]);
    const sp = new URL(req.url).searchParams;
    const limit = listLimit(sp.get("limit"));
    const { items, total } = await listSupplierRefunds({ supplierId: sp.get("supplier_id") ?? undefined, limit });
    return jsonResponse(req, { refunds: items, total, limit });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Money in from a supplier out of the credit we hold with them: taken by whoever receives money. */
export const POST = postHandler(
  "accounting.receipts.manage",
  async (body, actor) => createSupplierRefund(body, actor),
  (r) => ((r as { replayed?: boolean }).replayed ? 200 : 201)
);
