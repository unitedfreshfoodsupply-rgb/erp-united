import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { createCustomerRefund, listCustomerRefunds } from "@/lib/accounting/cash";
import { postHandler } from "@/lib/route-handlers";
import { jsonResponse } from "@/lib/http-response";
import { listLimit } from "@/lib/core/list-window";

export async function GET(req: NextRequest) {
  try {
    // Full financial visibility, or the workflow this list serves (a clerk who records
    // these does not need the ledger, balances or reports — see lib/permissions.ts).
    await requireAnyPermission(req, ["accounting.view", "accounting.payments.manage"]);
    const sp = new URL(req.url).searchParams;
    const limit = listLimit(sp.get("limit"));
    const { items, total } = await listCustomerRefunds({ customerId: sp.get("customer_id") ?? undefined, limit });
    return jsonResponse(req, { refunds: items, total, limit });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Money out to a customer from the credit they hold: paid by whoever pays money out. */
export const POST = postHandler(
  "accounting.payments.manage",
  async (body, actor) => createCustomerRefund(body, actor),
  (r) => ((r as { replayed?: boolean }).replayed ? 200 : 201)
);
