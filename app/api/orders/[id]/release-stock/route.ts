import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { readJson } from "@/lib/http";
import { releaseHeldOrder } from "@/lib/sales/stock-hold";

/** Re-check stock and release an order waiting for stock: every line reserved in full and
 * the order continues the normal workflow, or 409 stock_unavailable with the shortfalls. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireOrderActor(req, "orders.edit");
    const body = await readJson(req);
    const order = await releaseHeldOrder(params.id, actor, { expectedVersion: body.expected_version, reason: typeof body.reason === "string" ? body.reason : undefined });
    return NextResponse.json({ order });
  } catch (err) {
    return handleApiError(err, req);
  }
}
