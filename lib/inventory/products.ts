import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { inTx } from "@/lib/tx";
import { isValidISODate } from "@/lib/dates";
import type { ServiceActor } from "@/lib/core/actor";
import { D, parseMoney, parseQty } from "@/lib/inventory/decimal";
import { productAvailability } from "@/lib/inventory/balances";
import { orderBuckets } from "@/lib/inventory/picking";
import { todayLocalISO } from "@/lib/localDate";
import { resolveWarehouse } from "@/lib/inventory/context";

/**
 * The inventory side of a product: how it is stored and costed, how it is packed,
 * and its lots. Identity (names, aliases, SKU) stays in the product master.
 */

const show = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Shelf life, picking strategy, costing, stock levels, cold chain. */
/** Costing is a finance decision (it sets what the books say stock is worth); the rest
 * is how the warehouse handles the product. Each needs its own permission. */
const COSTING_FIELDS = ["standard_cost", "costing_method"];

export async function updateInventorySettings(productId: string, input: Record<string, unknown>, actor: ServiceActor) {
  const costing = COSTING_FIELDS.some((k) => input[k] !== undefined);
  const handling = Object.keys(input).some((k) => !COSTING_FIELDS.includes(k) && k !== "expected_version" && input[k] !== undefined);
  if (costing) assertPermission(actor, "accounting.manage");
  if (handling || !costing) assertPermission(actor, "stock.manage_products");
  const product = await prisma.stockProduct.findUnique({ where: { id: productId } });
  if (!product) throw new ApiError(404, "الصنف مش موجود");
  if (input.expected_version !== undefined && input.expected_version !== product.version) {
    throw new ApiError(409, `الصنف اتغيّر من واحد تاني (النسخة الحالية: ${product.version})`);
  }

  const data: Record<string, unknown> = {};
  if (input.shelf_life_days !== undefined) {
    const v = input.shelf_life_days;
    if (v !== null && (!Number.isInteger(v) || (v as number) <= 0 || (v as number) > 3650)) {
      throw new ApiError(400, "مدة الصلاحية لازم تكون عدد أيام صحيح موجب");
    }
    data.shelfLifeDays = v;
  }
  if (input.removal_strategy !== undefined) {
    if (!["fefo", "fifo"].includes(input.removal_strategy as string)) throw new ApiError(400, "طريقة الصرف لازم تكون fefo أو fifo");
    data.removalStrategy = input.removal_strategy;
  }
  for (const [key, col] of [["min_stock_qty", "minStockQty"], ["reorder_point_qty", "reorderPointQty"], ["max_stock_qty", "maxStockQty"]] as const) {
    if (input[key] !== undefined) data[col] = input[key] === null || input[key] === "" ? null : parseQty(input[key], key, { allowZero: true });
  }
  if (input.standard_cost !== undefined) data.standardCost = parseMoney(input.standard_cost, "التكلفة المعيارية");
  if (input.cold_chain !== undefined) {
    if (typeof input.cold_chain !== "boolean") throw new ApiError(400, "قيمة التبريد لازم تكون true أو false");
    data.coldChain = input.cold_chain;
  }
  if (input.costing_method !== undefined) {
    if (!["avco", "fifo", "standard"].includes(input.costing_method as string)) throw new ApiError(400, "طريقة التكلفة غير معروفة");
    data.costingMethod = input.costing_method;
  }
  const min = (data.minStockQty ?? product.minStockQty) as unknown;
  const reorder = (data.reorderPointQty ?? product.reorderPointQty) as unknown;
  const max = (data.maxStockQty ?? product.maxStockQty) as unknown;
  if (min != null && max != null && D(min as never).greaterThan(D(max as never))) throw new ApiError(400, "الحد الأدنى أكبر من الحد الأقصى");
  if (reorder != null && max != null && D(reorder as never).greaterThan(D(max as never))) throw new ApiError(400, "حد إعادة الطلب أكبر من الحد الأقصى للمخزون");
  const method = (data.costingMethod ?? product.costingMethod) as string;
  if (method === "standard" && (data.standardCost ?? product.standardCost) == null) {
    throw new ApiError(400, "التكلفة المعيارية مطلوبة لما طريقة التكلفة تكون standard");
  }

  const changes = Object.entries(data)
    .map(([k, v]) => [k, show((product as Record<string, unknown>)[k]), show(v)] as const)
    .filter(([, a, b]) => a !== b);
  if (changes.length === 0) return product;

  return inTx(async (tx) => {
    // Switching costing method while holding stock would value the same kilos two
    // ways. It is allowed only at zero stock, when there is nothing to revalue.
    if (data.costingMethod !== undefined && data.costingMethod !== product.costingMethod) {
      const held = await tx.stockMovement.aggregate({ where: { productId }, _sum: { quantity: true } });
      if (!D(held._sum.quantity).isZero()) {
        throw new ApiError(409, "مينفعش تغيّر طريقة التكلفة والصنف عليه رصيد — لازم الرصيد يكون صفر");
      }
    }
    let updated;
    try {
      updated = await tx.stockProduct.update({ where: { id: productId, version: product.version }, data: { ...data, version: { increment: 1 } } });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "الصنف اتغيّر من واحد تاني، حدّث الشاشة");
      throw err;
    }
    await writeAuditMany(
      changes.map(([field, oldValue, newValue]) => ({
        userId: actor.id, userName: actor.name, role: actor.role,
        action: "product_inventory_updated", entityType: "stock_product" as const, entityId: productId,
        fieldChanged: field, oldValue, newValue, source: "user" as const, deviceId: actor.deviceId,
      })),
      tx
    );
    return updated;
  });
}

/** "1 CRATE of this product = 18 KG." Create or update one packaging. */
export async function savePackaging(productId: string, input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.manage_products");
  const product = await prisma.stockProduct.findUnique({ where: { id: productId } });
  if (!product) throw new ApiError(404, "الصنف مش موجود");
  if (typeof input.uom !== "string" || !input.uom) throw new ApiError(400, "اختار وحدة التعبئة");
  const uom = await prisma.unitOfMeasure.findUnique({ where: { code: input.uom } });
  if (!uom || !uom.active) throw new ApiError(400, `الوحدة ${input.uom} مش معروفة`);
  if (uom.code === product.unit) throw new ApiError(400, "دي الوحدة الأساسية للصنف نفسه");
  const qty = parseQty(input.qty_in_base_unit, `كام ${product.unit} في ال${uom.nameAr ?? uom.name}`, { dp: 6 });
  const barcode = typeof input.barcode === "string" && input.barcode.trim() ? input.barcode.trim() : null;
  const active = input.active === undefined ? true : input.active === true;

  return inTx(async (tx) => {
    const existing = await tx.productPackaging.findUnique({ where: { productId_uomCode: { productId, uomCode: uom.code } } });
    if (existing && input.expected_version !== undefined && input.expected_version !== existing.version) {
      throw new ApiError(409, "التعبئة اتغيّرت من واحد تاني، حدّث الشاشة");
    }
    const row = existing
      ? await tx.productPackaging.update({
          where: { id: existing.id, version: existing.version },
          data: { qtyInBaseUnit: qty, barcode, active, version: { increment: 1 } },
        })
      : await tx.productPackaging.create({ data: { productId, uomCode: uom.code, qtyInBaseUnit: qty, barcode, active } }).catch((err) => {
          if ((err as { code?: string })?.code === "P2002") throw new ApiError(409, "الباركود ده مستخدم لتعبئة تانية");
          throw err;
        });
    await writeAudit(
      {
        userId: actor.id, userName: actor.name, role: actor.role,
        action: "product_packaging_saved", entityType: "product_packaging", entityId: row.id,
        fieldChanged: `${product.name} · ${uom.code}`,
        oldValue: existing ? `${D(existing.qtyInBaseUnit).toFixed()} ${product.unit}${existing.active ? "" : " (موقوفة)"}` : null,
        newValue: `${qty.toFixed()} ${product.unit}${active ? "" : " (موقوفة)"}`,
        source: "user", deviceId: actor.deviceId,
      },
      tx
    );
    return row;
  });
}

/** Correct a lot's expiry (a mis-typed date on the label). Audited with a reason. */
export async function updateLotExpiry(lotId: string, input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.sort");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new ApiError(400, "اكتب سبب تعديل الصلاحية");
  const expiry = input.expiry_date === null || input.expiry_date === "" ? null : input.expiry_date;
  if (expiry !== null && !isValidISODate(expiry)) throw new ApiError(400, "تاريخ الصلاحية لازم يكون بصيغة YYYY-MM-DD");
  const lot = await prisma.stockLot.findUnique({ where: { id: lotId } });
  if (!lot) throw new ApiError(404, "الدفعة مش موجودة");
  if (expiry && expiry < lot.receivedDate) throw new ApiError(400, "تاريخ الصلاحية قبل تاريخ الاستلام");
  if (input.expected_version !== undefined && input.expected_version !== lot.version) throw new ApiError(409, "الدفعة اتغيّرت من واحد تاني");
  if (expiry === lot.expiryDate) return lot;
  return inTx(async (tx) => {
    const updated = await tx.stockLot.update({ where: { id: lotId, version: lot.version }, data: { expiryDate: expiry as string | null, version: { increment: 1 } } });
    await writeAudit(
      {
        userId: actor.id, userName: actor.name, role: actor.role,
        action: "stock_lot_updated", entityType: "stock_lot", entityId: lotId,
        fieldChanged: "expiryDate", oldValue: lot.expiryDate, newValue: expiry as string | null, reason,
        source: "user", deviceId: actor.deviceId,
      },
      tx
    );
    return updated;
  });
}

/** Everything about one product's stock in one warehouse: where it is, which lots,
 * in what order it will be picked, what is promised, how it is packed. */
export async function productStockDetail(productId: string, warehouseId: string | undefined, opts: { withValue: boolean }) {
  const product = await prisma.stockProduct.findUnique({
    where: { id: productId },
    include: { packagings: { include: { uom: true }, orderBy: { uomCode: "asc" } } },
  });
  if (!product) throw new ApiError(404, "الصنف مش موجود");
  const wh = await resolveWarehouse(prisma, warehouseId);
  const avail = await productAvailability(prisma, productId, wh.id);
  // The order a sale would take them in: expired lots last (they are for scrap).
  const pickOrder = orderBuckets(avail.buckets.filter((b) => b.quantity.gt(0)), product.removalStrategy as "fefo" | "fifo", { expiredLastOn: todayLocalISO() });
  const [reservations, movements, valuation] = await Promise.all([
    prisma.stockReservation.findMany({ where: { productId, warehouseId: wh.id, status: "active" }, orderBy: { createdAt: "asc" } }),
    prisma.stockMovement.findMany({
      where: { productId, warehouseId: wh.id },
      orderBy: { occurredAt: "desc" },
      take: 30,
      include: { location: { select: { code: true } }, lot: { select: { lotNumber: true } }, document: { select: { number: true, type: true } }, intake: { select: { receiptNumber: true } } },
    }),
    opts.withValue ? prisma.stockValuationLayer.aggregate({ where: { productId }, _sum: { quantity: true, value: true } }) : Promise.resolve(null),
  ]);
  const totalQty = D(valuation?._sum.quantity);
  const totalValue = D(valuation?._sum.value);
  return {
    product,
    warehouse: { id: wh.id, code: wh.code, name: wh.nameAr ?? wh.name, nameAr: wh.nameAr, nameEn: wh.name },
    onHand: avail.onHand,
    quarantined: avail.quarantined,
    expired: avail.expired,
    sellableOnHand: avail.sellableOnHand,
    reserved: avail.reserved,
    available: avail.available,
    today: todayLocalISO(),
    // Buckets in the order a removal would take them (FEFO/FIFO), quarantine last.
    buckets: [...pickOrder, ...avail.buckets.filter((b) => !b.quantity.gt(0))],
    reservations,
    movements: movements.map((m) => (opts.withValue ? m : { ...m, unitCost: null })),
    valuation: opts.withValue
      ? { averageCost: totalQty.gt(0) ? totalValue.dividedBy(totalQty).toDecimalPlaces(4) : null, value: totalValue.toDecimalPlaces(2) }
      : null,
  };
}
