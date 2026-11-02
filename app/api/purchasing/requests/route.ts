import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { createPurchaseRequest, listPurchaseRequests } from "@/lib/purchasing/requests";
import { postHandler } from "@/lib/route-handlers";
import { searchText } from "@/lib/core/search";

/** Purchase requests: customer demand the shelf cannot meet (remediation 2026-11). */
export async function GET(req: NextRequest) {
  try {
    const actor = await requireServiceActor(req, "purchasing.requests.view");
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await listPurchaseRequests({ status: sp.get("status") ?? undefined, customerId: sp.get("customer_id") ?? undefined, orderId: sp.get("order_id") ?? undefined, limit: Number(sp.get("limit")) || undefined, q: searchText(sp.get("q")) || undefined }, actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}
export const POST = postHandler("purchasing.requests.create", async (body, actor) => ({ request: await createPurchaseRequest(body, actor) }));
