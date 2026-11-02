import { ApiError } from "@/lib/rbac";
import type { Tx } from "@/lib/tx";
import type { ServiceActor } from "@/lib/core/actor";
import { D, ZERO, q4, type Dec } from "@/lib/inventory/decimal";
import { lockProductValuations, postMovements, type MoveInput } from "@/lib/inventory/ledger";
import { todayLocalISO } from "@/lib/localDate";
import { writeAudit } from "@/lib/audit";

/**
 * Standard costing (DEFECT-SC-01). A standard-cost product is carried in stock at its
 * standard; what it really cost is a variance:
 *  - purchase price variance (receipts, corrections, voids, supplier returns, provisional
 *    receipts billed): the PPV system account;
 *  - a change of the standard while stock is on hand revalues that stock against the
 *    inventory-adjustments system account, here.
 * Both accounts are the chart's own system accounts. If either is missing or retired the
 * method cannot be used — it fails here, before any stock is touched.
 */
export const STANDARD_COST_ACCOUNTS = ["ppv", "inventory_adjustment"] as const;

export async function assertStandardCostAccounts(tx: Pick<Tx, "account">) {
  const rows = await tx.account.findMany({ where: { systemKey: { in: [...STANDARD_COST_ACCOUNTS] }, active: true, postable: true }, select: { systemKey: true } });
  const have = new Set(rows.map((r) => r.systemKey));
  const missing = STANDARD_COST_ACCOUNTS.filter((k) => !have.has(k));
  if (missing.length) {
    throw new ApiError(409, `التكلفة المعيارية محتاجة حسابات النظام (${missing.join("، ")}) في دليل الحسابات — حددها الأول`, "standard_cost_accounts_missing");
  }
}

/** On-hand quantity of a product, per bucket (only buckets holding stock). */
async function onHandBuckets(tx: Tx, productId: string) {
  const rows = await tx.stockMovement.groupBy({ by: ["warehouseId", "locationId", "lotId"], where: { productId }, _sum: { quantity: true } });
  return rows.map((r) => ({ warehouseId: r.warehouseId, locationId: r.locationId, lotId: r.lotId, qty: D(r._sum.quantity) })).filter((b) => b.qty.gt(0));
}

const r2 = (d: Dec) => d.toDecimalPlaces(2);

/**
 * Records a new standard cost for a standard-cost product inside the caller's transaction
 * and revalues the stock on hand: per bucket, out at the old standard and back in at the
 * new one (net quantity zero), so Inventory moves by (new − old) × on-hand against
 * inventory adjustments. Leaves the product's standardCost set to the new value (without
 * bumping its version — the caller's own versioned update follows).
 */
export async function changeStandardCost(
  tx: Tx,
  product: { id: string; name: string; standardCost: Dec | null; costingMethod: string },
  newStandard: Dec,
  reason: string | null | undefined,
  actor: ServiceActor
) {
  if (!newStandard.gt(0)) throw new ApiError(400, "التكلفة المعيارية لازم تكون أكبر من صفر");
  await assertStandardCostAccounts(tx);
  // The valuation lock first: no receipt or issue of this product can slip in between the
  // on-hand read and the revaluation.
  await lockProductValuations(tx, [product.id]);
  const buckets = product.costingMethod === "standard" ? await onHandBuckets(tx, product.id) : [];
  const onHand = buckets.reduce((s, b) => s.plus(b.qty), ZERO);
  const old = product.standardCost == null ? null : q4(D(product.standardCost));
  const next = q4(newStandard);
  const why = reason?.trim();
  if (onHand.gt(0) && !why) throw new ApiError(400, "اكتب سبب تغيير التكلفة المعيارية — الصنف عليه رصيد هيتعاد تقييمه", "standard_cost_reason_required");

  // What the two valuation entries will post (each rounds its total to the piastre).
  const outTotal = buckets.reduce((s, b) => s.plus(q4(b.qty.negated().times(old ?? 0))), ZERO);
  const inTotal = buckets.reduce((s, b) => s.plus(q4(b.qty.times(next))), ZERO);
  const revaluation = old == null || old.equals(next) ? ZERO : r2(outTotal).plus(r2(inTotal));
  const effectiveDate = todayLocalISO();
  const text = why || "تحديد التكلفة المعيارية";

  const change = await tx.standardCostChange.create({
    data: { productId: product.id, oldStandardCost: old, newStandardCost: next, effectiveDate, onHandQty: onHand, revaluation, reason: text, createdById: actor.id, createdBy: actor.name },
  });
  if (old != null && !old.equals(next) && buckets.length) {
    const ctx = { actorId: actor.id, actorName: actor.name, effectiveDate };
    const base = (b: (typeof buckets)[number]) => ({ productId: product.id, warehouseId: b.warehouseId, locationId: b.locationId, lotId: b.lotId, standardCostChangeId: change.id, reason: `تغيير التكلفة المعيارية من ${old.toFixed(4)} إلى ${next.toFixed(4)}: ${text}` });
    // Out at the standard the product still carries…
    await postMovements(tx, buckets.map((b): MoveInput => ({ ...base(b), quantity: b.qty.negated(), kind: "standard_cost_out" })), ctx);
    await tx.stockProduct.update({ where: { id: product.id }, data: { standardCost: next } });
    // …back in at the new one.
    await postMovements(tx, buckets.map((b): MoveInput => ({ ...base(b), quantity: b.qty, kind: "standard_cost_in" })), ctx);
  } else {
    await tx.stockProduct.update({ where: { id: product.id }, data: { standardCost: next } });
  }
  await writeAudit(
    {
      userId: actor.id, userName: actor.name, role: actor.role,
      action: "standard_cost_changed", entityType: "stock_product", entityId: product.id,
      fieldChanged: "standardCost", oldValue: old?.toFixed(4) ?? null, newValue: next.toFixed(4),
      reason: `${text} · رصيد ${onHand.toFixed()} · إعادة تقييم ${revaluation.toFixed(2)}`, source: "user", deviceId: actor.deviceId,
    },
    tx
  );
  return change;
}

/** A product's standard-cost history, newest first. */
export async function standardCostHistory(db: Pick<Tx, "standardCostChange">, productId: string) {
  const rows = await db.standardCostChange.findMany({ where: { productId }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id, effectiveDate: r.effectiveDate, oldStandardCost: r.oldStandardCost?.toFixed(4) ?? null, newStandardCost: r.newStandardCost.toFixed(4),
    onHandQty: r.onHandQty.toString(), revaluation: r.revaluation.toFixed(2), reason: r.reason, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
  }));
}
