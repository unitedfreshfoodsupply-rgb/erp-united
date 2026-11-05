import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { jsonResponse } from "@/lib/http-response";
import { orderStockPanel } from "@/lib/orderDetailReads";

/** Per line: asked / available now / still short, and (purchasing.requests.view) the
 * procurement suggestions raised for the order. Read-only — reserves nothing. The lines are
 * assessed only for an order waiting for stock: no other order's panel shows them. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireOrderActor(req, "orders.view");
    return jsonResponse(req, await orderStockPanel(params.id, actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}
