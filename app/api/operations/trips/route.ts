import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createTrip, getTrip, listTrips } from "@/lib/operations/trips";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "orders.view");
    const sp = new URL(req.url).searchParams;
    return NextResponse.json({ trips: await listTrips({ status: sp.get("status") ?? undefined, date: sp.get("date") ?? undefined, open: sp.get("open") === "1", q: sp.get("q") ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("operations.trips.manage", async (body, actor) => ({ trip: await getTrip((await createTrip(body, actor)).id) }));
