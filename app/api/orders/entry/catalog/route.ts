import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { prisma } from "@/lib/prisma";
import { warehouseStock } from "@/lib/inventory/balances";
import { resolveWarehouse } from "@/lib/inventory/context";

/**
 * What the order screen may promise (remediation 2026-11): every active product with
 * its units (and their precision) and the quantity AVAILABLE TO SELL now — sellable on
 * hand minus what other orders hold. No on-hand, quarantine, waste or cost figures:
 * taking orders does not grant a view of the warehouse.
 */
export async function GET(req: NextRequest) {
  try {
    await requireServiceActor(req, "orders.create");
    const wh = await resolveWarehouse(prisma, undefined);
    const [products, stock, uoms] = await Promise.all([
      prisma.stockProduct.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, nameAr: true, sku: true, unit: true, stockTracked: true, packagings: { where: { active: true }, select: { uomCode: true, qtyInBaseUnit: true } } },
      }),
      warehouseStock(wh.id),
      prisma.unitOfMeasure.findMany({ where: { active: true }, select: { code: true, precision: true } }),
    ]);
    const available = new Map(stock.map((s: { productId: string; available: { toFixed(): string } }) => [s.productId, s.available]));
    const precision = Object.fromEntries(uoms.map((u) => [u.code, u.precision]));
    return NextResponse.json({
      precision,
      products: products.map((p) => {
        const a = available.get(p.id);
        const n = a ? Number(a.toFixed()) : 0;
        return {
          id: p.id, name: p.name, nameAr: p.nameAr, sku: p.sku, unit: p.unit, stockTracked: p.stockTracked,
          packagings: p.packagings.map((x) => ({ uomCode: x.uomCode, qtyInBaseUnit: x.qtyInBaseUnit.toFixed() })),
          available: p.stockTracked ? String(Math.max(0, n)) : null,
        };
      }),
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}
