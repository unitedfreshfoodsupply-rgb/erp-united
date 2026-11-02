import { NextRequest, NextResponse } from "next/server";
import { handleApiError, ApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { prisma } from "@/lib/prisma";
import { effectivePrice, priceListsFor } from "@/lib/sales/pricing";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";

/** The customer's list price for one product in one unit on a date, or null (no list price). */
export async function GET(req: NextRequest) {
  try {
    await requireServiceActor(req, "orders.create");
    const sp = new URL(req.url).searchParams;
    const productId = sp.get("product_id");
    const unit = sp.get("unit");
    const date = sp.get("date") || todayLocalISO();
    if (!productId || !unit || !isValidISODate(date)) throw new ApiError(400, "حدد الصنف والوحدة والتاريخ");
    const product = await prisma.stockProduct.findUnique({ where: { id: productId }, select: { id: true, name: true, unit: true } });
    if (!product) throw new ApiError(404, "الصنف مش موجود");
    for (const list of await priceListsFor(prisma, sp.get("customer_id"))) {
      const found = await effectivePrice(prisma, { priceListId: list.id, product, lineUom: unit, date });
      if (found) return NextResponse.json({ unitPrice: found.unitPrice.toFixed(), priceList: { id: list.id, code: list.code } });
    }
    return NextResponse.json({ unitPrice: null, priceList: null });
  } catch (err) {
    return handleApiError(err, req);
  }
}
