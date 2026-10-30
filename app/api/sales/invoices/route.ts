import { NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createInvoiceFromOrder, listInvoices } from "@/lib/sales/invoicing";
import { postHandler } from "@/lib/route-handlers";
import { jsonResponse } from "@/lib/http-response";
import { listLimit } from "@/lib/core/list-window";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "sales.invoices.view");
    const sp = new URL(req.url).searchParams;
    const limit = listLimit(sp.get("limit"));
    const { items, total } = await listInvoices({ status: sp.get("status") ?? undefined, customerId: sp.get("customer_id") ?? undefined, orderId: sp.get("order_id") ?? undefined, limit });
    return jsonResponse(req, { invoices: items, total, limit });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Draft an invoice for a dispatched order (idempotent: the order's live invoice
 * comes back with 200 if one exists). */
export const POST = postHandler(
  "sales.invoices.manage",
  (body, actor) => {
    if (typeof body.order_id !== "string" || !body.order_id) throw new ApiError(400, "حدد الأوردر");
    return createInvoiceFromOrder(body.order_id, actor);
  },
  (r) => ((r as { created?: boolean }).created ? 201 : 200)
);
