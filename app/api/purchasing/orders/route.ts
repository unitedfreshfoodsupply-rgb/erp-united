import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createPurchaseOrder, getPurchaseOrder, listPurchaseOrders } from "@/lib/purchasing/orders";
import { replenishmentSuggestions } from "@/lib/purchasing/replenishment";
import { postHandler } from "@/lib/route-handlers";
import { searchText } from "@/lib/core/search";

/** Prices and totals are included only for holders of purchasing.prices.view. */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePermission(req, "purchasing.orders.view");
    const sp = new URL(req.url).searchParams;
    if (sp.get("replenishment") === "1") return NextResponse.json({ replenishment: await replenishmentSuggestions() });
    return NextResponse.json({ orders: await listPurchaseOrders({ status: sp.get("status") ?? undefined, supplierId: sp.get("supplier_id") ?? undefined, open: sp.get("open") === "1", q: searchText(sp.get("q")) || undefined }, ctx) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("purchasing.orders.manage", async (body, actor) => ({ order: await getPurchaseOrder((await createPurchaseOrder(body, actor)).id, actor) }));
