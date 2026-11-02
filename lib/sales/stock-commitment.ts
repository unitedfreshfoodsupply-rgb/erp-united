import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/rbac";
import type { Tx } from "@/lib/tx";
import type { ServiceActor } from "@/lib/core/actor";
import { productAvailability } from "@/lib/inventory/balances";
import { lockAvailability } from "@/lib/inventory/picking";
import { resolveWarehouse } from "@/lib/inventory/context";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { releaseReservationInTx, reserveInTx } from "@/lib/inventory/reservations";
import { D, ZERO, type Dec } from "@/lib/inventory/decimal";

/**
 * The confirmed-order stock rule (remediation 2026-11, WF-01).
 *
 * A confirmed order line is a promise of stock that is physically sellable today:
 * it must name a catalog product, use a unit that product carries, respect that
 * unit's precision (KG to 3 decimals, PIECE whole), and be FULLY reserved in the
 * same transaction that confirms it. Sellable means on hand, outside quarantine and
 * waste, not expired, and not already reserved for another order (see
 * productAvailability). A line that cannot be reserved in full is refused — the
 * order is not created or changed — and the caller gets every shortfall at once so
 * the screen can offer a purchase request instead.
 *
 * There is no lenient path: dispatch, invoicing, quantity edits, reopen, clone and
 * the integration API all go through this module or the strict dispatch issue.
 */

export type StockShortfallReason = "unmapped" | "unit_not_on_product" | "precision" | "unit_mismatch" | "insufficient";

export type StockShortfall = {
  line: number;
  itemId?: string;
  productId: string | null;
  productName: string;
  unit: string;
  requested: string;
  available: string;
  baseUnit?: string;
  reason: StockShortfallReason;
};

const REASON_AR: Record<StockShortfallReason, string> = {
  unmapped: "الصنف مش مربوط بدليل الأصناف",
  unit_not_on_product: "الوحدة مش مضافة على كارت الصنف",
  precision: "الكمية مش مطابقة لدقة الوحدة",
  unit_mismatch: "الوحدة مش بتتحول لوحدة المخزون",
  insufficient: "الرصيد المتاح مش كفاية",
};

export class StockUnavailableError extends ApiError {
  constructor(public shortfalls: StockShortfall[]) {
    super(
      409,
      `مينفعش تأكيد الأوردر — ${shortfalls
        .map((s) => (s.reason === "insufficient" ? `${s.productName}: المطلوب ${s.requested} ${s.unit}، المتاح ${s.available} ${s.unit}` : `${s.productName}: ${REASON_AR[s.reason]}`))
        .join(" · ")}`,
      "stock_unavailable",
      { shortfalls }
    );
  }
}

/** Decimal places a unit allows; an unknown unit allows none of our quantities. */
export async function unitPrecision(db: Pick<Tx, "unitOfMeasure">, code: string): Promise<number | null> {
  const u = await db.unitOfMeasure.findUnique({ where: { code } });
  return u && u.active ? u.precision : null;
}

/** True when `qty` has no more decimals than the unit allows (PIECE: integers only). */
export function fitsPrecision(qty: number | Dec, precision: number): boolean {
  const d = D(qty);
  return d.toDecimalPlaces(precision).equals(d);
}

/** Throws a 400 naming the line when a quantity does not fit its unit. */
export async function assertQuantityFitsUnit(db: Pick<Tx, "unitOfMeasure">, unit: string, qty: number | Dec, label: string) {
  const p = await unitPrecision(db, unit);
  if (p === null) throw new ApiError(400, `الوحدة "${unit}" مش معروفة أو موقوفة — ${label}`);
  if (!fitsPrecision(qty, p)) {
    throw new ApiError(400, p === 0 ? `${label}: الوحدة ${unit} بالعدد الصحيح بس — مينفعش كسور` : `${label}: الكمية لازم تكون بحد أقصى ${p} خانات عشرية للوحدة ${unit}`);
  }
}

type CommitLine = { itemId: string; line: number; productId: string; productName: string; unit: string; baseUnit: string; requested: Dec; base: Dec };

/**
 * Holds stock for every stock-tracked line of an order, exactly at its required
 * quantity. Lines whose reservation already matches are left alone; a changed line
 * has its reservation released and taken again — all under the per-product
 * availability locks, in one global order, so two orders can never both take the
 * same kilo. Throws StockUnavailableError (nothing written) on any shortfall.
 */
export async function commitOrderStock(tx: Tx, orderId: string, actor: ServiceActor, opts: { lines?: string[] } = {}): Promise<{ reserved: number }> {
  // `lines` limits the commitment to those lines (a mapping that links them to a product);
  // the order's other lines and their reservations are left exactly as they are.
  const only = opts.lines ? new Set(opts.lines) : null;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { stockProduct: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!order || order.status === "cancelled" || order.status === "dispatched") return { reserved: 0 };
  const warehouse = await resolveWarehouse(tx, undefined);

  const shortfalls: StockShortfall[] = [];
  const lines: CommitLine[] = [];
  for (const [idx, item] of order.items.entries()) {
    const line = idx + 1;
    if (only && !only.has(item.id)) continue;
    const p = item.stockProduct;
    const requested = D(item.requiredQuantity);
    const base = { line, itemId: item.id, productName: p?.nameAr ?? p?.name ?? item.productName, unit: item.unit, requested: requested.toFixed(), available: "0" };
    if (!p) {
      shortfalls.push({ ...base, productId: null, reason: "unmapped" });
      continue;
    }
    if (!p.stockTracked) continue; // services and packaging are not stock
    if (!requested.gt(0)) continue; // a line corrected to 0 holds nothing (its reservation is released below)
    const precision = await unitPrecision(tx, item.unit);
    if (precision === null || !fitsPrecision(requested, precision)) {
      shortfalls.push({ ...base, productId: p.id, reason: "precision" });
      continue;
    }
    let baseQty: Dec;
    try {
      baseQty = await toBaseQuantity(tx, p, requested, item.unit);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      shortfalls.push({ ...base, productId: p.id, reason: "unit_mismatch" });
      continue;
    }
    lines.push({ itemId: item.id, line, productId: p.id, productName: base.productName, unit: item.unit, baseUnit: p.unit, requested, base: baseQty });
  }

  const productIds = [...new Set(lines.map((l) => l.productId))].sort();
  for (const id of productIds) await lockAvailability(tx, id, warehouse.id);

  // What this order may hold of each product: free stock plus what it already holds.
  const free = new Map<string, Dec>();
  for (const id of productIds) {
    const { available } = await productAvailability(tx, id, warehouse.id);
    const own = await tx.stockReservation.aggregate({
      where: { productId: id, warehouseId: warehouse.id, sourceType: "order", sourceId: orderId, status: "active", ...(only ? { sourceLineId: { in: [...only] } } : {}) },
      _sum: { quantity: true },
    });
    const total = available.plus(D(own._sum.quantity));
    free.set(id, total.gt(0) ? total : ZERO);
  }
  for (const l of lines) {
    const left = free.get(l.productId)!;
    if (left.lessThan(l.base)) {
      shortfalls.push({
        line: l.line, itemId: l.itemId, productId: l.productId, productName: l.productName, unit: l.unit,
        requested: l.requested.toFixed(),
        // Shown in the line's own unit when it is the base unit; otherwise in base units.
        available: l.unit === l.baseUnit ? left.toFixed() : `${left.toFixed()} ${l.baseUnit}`,
        baseUnit: l.baseUnit,
        reason: "insufficient",
      });
    }
    free.set(l.productId, Prisma.Decimal.max(ZERO, left.minus(l.base)));
  }
  if (shortfalls.length) throw new StockUnavailableError(shortfalls.sort((a, b) => a.line - b.line));

  // Reservations follow the lines exactly: release what changed or vanished, then take.
  const active = (await tx.stockReservation.findMany({ where: { sourceType: "order", sourceId: orderId, status: "active" } })).filter((r) => !only || (r.sourceLineId && only.has(r.sourceLineId)));
  const target = new Map(lines.map((l) => [l.itemId, l]));
  for (const r of active) {
    const want = r.sourceLineId ? target.get(r.sourceLineId) : undefined;
    if (!want || !r.quantity.equals(want.base) || r.productId !== want.productId) {
      await releaseReservationInTx(tx, r, want ? "تعديل كمية السطر" : "السطر اتشال", actor);
    }
  }
  let reserved = 0;
  for (const l of lines) {
    const { created } = await reserveInTx(tx, { productId: l.productId, warehouseId: warehouse.id, quantity: l.base, sourceType: "order", sourceId: orderId, sourceLineId: l.itemId }, actor);
    if (created) reserved++;
  }
  return { reserved };
}

/** Read-only availability for the order screen: what a product can promise now. */
export async function sellableNow(db: Parameters<typeof productAvailability>[0] & Parameters<typeof resolveWarehouse>[0], productId: string) {
  const warehouse = await resolveWarehouse(db, undefined);
  const a = await productAvailability(db, productId, warehouse.id);
  return { available: Prisma.Decimal.max(ZERO, a.available), onHand: a.onHand, reserved: a.reserved, quarantined: a.quarantined, expired: a.expired };
}
