import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { warehouseStock } from "@/lib/inventory/balances";
import { resolveWarehouse } from "@/lib/inventory/context";

/** On-hand / reserved / available per product; cost and value only for
 * stock.valuation.view. */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePermission(req, "stock.view");
    const wh = await resolveWarehouse(prisma, new URL(req.url).searchParams.get("warehouse_id"));
    const rows = await warehouseStock(wh.id);
    const withValue = ctx.can("stock.valuation.view");
    return jsonFor(ctx, {
      warehouse: { id: wh.id, code: wh.code, name: wh.nameAr ?? wh.name, nameAr: wh.nameAr, nameEn: wh.name },
      rows: withValue ? rows : rows.map((r) => ({ ...r, averageCost: null, stockValue: null })),
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}
