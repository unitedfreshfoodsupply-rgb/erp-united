import { NextRequest, NextResponse } from "next/server";
import { handleApiError, ApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { prisma } from "@/lib/prisma";
import { effectivePrice, priceListsFor } from "@/lib/sales/pricing";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { entryListPrices } from "@/lib/orderEntryPrices";

/** At most this many (product, unit) pairs per call; the form asks in chunks of it. */
const MAX_ITEMS = 100;

/**
 * The customer's list price for one product in one unit on a date, or null (no list price).
 * With `items=productId|unit,productId|unit,…` (Nov 2026): every pair in one call, in a fixed
 * number of statements — `{ prices: { "productId|unit": unitPrice | null } }`; a product that
 * does not exist simply has no price.
 */
export async function GET(req: NextRequest) {
  try {
    await requireServiceActor(req, "orders.create");
    const sp = new URL(req.url).searchParams;
    const date = sp.get("date") || todayLocalISO();
    const items = sp.get("items");
    if (items !== null) {
      const keys = items.split(",").filter(Boolean).map((k) => {
        const [productId, unit, extra] = k.split("|");
        return productId && unit && extra === undefined ? { productId, unit } : null;
      });
      if (!keys.length || keys.length > MAX_ITEMS || keys.some((k) => !k) || !isValidISODate(date)) throw new ApiError(400, "حدد الصنف والوحدة والتاريخ");
      const prices = await entryListPrices(sp.get("customer_id"), date, keys as { productId: string; unit: string }[]);
      return NextResponse.json({ prices: Object.fromEntries([...prices].map(([k, v]) => [k, v.unitPrice])) });
    }
    const productId = sp.get("product_id");
    const unit = sp.get("unit");
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
