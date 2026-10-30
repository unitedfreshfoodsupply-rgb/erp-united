import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { listOrders, getOperationalIntelligence } from "@/lib/orders-service";
import { jsonResponse } from "@/lib/http-response";

/**
 * Combines the order list the Command Center already needed with the
 * operational-intelligence classification, in one round trip.
 */
export async function GET(req: NextRequest) {
  try {
    await requireOrderActor(req, "reports.view");
    const orders = await listOrders({});
    const intelligence = await getOperationalIntelligence(orders);
    // generatedAt changes every call; leave it out of the ETag so an unchanged board revalidates to 304.
    return jsonResponse(req, { orders, intelligence }, { etagOf: { orders, intelligence: { ...intelligence, generatedAt: null } } });
  } catch (err) {
    return handleApiError(err, req);
  }
}
