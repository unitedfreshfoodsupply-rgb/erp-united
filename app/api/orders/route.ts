import { NextRequest, NextResponse } from "next/server";
import { handleApiError, ApiError } from "@/lib/rbac";
import { requireOrderActor, requireOrderCreateActor } from "@/lib/api-auth";
import { createOrder, listOrders } from "@/lib/orders-service";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/types";
import { readJson } from "@/lib/http";
import { loggedIntegrationCall } from "@/lib/integrations/service";
import { jsonResponse } from "@/lib/http-response";

function isOrderStatus(v: string): v is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(v);
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireOrderActor(req, "orders.view");
    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const date = searchParams.get("date") ?? undefined;
    let status: OrderStatus[] | undefined;
    if (statusParam) {
      const parts = statusParam.split(",");
      if (!parts.every(isOrderStatus)) throw new ApiError(400, "حالة غير معروفة في الفلتر");
      status = parts;
    }
    // ?mine=1 — the preparation queue of the person asking.
    const assignedToId = searchParams.get("mine") === "1" && actor.id ? actor.id : undefined;
    // Without a filter the list is the boards' window (open + recently closed); ?scope=production
    // is exactly what the production totals count.
    const scope = searchParams.get("scope") === "production" ? "production" : undefined;
    const orders = await listOrders({ status, date, assignedToId, scope });
    return jsonResponse(req, { orders });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/**
 * n8n / Hermes integration point.
 * Auth: header `x-api-key: <N8N_API_KEY>` for automated creation,
 * or a logged-in SUPERVISOR session for manual creation.
 *
 * Body:
 * {
 *   "external_id": "email-123",
 *   "customer_name": "Hotel X",
 *   "delivery_date": "2026-09-10",
 *   "delivery_time": "08:00",
 *   "notes": "",
 *   "source": "n8n",
 *   "items": [{ "product_id": "123", "product_name": "Mango", "quantity": 25, "unit": "KG" }]
 * }
 */
export async function POST(req: NextRequest) {
  // A channel (x-api-key) goes through the integration log; a signed-in user does not.
  if (req.headers.get("x-api-key")) {
    return loggedIntegrationCall(req, async () => {
      const order = await create(req);
      return { body: { order }, status: 201, externalId: order.externalId, result: order.orderNumber };
    });
  }
  try {
    return NextResponse.json({ order: await create(req) }, { status: 201 });
  } catch (err) {
    return handleApiError(err, req);
  }
}

async function create(req: NextRequest) {
    const actor = await requireOrderCreateActor(req);
    const body = await readJson(req);
    return createOrder(
      {
        external_id: body.external_id,
        customer_id: body.customer_id,
        customer_account_id: body.customer_account_id,
        customer_name: body.customer_name,
        delivery_date: body.delivery_date,
        delivery_time: body.delivery_time,
        notes: body.notes,
        items: body.items ?? [],
      },
      actor
    );
}
