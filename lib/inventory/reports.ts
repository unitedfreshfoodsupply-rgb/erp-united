import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { todayLocalISO } from "@/lib/localDate";
import { getSetting } from "@/lib/core/settings-service";
import { D, ZERO } from "@/lib/inventory/decimal";

function addDays(dateISO: string, days: number) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Lots still in stock that expire within the warning window — or already have. For
 * perishables this is the daily "sell, move or write off" list.
 */
export async function expiringStock(opts: { days?: number; warehouseId?: string } = {}) {
  const today = todayLocalISO();
  const days = opts.days ?? (await getSetting("inventory.expiry_warning_days"));
  const until = addDays(today, days);
  const lots = await prisma.stockLot.findMany({
    where: { expiryDate: { not: null, lte: until } },
    include: { product: { select: { id: true, name: true, nameAr: true, unit: true } }, supplier: { select: { name: true, nameAr: true } } },
  });
  if (lots.length === 0) return { today, until, rows: [] };
  const sums = await prisma.stockMovement.groupBy({
    by: ["lotId", "locationId"],
    where: { lotId: { in: lots.map((l) => l.id) }, ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}) },
    _sum: { quantity: true },
  });
  const locations = await prisma.storageLocation.findMany({ where: { id: { in: [...new Set(sums.map((s) => s.locationId))] } } });
  const loc = new Map(locations.map((l) => [l.id, l]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const rows = sums
    .filter((s) => D(s._sum.quantity).gt(0))
    .map((s) => {
      const lot = lotById.get(s.lotId!)!;
      return {
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        expiryDate: lot.expiryDate!,
        expired: lot.expiryDate! < today,
        daysLeft: Math.round((Date.parse(`${lot.expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
        product: lot.product,
        supplier: lot.supplier?.name ?? null,
        locationId: s.locationId,
        locationCode: loc.get(s.locationId)?.code ?? "?",
        quantity: D(s._sum.quantity),
      };
    })
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.product.name.localeCompare(b.product.name));
  return { today, until, rows };
}

/** Stock value per product from the valuation layers, and how much stock has no cost
 * behind it yet (received before prices were recorded). */
export async function valuationReport() {
  const [layers, unknown, products, provisional] = await Promise.all([
    prisma.stockValuationLayer.groupBy({ by: ["productId"], _sum: { quantity: true, value: true } }),
    prisma.stockValuationLayer.groupBy({ by: ["productId"], where: { costSource: "unknown", quantity: { gt: 0 } }, _sum: { remainingQty: true, quantity: true } }),
    prisma.stockProduct.findMany({ where: { stockTracked: true }, select: { id: true, name: true, nameAr: true, unit: true, costingMethod: true } }),
    provisionalOnHand(),
  ]);
  const unknownBy = new Map(unknown.map((u) => [u.productId, u._sum]));
  const provisionalBy = new Map(provisional.map((p) => [p.productId, p]));
  let provisionalValue = ZERO;
  const byId = new Map(products.map((p) => [p.id, p]));
  let totalValue = ZERO;
  const rows = layers
    .map((l) => {
      const qty = D(l._sum.quantity);
      const value = D(l._sum.value);
      totalValue = totalValue.plus(value);
      const p = byId.get(l.productId);
      return {
        productId: l.productId,
        productName: p?.name ?? "—",
        productNameAr: p?.nameAr ?? null,
        unit: p?.unit ?? "KG",
        costingMethod: p?.costingMethod ?? "avco",
        quantity: qty,
        value: value.toDecimalPlaces(2),
        averageCost: qty.gt(0) ? value.dividedBy(qty).toDecimalPlaces(4) : null,
        // Quantity received at an unknown cost (history, or a receipt with no price).
        receivedWithoutCost: D(unknownBy.get(l.productId)?.quantity),
        // WS3 (ACC-E1): on hand at a PROVISIONAL cost — its supplier bill is not posted yet,
        // so this value is an estimate until the bill revalues it.
        provisionalQty: D(provisionalBy.get(l.productId)?.qty),
        provisionalValue: D(provisionalBy.get(l.productId)?.value).toDecimalPlaces(2),
      };
    })
    .filter((r) => !r.quantity.isZero() || !r.value.isZero())
    .sort((a, b) => Number(b.value.minus(a.value)));
  for (const r of rows) provisionalValue = provisionalValue.plus(r.provisionalValue);
  return { totalValue: totalValue.toDecimalPlaces(2), currency: "EGP", rows, provisionalValue: provisionalValue.toDecimalPlaces(2) };
}

/**
 * WS3 (ACC-E1): stock still carried at a provisional cost — receipts entered with a
 * provisional price whose supplier bill has not posted. Per product: the quantity still in
 * the receipts' lots and its value at the provisional price; per receipt for the list.
 */
export async function provisionalReceipts() {
  return prisma.$queryRaw<{ intakeId: string; receiptNumber: string; receivedDate: string; supplierId: string; productId: string; unitCost: Prisma.Decimal; accepted: Prisma.Decimal; onHand: Prisma.Decimal; billNumber: string | null; billStatus: string | null }[]>`
    SELECT i."id" AS "intakeId", i."receiptNumber", i."receivedDate", i."supplierId", i."productId", i."unitCost",
           i."receivedQty" - i."rejectedQty" AS accepted,
           coalesce((SELECT sum(m."quantity") FROM "StockMovement" m WHERE m."lotId" IN (SELECT DISTINCT x."lotId" FROM "StockMovement" x WHERE x."intakeId" = i."id" AND x."lotId" IS NOT NULL)), 0) AS "onHand",
           (SELECT b."number" FROM "SupplierBillLine" bl JOIN "SupplierBill" b ON b."id" = bl."billId" WHERE bl."intakeId" = i."id" AND NOT bl."released" LIMIT 1) AS "billNumber",
           (SELECT b."status" FROM "SupplierBillLine" bl JOIN "SupplierBill" b ON b."id" = bl."billId" WHERE bl."intakeId" = i."id" AND NOT bl."released" LIMIT 1) AS "billStatus"
    FROM "StockIntake" i
    WHERE i."costProvisional" AND i."status" = 'posted'
      AND NOT EXISTS (SELECT 1 FROM "SupplierBillLine" bl JOIN "SupplierBill" b ON b."id" = bl."billId" WHERE bl."intakeId" = i."id" AND b."status" = 'posted')
    ORDER BY i."receivedDate", i."receiptNumber"`;
}

async function provisionalOnHand() {
  const rows = await prisma.$queryRaw<{ productId: string; qty: Prisma.Decimal; value: Prisma.Decimal }[]>`
    WITH pl AS (
      SELECT DISTINCT x."lotId", x."productId", i."unitCost"
      FROM "StockMovement" x JOIN "StockIntake" i ON i."id" = x."intakeId"
      WHERE i."costProvisional" AND i."status" = 'posted' AND x."lotId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "SupplierBillLine" bl JOIN "SupplierBill" b ON b."id" = bl."billId" WHERE bl."intakeId" = i."id" AND b."status" = 'posted')
    ), bal AS (SELECT m."lotId", sum(m."quantity") AS qty FROM "StockMovement" m WHERE m."lotId" IN (SELECT "lotId" FROM pl) GROUP BY 1)
    SELECT pl."productId", sum(bal.qty) AS qty, sum(bal.qty * pl."unitCost") AS value FROM pl JOIN bal ON bal."lotId" = pl."lotId" GROUP BY 1`;
  return rows.map((r) => ({ productId: r.productId, qty: D(r.qty), value: D(r.value) }));
}
