import { postMovementValuation } from "@/lib/accounting/ledger";
import { asText } from "@/lib/http";
import type { Prisma, StockMovement } from "@prisma/client";
import { ApiError } from "@/lib/rbac";
import { advisoryXactLocks } from "@/lib/dbLock";
import type { Tx } from "@/lib/tx";
import { D, ZERO, q3, q4, type Dec } from "@/lib/inventory/decimal";
import { isSellableStock } from "@/lib/inventory/balances";
import { availabilityChanged } from "@/lib/inventory/availability-changes";
import { todayLocalISO } from "@/lib/localDate";
import { newId } from "@/lib/core/ids";

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

  // ---- 3. read once, then value each move in order (each sees the ones before it) --
  // What the per-move checks and costing read — a bucket's balance, a product's valuation, its
  // FIFO layers with stock left — is read ONCE here, under the locks just taken, and then kept
  // current in memory as each move is applied in input order. The arithmetic is the one each
  // move did reading the database after the moves before it were written, so every movement,
  // layer and FIFO consumption is the same; only the round trips are gone (PW-1, Nov 2026:
  // one statement per move and per layer took 20+ line documents past the 20 s limit).
  const reversedIds = moves.map((m) => m.reverses).filter((x): x is string => !!x);
  const methodOf = (m: MoveInput) => productById.get(m.productId)!.costingMethod;
  const outflow = (m: MoveInput) => q3(m.quantity).lt(0);
  // Buckets a removal checks; products whose average cost a move reads; FIFO products a removal consumes.
  const outBuckets = new Map(moves.filter(outflow).map((m) => [bucketKey(m.productId, m.locationId, m.lotId), m]));
  const averaged = [...new Set(moves.filter((m) => !m.reverses && methodOf(m) !== "standard" && m.unitCost == null && (!outflow(m) || methodOf(m) !== "fifo")).map((m) => m.productId))];
  const fifoOut = [...new Set(moves.filter((m) => outflow(m) && methodOf(m) === "fifo").map((m) => m.productId))];
  type Undone = { movementId: string; unitCost: Prisma.Decimal; costSource: string; value: Prisma.Decimal; priceVariance: Prisma.Decimal; kind: string; quantity: Prisma.Decimal; productId: string };
  type Incoming = { id: string; productId: string; unitCost: Prisma.Decimal; remainingQty: Prisma.Decimal; lotId: string | null };
  const [reversedLayers, bucketSums, valuationSums, fifoRows] = await Promise.all([
    // The layers being undone (ACC-03), with the movement each belongs to.
    reversedIds.length
      ? tx.$queryRaw<Undone[]>`SELECT l."movementId", l."unitCost", l."costSource", l."value", l."priceVariance", m."kind", m."quantity", m."productId"
          FROM "StockValuationLayer" l JOIN "StockMovement" m ON m."id" = l."movementId" WHERE l."movementId" = ANY(${reversedIds}::text[])`
      : [],
    outBuckets.size ? tx.stockMovement.groupBy({ by: ["productId", "locationId", "lotId"], where: { OR: [...outBuckets.values()].map((m) => ({ productId: m.productId, locationId: m.locationId, lotId: m.lotId })) }, _sum: { quantity: true } }) : [],
    averaged.length ? tx.stockValuationLayer.groupBy({ by: ["productId"], where: { productId: { in: averaged } }, _sum: { quantity: true, value: true } }) : [],
    // Incoming layers with stock left, in ledger posting order (not timestamps: two receipts in
    // one millisecond must still have a definite "first").
    fifoOut.length
      ? tx.$queryRaw<Incoming[]>`SELECT l."id", l."productId", l."unitCost", l."remainingQty", m."lotId"
          FROM "StockValuationLayer" l JOIN "StockMovement" m ON m."id" = l."movementId"
          WHERE l."productId" = ANY(${fifoOut}::text[]) AND l."remainingQty" > 0 ORDER BY m."seq" ASC`
      : [],
  ]);
  const reversed = new Map(reversedLayers.map((l) => [l.movementId, { ...l, movement: { kind: l.kind, quantity: l.quantity, productId: l.productId } }]));
  const balance = new Map<string, Dec>([...outBuckets.keys()].map((k) => [k, ZERO]));
  for (const b of bucketSums) balance.set(bucketKey(b.productId, b.locationId, b.lotId), D(b._sum.quantity));
  const valuation = new Map<string, { qty: Dec; value: Dec }>(averaged.map((p) => [p, { qty: ZERO, value: ZERO }]));
  for (const v of valuationSums) valuation.set(v.productId, { qty: D(v._sum.quantity), value: D(v._sum.value) });
  const fifoLayers = new Map<string, FifoLayer[]>(fifoOut.map((p) => [p, []]));
  for (const l of fifoRows) fifoLayers.get(l.productId)!.push({ id: l.id, lotId: l.lotId, unitCost: D(l.unitCost), remaining: D(l.remainingQty) });

  const rows: Prisma.StockMovementCreateManyInput[] = [];
  const layers: Prisma.StockValuationLayerCreateManyInput[] = [];
  const consumedBy = new Map<string, Dec>();
  const valued: { movementId: string; kind: string; documentId: string | null; intakeId: string | null; value: Dec; priceVariance: Dec; counterKind?: string }[] = [];
  for (const m of moves) {
    const product = productById.get(m.productId)!;
    const qty = q3(m.quantity);
    const key = bucketKey(m.productId, m.locationId, m.lotId);

    if (qty.lt(0)) {
      const before = balance.get(key)!;
      if (before.plus(qty).lt(0)) {
        const location = locationById.get(m.locationId)!;
        const lot = m.lotId ? lotById.get(m.lotId) : null;
        throw new ApiError(
          400,
          `الرصيد مش كفاية: "${product.name}" في ${location.code}${lot ? ` (${lot.lotNumber})` : ""} فيه ${before.toFixed()} بس، والمطلوب ${qty.abs().toFixed()}`
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
    const productValuationNow = () => ({ ...valuation.get(m.productId)! });
    const planFifoNow = (out: Dec) => planFifo(fifoLayers.get(m.productId)!, m, out, fifoConsumptions);

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
      if (qty.lt(0) && method === "fifo") planFifoNow(qty.abs());
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
        const val = productValuationNow();
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
        if (method === "fifo") planFifoNow(out);
      } else if (method === "fifo") {
        const consumedValue = planFifoNow(out);
        unitCost = out.isZero() ? ZERO : q4(consumedValue.dividedBy(out));
        costSource = consumedValue.isZero() ? "unknown" : "fifo";
        value = q4(consumedValue.negated());
      } else {
        const val = productValuationNow();
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

    // Ids made here, so each layer, FIFO consumption and GL posting names its movement
    // without relying on the order rows come back from a bulk insert.
    const movementId = newId();
    const layerId = newId();
    rows.push({
      id: movementId,
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
    });
    layers.push({ id: layerId, movementId, productId: m.productId, quantity: qty, unitCost, value, remainingQty: qty.gt(0) ? qty : ZERO, costSource, priceVariance });

    // What the next move reads: this one applied.
    if (balance.has(key)) balance.set(key, balance.get(key)!.plus(qty));
    const running = valuation.get(m.productId);
    if (running) valuation.set(m.productId, { qty: running.qty.plus(qty), value: running.value.plus(value) });
    const fifo = fifoLayers.get(m.productId);
    for (const c of fifoConsumptions) {
      const layer = fifo!.find((l) => l.id === c.id)!;
      layer.remaining = layer.remaining.minus(c.take);
      consumedBy.set(c.id, (consumedBy.get(c.id) ?? ZERO).plus(c.take));
    }
    if (fifo && qty.gt(0)) fifo.push({ id: layerId, lotId: m.lotId, unitCost, remaining: qty });
    valued.push({ movementId, kind: m.kind, documentId: m.documentId ?? null, intakeId: m.intakeId ?? null, value, priceVariance, counterKind: undo?.movement.kind });
  }

  // ---- written in bulk: movements (posting order = input order), layers, FIFO consumption --
  // One multi-row INSERT numbers seq in the order of its rows; the bucket trigger still checks
  // every row (after the statement, so against the final balance the checks above kept).
  const inserted = new Map((await tx.stockMovement.createManyAndReturn({ data: rows })).map((r) => [r.id, r]));
  const created = rows.map((r) => inserted.get(r.id!)!);
  await tx.stockValuationLayer.createMany({ data: layers });
  if (consumedBy.size) {
    const ids = [...consumedBy.keys()];
    const takes = ids.map((id) => consumedBy.get(id)!.toFixed());
    await tx.$executeRaw`UPDATE "StockValuationLayer" AS l SET "remainingQty" = l."remainingQty" - c.take
      FROM unnest(${ids}::text[], ${takes}::numeric[]) AS c(id, take) WHERE l."id" = c.id`;
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

type FifoLayer = { id: string; lotId: string | null; unitCost: Dec; remaining: Dec };

/**
 * FIFO cost of taking `out` from a product: incoming layers with stock left (`layers`, in ledger
 * posting order), the removed lot's own layers first (so a perishable lot leaves at its own
 * price), then oldest first. Returns the consumed value and records what each layer gives up.
 * Quantity with no layer behind it (stock from before costs were recorded) leaves at
 * zero cost — it is reported as unvalued, never invented.
 */
function planFifo(layers: FifoLayer[], m: MoveInput, out: Dec, plan: { id: string; take: Dec }[]): Dec {
  const live = layers.filter((l) => l.remaining.gt(0));
  const ordered = [
    ...live.filter((l) => m.lotId && l.lotId === m.lotId),
    ...live.filter((l) => !(m.lotId && l.lotId === m.lotId)),
  ];
  let left = out;
  let consumed = ZERO;
  for (const l of ordered) {
    if (left.isZero()) break;
    const take = minDec(left, l.remaining);
    consumed = consumed.plus(take.times(l.unitCost));
    plan.push({ id: l.id, take });
    left = left.minus(take);
  }
  return consumed;
}

function minDec(a: Dec, b: Dec) {
  return a.lessThan(b) ? a : b;
}
