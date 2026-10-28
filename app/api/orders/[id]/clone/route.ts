import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { cloneOrder } from "@/lib/orders-service";
import { readJson, type JsonBody } from "@/lib/http";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireOrderActor(req, "orders.create");
    const body = await readJson(req).catch((): JsonBody => ({}));
    const order = await cloneOrder(params.id, actor, {
      delivery_date: body.delivery_date,
      delivery_time: body.delivery_time,
    });
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
