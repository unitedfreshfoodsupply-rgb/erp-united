import { prisma } from "@/lib/prisma";
import { resolveWarehouse } from "@/lib/inventory/context";
import { warehouseStock } from "@/lib/inventory/balances";
import { suggestedReplenishment } from "@/lib/purchasing/replenishment-rules";

/** Replenishment suggestions use sellable, unreserved stock from the live ledger. */
export async function replenishmentSuggestions() {
  const warehouse = await resolveWarehouse(prisma);
  const rows = await warehouseStock(warehouse.id);
  const suggestions = rows.flatMap((row) => {
    if (!row.active || row.reorderPointQty == null) return [];
    const quantity = suggestedReplenishment(row.available, row.reorderPointQty, row.maxStockQty);
    if (!quantity || !quantity.greaterThan(0)) return [];
    return [{
      productId: row.productId,
      productName: row.productNameAr ?? row.productName,
      unit: row.unit,
      available: row.available.toFixed(3),
      reorderPointQty: row.reorderPointQty.toFixed(3),
      maxStockQty: row.maxStockQty?.toFixed(3) ?? null,
      suggestedQty: quantity.toFixed(3),
      warehouseId: warehouse.id,
      warehouseCode: warehouse.code,
    }];
  });
  return { warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.nameAr ?? warehouse.name, nameAr: warehouse.nameAr, nameEn: warehouse.name }, suggestions };
}
