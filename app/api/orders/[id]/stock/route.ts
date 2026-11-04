import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { jsonResponse } from "@/lib/http-response";
import { orderStockView } from "@/lib/sales/stock-hold";

/** Per line: asked / available now / still short, and (purchasing.requests.view) the
 * procurement suggestions raised for the order. Read-only — reserves nothing. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireOrderActor(req, "orders.view");
    return jsonResponse(req, await orderStockView(params.id, actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}
