import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { getOrder, editOrder } from "@/lib/orders-service";
import { readJson } from "@/lib/http";
import { jsonResponse } from "@/lib/http-response";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireOrderActor(req, "orders.view");
    const order = await getOrder(params.id);
    return jsonResponse(req, { order });
  } catch (err) {
    return handleApiError(err, req);
  }
}

// Supervisor edit: customer / delivery date-time / notes / vehicle.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireOrderActor(req, "orders.edit");
    const body = await readJson(req);
    const order = await editOrder(
      params.id,
      {
        customerName: body.customer_name,
        customerAccountId: body.customer_account_id,
        deliveryDate: body.delivery_date,
        deliveryTime: body.delivery_time,
        notes: body.notes,
        vehicle: body.vehicle,
      },
      actor,
      body.reason,
      body.expected_version
    );
    return NextResponse.json({ order });
  } catch (err) {
    return handleApiError(err, req);
  }
}
