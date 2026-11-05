import { postMovementValuation } from "@/lib/accounting/ledger";
import { asText } from "@/lib/http";
import type { StockMovement } from "@prisma/client";
import { ApiError } from "@/lib/rbac";
import { advisoryXactLocks } from "@/lib/dbLock";
import type { Tx } from "@/lib/tx";
import { D, ZERO, q3, q4, type Dec } from "@/lib/inventory/decimal";
import { isSellableStock } from "@/lib/inventory/balances";
import { availabilityChanged } from "@/lib/inventory/availability-changes";
import { todayLocalISO } from "@/lib/localDate";

/**
 * THE stock ledger write path. Every receipt, correction, void, adjustment, transfer,
 * issue, return and scrap posts through postMovements() — nothing else inserts into
 * StockMovement. That single choke point is what makes these rules hold everywhere:
 *
 *  1. A bucket (product + location + lot) never goes below zero. Checked here under a
 *     per-bucket lock, and again by a database trigger for any other writer.
 *  2. Locks are always taken in one global order (valuation per product, then
 *     buckets, each sorted), so concurrent postings queue instead of deadlocking.
 *  3. Every movement gets exactly one valuation layer, in the same transaction, using
 *     the product's costing method (AVCO, FIFO or standard).
 *  4. Cold-chain products cannot be put away in a dry/other location.
 *
 * It must be called inside the transaction that writes the document the movements
 * belong to.
 */

export const MOVEMENT_KINDS = [
  "intake",
  "intake_correction",
  "intake_void",
  "adjustment",
  "transfer_out",
  "transfer_in",
  "issue",
  "customer_return",
  "supplier_return",
  "scrap",
  "sorting_out",
  "sorting_in",
  "release_out",
  "release_in",
  // WS3 (ACC-E1): a supplier bill revaluing a receipt carried at a provisional cost — an
  // out/in pair on each bucket still holding the receipt's units (net quantity zero).
  "revaluation_out",
  "revaluation_in",
  // Maturity 2026-11 (DEFECT-SC-01): a standard-cost change revaluing the stock on hand —
  // an out/in pair on each bucket (net quantity zero), out at the old standard, in at the new.
  "standard_cost_out",
  "standard_cost_in",
] as const;

/**
 * Movements whose counter account is GRNI (what the supplier is owed for): the price a
 * caller gives them is the purchase price. For a standard-cost product the stock still
 * enters (or leaves) at the standard; GRNI moves at the purchase price, and the
 * difference is a purchase price variance (DEFECT-SC-01).
 */
const PURCHASE_KINDS: ReadonlySet<string> = new Set(["intake", "intake_correction", "intake_void", "supplier_return", "revaluation_out", "revaluation_in"]);
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export type MoveInput = {
  productId: string;
  warehouseId: string;
  locationId: string;
  lotId: string | null;
  /** Signed, base unit. */
  quantity: Dec;
  kind: MovementKind;
  intakeId?: string | null;
  documentId?: string | null;
  reason?: string | null;
  /** Known cost per base unit for an INCOMING move (a purchase price, or the cost a
   * transfer carried out of its source bucket). */
  unitCost?: Dec | null;
  costSource?: "purchase" | "lot" | "average" | "standard" | "fifo" | "unknown" | "provisional" | "revaluation";
  /** revaluation_out / revaluation_in only: the StockRevaluation the pair belongs to. */
  revaluationId?: string | null;
  /** standard_cost_out / standard_cost_in only: the StandardCostChange the pair belongs to. */
  standardCostChangeId?: string | null;
  /**
   * ACC-03: the movement this one undoes (a document reversal). Its valuation is the exact
   * opposite of that movement's layer — value, purchase price variance and cost source —
   * and its value goes back through the ORIGINAL movement's counter account (COGS, GRNI…),
   * not inventory adjustments.
   */
  reverses?: string | null;
};

type Ctx = { actorId: string | null; actorName: string; effectiveDate: string };

const NOT_FOR_COLD_CHAIN = new Set(["dry", "other"]);

export function bucketKey(productId: string, locationId: string, lotId: string | null) {
  return `stock-bucket:${productId}:${locationId}:${lotId ?? "-"}`;
}

export async function bucketBalance(tx: Tx, productId: string, locationId: string, lotId: string | null): Promise<Dec> {
  const agg = await tx.stockMovement.aggregate({
    where: { productId, locationId, lotId },
    _sum: { quantity: true },
  });
  return D(agg._sum.quantity);
}

/** Current product valuation, over every layer: total quantity and total value. */
export async function productValuation(tx: Tx, productId: string) {
  const agg = await tx.stockValuationLayer.aggregate({
    where: { productId },
    _sum: { quantity: true, value: true },
  });
  return { qty: D(agg._sum.quantity), value: D(agg._sum.value) };
}

/**
 * Takes every lock a set of movements will need, in the one global order: valuation
 * locks (per product, sorted), then bucket locks (sorted). A document that posts in
 * several steps (a transfer: out, then in) calls this first with ALL its moves, so it
 * never acquires a lock after waiting on another transaction that holds one of its
 * own — the classic A→B / B→A transfer deadlock. Advisory transaction locks are
 * re-entrant, so postMovements re-taking them is free.
 */
export async function lockForMoves(tx: Tx, moves: Pick<MoveInput, "productId" | "locationId" | "lotId">[]) {
  await lockProductValuations(tx, moves.map((m) => m.productId));
  // Every bucket lock in one statement (sorted, as before), after all the valuation locks.
  await advisoryXactLocks(tx, moves.map((m) => bucketKey(m.productId, m.locationId, m.lotId)));
}

/** Lock product-level costing state in the same global order used by all stock writes. */
export async function lockProductValuations(tx: Tx, productIds: string[]) {
  await advisoryXactLocks(tx, productIds.map((p) => `stock-valuation:${p}`));
}

export async function postMovements(tx: Tx, moves: MoveInput[], ctx: Ctx): Promise<StockMovement[]> {
  if (moves.length === 0) return [];

  // ---- 1. validate the shape of every move before taking any lock ------------
  const productIds = [...new Set(moves.map((m) => m.productId))].sort();
  const locationIds = [...new Set(moves.map((m) => m.locationId))];
  const lotIds = [...new Set(moves.map((m) => m.lotId).filter((x): x is string => !!x))];
  const [products, locations, lots] = await Promise.all([
    tx.stockProduct.findMany({ where: { id: { in: productIds } } }),
    tx.storageLocation.findMany({ where: { id: { in: locationIds } } }),
    lotIds.length ? tx.stockLot.findMany({ where: { id: { in: lotIds } } }) : Promise.resolve([]),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const lotById = new Map(lots.map((l) => [l.id, l]));

  for (const m of moves) {
    const product = productById.get(m.productId);
    if (!product) throw new ApiError(404, "الصنف مش موجود");
    if (!product.stockTracked) throw new ApiError(400, `"${product.name}" مش صنف بيتتبع مخزونه`);
    const location = locationById.get(m.locationId);
    if (!location || location.warehouseId !== m.warehouseId) throw new ApiError(400, "مكان التخزين مش تابع للمخزن ده");
    if (m.quantity.isZero()) throw new ApiError(400, "حركة بكمية صفر مش مسموحة");
    if (m.quantity.decimalPlaces() > 3) throw new ApiError(400, "الكمية فيها خانات عشرية أكتر من المسموح");
    if (m.lotId) {
      const lot = lotById.get(m.lotId);
      if (!lot || lot.productId !== m.productId) throw new ApiError(400, "الدفعة (اللوت) مش تابعة للصنف ده");
    }
    if (m.quantity.gt(0)) {
      if (!location.active) throw new ApiError(400, `المكان ${location.code} موقوف — مينفعش يدخله مخزون`);
      if (product.coldChain && NOT_FOR_COLD_CHAIN.has(location.type)) {
        throw new ApiError(400, `"${product.name}" محتاج تبريد — مينفعش يتخزن في ${location.code}`);
      }
    }
  }

  // ---- 2. locks, in one global order --------------------------------------------
  await lockForMoves(tx, moves);

  // ---- 3. post, one move at a time (each sees the ones before it) ----------------
  const created: StockMovement[] = [];
  const valued: { movementId: string; kind: string; documentId: string | null; intakeId: string | null; value: Dec; priceVariance: Dec; counterKind?: string }[] = [];
  // The layers being undone (ACC-03), read once.
  const reversedIds = moves.map((m) => m.reverses).filter((x): x is string => !!x);
  const reversed = new Map(
    (reversedIds.length ? await tx.stockValuationLayer.findMany({ where: { movementId: { in: reversedIds } }, include: { movement: { select: { kind: true, quantity: true, productId: true } } } }) : []).map((l) => [l.movementId, l])
  );
  for (const m of moves) {
    const product = productById.get(m.productId)!;
    const qty = q3(m.quantity);

    if (qty.lt(0)) {
      const balance = await bucketBalance(tx, m.productId, m.locationId, m.lotId);
      if (balance.plus(qty).lt(0)) {
        const location = locationById.get(m.locationId)!;
        const lot = m.lotId ? lotById.get(m.lotId) : null;
        throw new ApiError(
          400,
          `الرصيد مش كفاية: "${product.name}" في ${location.code}${lot ? ` (${lot.lotNumber})` : ""} فيه ${balance.toFixed()} بس، والمطلوب ${qty.abs().toFixed()}`
        );
      }
    }

    // ---- valuation ----
    const method = product.costingMethod;
    let unitCost: Dec;
    let costSource: NonNullable<MoveInput["costSource"]>;
    let value: Dec;
    let priceVariance = ZERO;
    const fifoConsumptions: { id: string; take: Dec }[] = [];

    const undo = m.reverses ? reversed.get(m.reverses) : undefined;
    if (m.reverses && (!undo || undo.movement.productId !== m.productId || !D(undo.movement.quantity).negated().equals(qty))) {
      throw new ApiError(409, "الحركة اللي بتتلغي مش مطابقة للإلغاء (صنف أو كمية مختلفة)");
    }
    if (undo) {
      // Exactly the opposite of what was posted, whatever the method or the cost today.
      unitCost = q4(D(undo.unitCost));
      costSource = undo.costSource as NonNullable<MoveInput["costSource"]>;
      value = q4(D(undo.value).negated());
      priceVariance = q4(D(undo.priceVariance).negated());
      if (qty.lt(0) && method === "fifo") await planFifo(tx, m, qty.abs(), fifoConsumptions);
    } else if (method === "standard") {
      // DEFECT-SC-01: a standard-cost product is carried at its standard, whatever the
      // movement. A purchase-linked movement priced by its caller moves GRNI at that price;
      // the difference from the standard is the purchase price variance. Any other caller
      // price (a transfer, a release, a sort) is the standard it left at, or a yield
      // difference its own counter account absorbs.
      if (product.standardCost == null || D(product.standardCost).lte(0)) {
        throw new ApiError(409, `"${product.name}" طريقة تكلفته معيارية ومالوش تكلفة معيارية — حددها الأول`);
      }
      unitCost = q4(D(product.standardCost));
      costSource = "standard";
      value = q4(qty.times(unitCost));
      if (m.unitCost != null && PURCHASE_KINDS.has(m.kind)) priceVariance = q4(qty.times(q4(m.unitCost))).minus(value);
    } else if (qty.gt(0)) {
      if (m.unitCost != null) {
        unitCost = q4(m.unitCost);
        costSource = m.costSource ?? "purchase";
      } else {
        const val = await productValuation(tx, m.productId);
        if (val.qty.gt(0) && val.value.gt(0)) {
          unitCost = q4(val.value.dividedBy(val.qty));
          costSource = "average";
        } else {
          unitCost = ZERO;
          costSource = "unknown";
        }
      }
      value = q4(qty.times(unitCost));
    } else {
      const out = qty.abs();
      if (m.unitCost != null) {
        // The caller knows exactly what this removal is worth (a receipt being voided
        // or corrected comes back out at its own price).
        unitCost = q4(m.unitCost);
        costSource = m.costSource ?? "lot";
        value = q4(qty.times(unitCost));
        if (method === "fifo") await planFifo(tx, m, out, fifoConsumptions);
      } else if (method === "fifo") {
        const consumedValue = await planFifo(tx, m, out, fifoConsumptions);
        unitCost = out.isZero() ? ZERO : q4(consumedValue.dividedBy(out));
        costSource = consumedValue.isZero() ? "unknown" : "fifo";
        value = q4(consumedValue.negated());
      } else {
        const val = await productValuation(tx, m.productId);
        if (val.qty.lessThanOrEqualTo(out)) {
          // Taking everything that is valued: take all of its value too, so no
          // rounding crumbs are left behind on a product with nothing in stock.
          value = q4(val.value.negated());
          unitCost = val.qty.isZero() || val.value.isZero() ? ZERO : q4(val.value.dividedBy(val.qty));
        } else {
          unitCost = val.qty.gt(0) ? q4(val.value.dividedBy(val.qty)) : ZERO;
          value = q4(qty.times(unitCost));
        }
        costSource = unitCost.isZero() ? "unknown" : "average";
      }
    }

    const row = await tx.stockMovement.create({
      data: {
        productId: m.productId,
        warehouseId: m.warehouseId,
        locationId: m.locationId,
        lotId: m.lotId,
        effectiveDate: ctx.effectiveDate,
        kind: m.kind,
        quantity: qty,
        intakeId: m.intakeId ?? null,
        documentId: m.documentId ?? null,
        revaluationId: m.revaluationId ?? null,
        standardCostChangeId: m.standardCostChangeId ?? null,
        unitCost,
        reason: asText(m.reason, "reason")?.trim() || null,
        actorId: ctx.actorId,
        actorName: ctx.actorName,
      },
    });
    await tx.stockValuationLayer.create({
      data: {
        movementId: row.id,
        productId: m.productId,
        quantity: qty,
        unitCost,
        value,
        remainingQty: qty.gt(0) ? qty : ZERO,
        costSource,
        priceVariance,
      },
    });
    for (const c of fifoConsumptions) {
      await tx.stockValuationLayer.update({
        where: { id: c.id },
        data: { remainingQty: { decrement: c.take } },
      });
    }
    created.push(row);
    valued.push({ movementId: row.id, kind: m.kind, documentId: m.documentId ?? null, intakeId: m.intakeId ?? null, value, priceVariance, counterKind: undo?.movement.kind });
  }
  // ---- 4. the value of these movements reaches the GL in this same transaction ---
  await postMovementValuation(tx, valued, { id: ctx.actorId, name: ctx.actorName, effectiveDate: ctx.effectiveDate });
  // ---- 5. what they did to sellable stock: orders waiting for it are re-checked at commit ---
  const today = todayLocalISO();
  await availabilityChanged(
    tx,
    moves
      .filter((m) => isSellableStock({ locationId: m.locationId, locationType: locationById.get(m.locationId)!.type, expiryDate: m.lotId ? lotById.get(m.lotId)?.expiryDate : null }, today))
      .map((m) => ({ productId: m.productId, delta: q3(m.quantity) })),
    { id: ctx.actorId, name: ctx.actorName },
    moves.filter((m) => m.lotId && locationById.get(m.locationId)!.type === "quarantine").map((m) => ({ lotId: m.lotId!, delta: q3(m.quantity) }))
  );
  return created;
}

/**
 * FIFO cost of taking `out` from a product: incoming layers with stock left, the
 * removed lot's own layers first (so a perishable lot leaves at its own price), then
 * oldest first. Returns the consumed value and records what each layer gives up.
 * Quantity with no layer behind it (stock from before costs were recorded) leaves at
 * zero cost — it is reported as unvalued, never invented.
 */
async function planFifo(tx: Tx, m: MoveInput, out: Dec, plan: { id: string; take: Dec }[]): Promise<Dec> {
  const layers = await tx.stockValuationLayer.findMany({
    where: { productId: m.productId, remainingQty: { gt: 0 } },
    include: { movement: { select: { lotId: true } } },
    // Ledger posting order, not timestamps — two receipts in one millisecond must
    // still have a definite "first".
    orderBy: { movement: { seq: "asc" } },
  });
  const ordered = [
    ...layers.filter((l) => m.lotId && l.movement.lotId === m.lotId),
    ...layers.filter((l) => !(m.lotId && l.movement.lotId === m.lotId)),
  ];
  let left = out;
  let consumed = ZERO;
  for (const l of ordered) {
    if (left.isZero()) break;
    const take = minDec(left, D(l.remainingQty));
    consumed = consumed.plus(take.times(D(l.unitCost)));
    plan.push({ id: l.id, take });
    left = left.minus(take);
  }
  return consumed;
}

function minDec(a: Dec, b: Dec) {
  return a.lessThan(b) ? a : b;
}
