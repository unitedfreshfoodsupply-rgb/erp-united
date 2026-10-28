/**
 * Grading-cost allocation for produce sorting (فرز).
 *
 * One entry point for BOTH intake-time grading and post-receipt sorting.
 * Under the default `proportional` policy every output keeps the input unit
 * cost (the F-02 fix for separate-SKU Grade B). Under `nrv` the input cost
 * is split by relative net realisable value once prices are supplied.
 *
 * The function is pure — no database access, no side effects. All inputs
 * are known at the call site.
 */
import { Prisma } from "@prisma/client";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
const q4 = (d: Prisma.Decimal) => d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
type Dec = Prisma.Decimal;

export type GradingCostPolicy = "proportional" | "nrv";
export type WasteLossPolicy = "zero_basis" | "expense_at_grading";
export type CostBasis = "proportional" | "nrv" | "nrv_fallback_proportional";

export type GradingCostsInput = {
  inputQty: Dec;
  /** The unit cost of the input batch — the purchase cost at intake,
   *  the raw product's moving average at post-receipt sorting. */
  inputUnitCost: Dec;
  goodQty: Dec;
  gradeBQty: Dec;
  wasteQty: Dec;
  /** Effective selling price per the default price list, null when missing / stale. */
  goodPrice: Dec | null;
  gradeBPrice: Dec | null;
  policy: GradingCostPolicy;
  wastePolicy: WasteLossPolicy;
};

export type GradingCostsResult = {
  goodUnitCost: Dec;
  gradeBUnitCost: Dec;
  wasteUnitCost: Dec;
  /** The loss to recognise as a grading-period expense (0 under proportional / zero_basis). */
  wasteLoss: Dec;
  costBasis: CostBasis;
  fallbackReason: "missing_price" | "stale_price" | "invalid_price" | null;
  /** The total value this event allocates (inputQty × inputUnitCost). */
  allocatedInput: Dec;
};

/**
 * Pure function.
 *
 * `proportional` — each output kg keeps the input unit cost (conserved).
 * `nrv` — split by relative NRV with optional waste expense recognition;
 *         missing prices trigger fallback (caller must audit & payload-mark).
 */
export function computeGradingCosts(input: GradingCostsInput): GradingCostsResult {
  const totalValue = q4(input.inputQty.times(input.inputUnitCost));
  const nonZeroQty = (x: Dec) => x.gt(0);

  // ------ proportional (default, current intake behaviour) ------
  if (input.policy === "proportional") {
    return {
      goodUnitCost: q4(input.inputUnitCost),
      gradeBUnitCost: q4(input.inputUnitCost),
      wasteUnitCost: q4(input.inputUnitCost),
      wasteLoss: ZERO,
      costBasis: "proportional",
      fallbackReason: null,
      allocatedInput: totalValue,
    };
  }

  // ------ NRV (requires valid prices only when BOTH saleable outputs exist) ------
  // With a single saleable output the NRV ratio degenerates to 1 — no market
  // price is needed, the output absorbs the allocable value by weight.
  const twoSaleable = input.goodQty.gt(0) && input.gradeBQty.gt(0);
  const priceValid = (p: Dec | null) => p !== null && p.gt(0);
  const goodPriceOk = !twoSaleable || priceValid(input.goodPrice);
  const gbPriceOk = !twoSaleable || priceValid(input.gradeBPrice);

  if (!goodPriceOk || !gbPriceOk) {
    // Fallback to proportional — caller must write audit + payload marker.
    return {
      goodUnitCost: q4(input.inputUnitCost),
      gradeBUnitCost: q4(input.inputUnitCost),
      wasteUnitCost: q4(input.inputUnitCost),
      wasteLoss: ZERO,
      costBasis: "nrv_fallback_proportional",
      fallbackReason: !goodPriceOk ? "missing_price" : "stale_price",
      allocatedInput: totalValue,
    };
  }

  // Waste loss recognition (expense vs carry)
  const wasteBasis = D(input.wastePolicy === "expense_at_grading" && input.wasteQty.gt(0)
    ? input.wasteQty.times(input.inputUnitCost)
    : ZERO);
  const wasteLoss = q4(nonZeroQty(input.wasteQty) ? wasteBasis : ZERO);

  // Allocable value after removing the waste loss
  // Under expense_at_grading: the waste loss leaves inventory (Dr 5200), so only
  // the remainder is distributed to Good and Grade B.
  // Under zero_basis: waste has 0 NRV and gets no cost share — the full totalValue
  // goes to the saleable outputs.
  const allocable = q4(totalValue.minus(wasteLoss));

  if (!nonZeroQty(input.goodQty) && !nonZeroQty(input.gradeBQty)) {
    // Nothing left to allocate — all waste. Single output.
    return {
      goodUnitCost: ZERO, gradeBUnitCost: ZERO, wasteUnitCost: ZERO,
      wasteLoss, costBasis: "nrv" as const, fallbackReason: null, allocatedInput: totalValue,
    };
  }

  // A single saleable output: no market price is involved — it absorbs the
  // allocable value by weight (NRV ratio degenerates to 1).
  if (!twoSaleable) {
    const onlyGood = nonZeroQty(input.goodQty);
    const singleQty = onlyGood ? input.goodQty : input.gradeBQty;
    const singleCost = q4(allocable.dividedBy(singleQty));
    return {
      goodUnitCost: onlyGood ? singleCost : ZERO,
      gradeBUnitCost: onlyGood ? ZERO : singleCost,
      wasteUnitCost: ZERO,
      wasteLoss,
      costBasis: "nrv" as const,
      fallbackReason: null,
      allocatedInput: totalValue,
    };
  }

  const nrvGood = nonZeroQty(input.goodQty) ? input.goodQty.times(input.goodPrice!) : ZERO;
  const nrvGb   = nonZeroQty(input.gradeBQty) ? input.gradeBQty.times(input.gradeBPrice!) : ZERO;
  const nrvDenom = nrvGood.plus(nrvGb);

  // Allocate k-1 outputs exactly; the k-th (Good, the largest) gets the residual.
  // The residual rule guarantees exact conservation to 4 dp.
  let costGb = ZERO;
  if (nonZeroQty(input.gradeBQty) && nrvDenom.gt(0)) {
    costGb = q4(allocable.times(nrvGb).dividedBy(nrvDenom));
  }
  const costGood = q4(allocable.minus(costGb));

  const gbUnit = nonZeroQty(input.gradeBQty) ? q4(costGb.dividedBy(input.gradeBQty)) : ZERO;
  const goodUnit = nonZeroQty(input.goodQty) ? q4(costGood.dividedBy(input.goodQty)) : ZERO;

  return {
    goodUnitCost: goodUnit,
    gradeBUnitCost: gbUnit,
    wasteUnitCost: ZERO,          // waste value = 0 after NRV allocation
    wasteLoss,
    costBasis: "nrv",
    fallbackReason: null,
    allocatedInput: totalValue,
  };
}