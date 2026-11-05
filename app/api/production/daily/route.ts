import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { dailyProduction } from "@/lib/orders-service";
import { todayLocalISO } from "@/lib/localDate";
import { jsonResponse } from "@/lib/http-response";

/** Today's production totals per product line. The production board computes the same totals
 * from the order list it polls, with the same helper (lib/production.ts). */
export async function GET(req: NextRequest) {
  try {
    await requireOrderActor(req, "orders.view");
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date") ?? todayLocalISO();
    const products = await dailyProduction();
    return jsonResponse(req, { date, products });
  } catch (err) {
    return handleApiError(err, req);
  }
}
