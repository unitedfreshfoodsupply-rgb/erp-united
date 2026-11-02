import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import type { Tx } from "@/lib/tx";
import { lockProductValuations, postMovements, type MoveInput } from "@/lib/inventory/ledger";

/**
 * WS3 (remediation 2026-11) ACC-E1 — receipts at a PROVISIONAL cost, revalued by the bill.
 *
 * A receipt with no agreed price (no PO line, no unit cost, no dated supplier price) enters
 * stock at a provisional unit cost the receiver states (costSource "provisional"); GRNI is
 * credited at that value. When the supplier bill posts, the difference
 *
 *     Δ = billed net − provisional value (accepted quantity × provisional unit cost)
 *
 * is split by where the receipt's units are at that moment — read from the stock ledger,
 * per product (a Grade-B SKU sorted out of the receipt is its own product):
 *
 *   still on hand              → Inventory: a revaluation_out / revaluation_in pair on each
 *                                bucket of the receipt's lots (net quantity zero), so the
 *                                valuation layers and the GL move together (counter GRNI);
 *   issued to customers (net)  → COGS;
 *   scrapped / adjusted        → inventory adjustments;
 *   returned to the supplier   → PPV (the debit note for that return credits it back).
 *
 * The receipt's GRNI clears at provisional value + the inventory part; nothing is a price
 * variance — there was no agreed price to vary from. The lot's unit cost moves to the
 * billed cost, so a later return to the supplier leaves at what was billed.
 *
 * A debit note that takes back part of such a line's price WITHOUT goods going back (an
 * allowance) changes the receipt's cost the same way, by the amount credited: each row
 * points at the bill's row it reverses. A debit note for the whole line takes back the
 * bill's revaluation exactly (and the provisional base with it). Goods that go back leave
 * stock at their lot's cost (already the billed cost) — that path is unchanged.
 *
 * Every row is kept (StockRevaluation, never deleted); the movements point at it.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const q4 = (d: Prisma.Decimal) => d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
const q6 = (d: Prisma.Decimal) => d.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
type Dec = Prisma.Decimal;
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

const GONE_COGS = ["issue", "customer_return"];
const GONE_ADJ = ["scrap", "adjustment"];
const GONE_RET = ["supplier_return"];

type Bucket = { productId: string; warehouseId: string; locationId: string; lotId: string; qty: Dec };
export type ReceiptUnits = { productId: string; lotIds: string[]; onHand: Dec; cogsQty: Dec; adjQty: Dec; retQty: Dec; basis: Dec; buckets: Bucket[] };

/** Accepted quantity of a receipt (good + Grade B + waste), as billed. */
const acceptedQty = (r: { receivedQty: Prisma.Decimal.Value; rejectedQty: Prisma.Decimal.Value }) => D(r.receivedQty).minus(r.rejectedQty);

/**
 * Where a receipt's units are now, per product: the lots its movements created (its own
 * lot, a Grade-B lot sorted from it), their buckets with stock, and the net quantity that
 * left them by kind. Transfers, releases and sorting are moves inside stock (they keep the
 * lot or land in another lot of the receipt) and show up in the bucket balances.
 * Call after the products' valuation locks are held.
 */
export async function receiptUnits(tx: Tx, intakeId: string): Promise<ReceiptUnits[]> {
  const lotRows = await tx.stockMovement.findMany({ where: { intakeId, lotId: { not: null } }, distinct: ["productId", "lotId"], select: { productId: true, lotId: true } });
  if (!lotRows.length) return [];
  const lotIds = [...new Set(lotRows.map((l) => l.lotId!))];
  const [buckets, gone] = await Promise.all([
    tx.stockMovement.groupBy({ by: ["productId", "warehouseId", "locationId", "lotId"], where: { lotId: { in: lotIds } }, _sum: { quantity: true } }),
    tx.stockMovement.groupBy({ by: ["productId", "kind"], where: { lotId: { in: lotIds }, kind: { in: [...GONE_COGS, ...GONE_ADJ, ...GONE_RET] } }, _sum: { quantity: true } }),
  ]);
  const products = [...new Set(lotRows.map((l) => l.productId))].sort();
  return products.map((productId) => {
    const own = buckets.filter((b) => b.productId === productId && D(b._sum.quantity ?? 0).gt(0)).map((b) => ({ productId, warehouseId: b.warehouseId, locationId: b.locationId, lotId: b.lotId!, qty: D(b._sum.quantity ?? 0) }));
    own.sort((a, b) => `${a.locationId}|${a.lotId}`.localeCompare(`${b.locationId}|${b.lotId}`));
    const out = (kinds: string[]) => {
      const net = gone.filter((g) => g.productId === productId && kinds.includes(g.kind)).reduce((s, g) => s.plus(g._sum.quantity ?? 0), ZERO).negated();
      return net.gt(0) ? net : ZERO;
    };
    const onHand = own.reduce((s, b) => s.plus(b.qty), ZERO);
    const cogsQty = out(GONE_COGS), adjQty = out(GONE_ADJ), retQty = out(GONE_RET);
    return { productId, lotIds: [...new Set(lotRows.filter((l) => l.productId === productId).map((l) => l.lotId!))], onHand, cogsQty, adjQty, retQty, basis: onHand.plus(cogsQty).plus(adjQty).plus(retQty), buckets: own };
  }).filter((u) => u.basis.gt(0));
}

/** The products a receipt's units are in (its own, and a Grade-B SKU sorted out of it). */
async function receiptProductIds(tx: Tx, intakeId: string) {
  const rows = await tx.stockMovement.findMany({ where: { intakeId, lotId: { not: null } }, distinct: ["productId"], select: { productId: true } });
  return rows.map((r) => r.productId);
}

/** Valuation locks for every product the receipts touch, taken once in the global (sorted) order. */
async function lockReceipts(tx: Tx, intakeIds: string[]) {
  const ids = new Set<string>();
  for (const id of intakeIds) for (const p of await receiptProductIds(tx, id)) ids.add(p);
  await lockProductValuations(tx, [...ids]);
}

/** Splits an amount (signed) between where the units are: on hand, sold, written off, returned. */
export function splitByUnits(amount: Dec, u: Pick<ReceiptUnits, "onHand" | "cogsQty" | "adjQty" | "retQty" | "basis">) {
  const inventory = u.basis.isZero() ? ZERO : r2(amount.times(u.onHand).dividedBy(u.basis));
  const rest = amount.minus(inventory);
  const gone = u.cogsQty.plus(u.adjQty).plus(u.retQty);
  const adjustment = gone.isZero() ? ZERO : r2(rest.times(u.adjQty).dividedBy(gone));
  const ppv = gone.isZero() ? ZERO : r2(rest.times(u.retQty).dividedBy(gone));
  return { inventory, cogs: rest.minus(adjustment).minus(ppv), adjustment, ppv };
}

/**
 * DEFECT-SC-01: a standard-cost product's stock, its sales and its write-offs are all
 * carried at the standard — a provisional receipt price turning into the billed price
 * changes none of them. The whole difference is a purchase price variance.
 */
function planFor(amount: Dec, u: ReceiptUnits, standard: ReadonlySet<string>) {
  return standard.has(u.productId) ? { inventory: ZERO, cogs: ZERO, adjustment: ZERO, ppv: amount } : splitByUnits(amount, u);
}

async function standardCostProducts(tx: Tx, units: ReceiptUnits[]): Promise<ReadonlySet<string>> {
  const rows = await tx.stockProduct.findMany({ where: { id: { in: units.map((u) => u.productId) }, costingMethod: "standard" }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** Splits an amount across products by their units; the last takes the remainder (exact). */
function shareByProduct(amount: Dec, units: ReceiptUnits[]) {
  const total = units.reduce((s, u) => s.plus(u.basis), ZERO);
  let left = amount;
  return units.map((u, i) => {
    const share = i === units.length - 1 ? left : r2(amount.times(u.basis).dividedBy(total));
    left = left.minus(share);
    return share;
  });
}

/**
 * Moves the on-hand units of one product of a receipt by `amount` (signed): an out/in pair
 * per bucket, the in priced at the out's own cost plus the change per unit. Returns what
 * actually reached the GL (the two valuation entries, each rounded to the piastre).
 */
async function revalueOnHand(tx: Tx, u: ReceiptUnits, amount: Dec, ctx: { intakeId: string; revaluationId: string; reason: string; date: string; actor: Actorish }) {
  if (amount.isZero() || u.onHand.isZero() || !u.buckets.length) return ZERO;
  const perUnit = amount.dividedBy(u.onHand);
  const mctx = { actorId: ctx.actor.id, actorName: ctx.actor.name, effectiveDate: ctx.date };
  const base = (b: Bucket) => ({ productId: b.productId, warehouseId: b.warehouseId, locationId: b.locationId, lotId: b.lotId, intakeId: ctx.intakeId, revaluationId: ctx.revaluationId, reason: ctx.reason });
  const outs: MoveInput[] = u.buckets.map((b) => ({ ...base(b), quantity: b.qty.negated(), kind: "revaluation_out" }));
  const outRows = await postMovements(tx, outs, mctx);
  const ins: MoveInput[] = outRows.map((o, i) => {
    const unit = D(o.unitCost ?? 0).plus(perUnit);
    if (unit.lt(0)) throw new ApiError(409, `تخفيض التكلفة أكبر من قيمة المخزون الحالية للصنف — راجع سعر الفاتورة أو الإشعار`);
    return { ...base(u.buckets[i]), quantity: u.buckets[i].qty, kind: "revaluation_in", unitCost: q4(unit), costSource: "revaluation" };
  });
  const inRows = await postMovements(tx, ins, mctx);
  const layers = await tx.stockValuationLayer.findMany({ where: { movementId: { in: [...outRows, ...inRows].map((m) => m.id) } }, select: { movementId: true, value: true } });
  const outIds = new Set(outRows.map((m) => m.id));
  const sum = (pick: (id: string) => boolean) => layers.filter((l) => pick(l.movementId)).reduce((s, l) => s.plus(l.value), ZERO);
  // postMovementValuation posts one entry per call: Inventory ± r2(Σ values) ↔ GRNI.
  return r2(sum((id) => outIds.has(id))).plus(r2(sum((id) => !outIds.has(id))));
}

/** The lots of a product of the receipt move to the new unit cost (what a return to the supplier leaves at). */
async function shiftLotCost(tx: Tx, u: ReceiptUnits, perUnit: Dec, actor: Actorish, why: string) {
  if (perUnit.isZero()) return;
  const lots = await tx.stockLot.findMany({ where: { id: { in: u.lotIds }, unitCost: { not: null } } });
  for (const lot of lots) {
    const next = q4(D(lot.unitCost!).plus(perUnit));
    if (next.lt(0)) throw new ApiError(409, `تكلفة الدفعة ${lot.lotNumber} هتبقى بالسالب — راجع سعر الفاتورة أو الإشعار`);
    await tx.stockLot.update({ where: { id: lot.id }, data: { unitCost: next } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "stock_lot_cost_revalued", entityType: "stock_lot", entityId: lot.id, fieldChanged: "unitCost", oldValue: D(lot.unitCost!).toFixed(4), newValue: next.toFixed(4), reason: why, source: "user", deviceId: actor.deviceId }, tx);
  }
}

export type RevaluationTotals = { grni: Dec; inventory: Dec; cogs: Dec; adjustment: Dec; ppv: Dec; lines: number };

/**
 * Called by postSupplierBill (goods), in the bill's transaction, before its journal entry.
 * Returns what that entry must carry for the provisional lines: GRNI to clear (provisional
 * value + inventory revaluation already posted), COGS, adjustments, PPV (returned units).
 */
export async function revalueOnBill(tx: Tx, billId: string, actor: Actorish): Promise<RevaluationTotals> {
  const totals: RevaluationTotals = { grni: ZERO, inventory: ZERO, cogs: ZERO, adjustment: ZERO, ppv: ZERO, lines: 0 };
  const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: { orderBy: { lineNo: "asc" }, include: { intake: true } } } });
  const lines = bill.lines.filter((l) => l.intake.costProvisional);
  if (!lines.length) return totals;
  if (await tx.stockRevaluation.findFirst({ where: { billId, sourceType: "supplier_bill" }, select: { id: true } })) throw new ApiError(409, `الفاتورة ${bill.number} اتعمل لها إعادة تقييم قبل كده`);
  await lockReceipts(tx, lines.map((l) => l.intakeId));
  for (const l of lines) {
    const r = l.intake;
    const provisional = D(r.unitCost!);
    const provisionalValue = r2(acceptedQty(r).times(provisional));
    const delta = D(l.net).minus(provisionalValue);
    const units = await receiptUnits(tx, r.id);
    if (!units.length) throw new ApiError(409, `الاستلام ${r.receiptNumber}: مش لاقي كمياته في دفتر المخزون — مينفعش يتعاد تقييمه`);
    const standard = await standardCostProducts(tx, units);
    const shares = shareByProduct(delta, units);
    const reason = `إعادة تقييم الاستلام ${r.receiptNumber} (سعر مؤقت ${provisional.toFixed(4)}) بفاتورة ${bill.number}`;
    totals.grni = totals.grni.plus(provisionalValue);
    for (const [i, u] of units.entries()) {
      const amount = shares[i];
      const plan = planFor(amount, u, standard);
      const row = await tx.stockRevaluation.create({
        data: {
          sourceType: "supplier_bill", billId, billLineId: l.id, intakeId: r.id, productId: u.productId, date: bill.billDate,
          basisQty: u.basis, onHandQty: u.onHand, provisionalUnitCost: provisional, unitDelta: q6(amount.dividedBy(u.basis)),
          delta: amount, inventoryDelta: plan.inventory, cogsDelta: plan.cogs, adjustmentDelta: plan.adjustment, ppvDelta: plan.ppv,
          createdById: actor.id, createdBy: actor.name,
        },
      });
      const inventory = await revalueOnHand(tx, u, plan.inventory, { intakeId: r.id, revaluationId: row.id, reason, date: bill.billDate, actor });
      // What reached the GL is the inventory part; the cost of the sold units absorbs the piastre.
      const cogs = amount.minus(inventory).minus(plan.adjustment).minus(plan.ppv);
      if (!inventory.equals(plan.inventory)) await tx.stockRevaluation.update({ where: { id: row.id }, data: { inventoryDelta: inventory, cogsDelta: cogs } });
      await shiftLotCost(tx, u, amount.dividedBy(u.basis), actor, reason);
      totals.grni = totals.grni.plus(inventory);
      totals.inventory = totals.inventory.plus(inventory);
      totals.cogs = totals.cogs.plus(cogs);
      totals.adjustment = totals.adjustment.plus(plan.adjustment);
      totals.ppv = totals.ppv.plus(plan.ppv);
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "stock_revaluation_posted", entityType: "stock_revaluation", entityId: row.id, fieldChanged: r.receiptNumber, oldValue: provisionalValue.toFixed(2), newValue: `فرق ${amount.toFixed(2)} · مخزون ${inventory.toFixed(2)} · تكلفة مبيعات ${cogs.toFixed(2)} · تسويات ${plan.adjustment.toFixed(2)} · فروق أسعار ${plan.ppv.toFixed(2)}`, reason, source: "user", deviceId: actor.deviceId }, tx);
    }
    totals.lines++;
  }
  return totals;
}

/**
 * Called by postDebitNote for a debit note with no goods back, in its transaction, before
 * its journal entry. For each line on a provisional receipt: the amount credited (the
 * line's net) lowers the receipt's cost, split the same way as the bill's difference.
 */
export async function revalueOnDebitNote(tx: Tx, debitNoteId: string, actor: Actorish): Promise<RevaluationTotals> {
  const totals: RevaluationTotals = { grni: ZERO, inventory: ZERO, cogs: ZERO, adjustment: ZERO, ppv: ZERO, lines: 0 };
  const dn = await tx.debitNote.findUniqueOrThrow({ where: { id: debitNoteId }, include: { bill: { select: { id: true, number: true } }, lines: { include: { billLine: { include: { intake: true } } } } } });
  if (dn.returnDocumentId) return totals;
  const lines = dn.lines.filter((l) => l.billLine.intake.costProvisional);
  if (!lines.length) return totals;
  await lockReceipts(tx, lines.map((l) => l.billLine.intakeId));
  for (const l of lines) {
    const r = l.billLine.intake;
    const originals = await tx.stockRevaluation.findMany({ where: { billLineId: l.billLineId, sourceType: "supplier_bill" } });
    if (!originals.length) throw new ApiError(409, `سطر الفاتورة ${dn.bill.number} على الاستلام ${r.receiptNumber} مالوش إعادة تقييم — مينفعش إشعار مدين بتخفيض تكلفته`);
    const units = await receiptUnits(tx, r.id);
    if (!units.length) throw new ApiError(409, `الاستلام ${r.receiptNumber}: مش لاقي كمياته في دفتر المخزون`);
    const standard = await standardCostProducts(tx, units);
    const credited = D(l.net).negated();
    const shares = shareByProduct(credited, units);
    const reason = `تخفيض تكلفة الاستلام ${r.receiptNumber} بإشعار مدين ${dn.number} على ${dn.bill.number}`;
    for (const [i, u] of units.entries()) {
      const amount = shares[i];
      const of = originals.find((o) => o.productId === u.productId) ?? originals[0];
      const plan = planFor(amount, u, standard);
      const row = await tx.stockRevaluation.create({
        data: {
          sourceType: "debit_note", billId: dn.billId, billLineId: l.billLineId, debitNoteId: dn.id, reversalOfId: of.id, intakeId: r.id, productId: u.productId, date: dn.issueDate,
          basisQty: u.basis, onHandQty: u.onHand, provisionalUnitCost: of.provisionalUnitCost, unitDelta: q6(amount.dividedBy(u.basis)),
          delta: amount, inventoryDelta: plan.inventory, cogsDelta: plan.cogs, adjustmentDelta: plan.adjustment, ppvDelta: plan.ppv,
          createdById: actor.id, createdBy: actor.name,
        },
      });
      const inventory = await revalueOnHand(tx, u, plan.inventory, { intakeId: r.id, revaluationId: row.id, reason, date: dn.issueDate, actor });
      const cogs = amount.minus(inventory).minus(plan.adjustment).minus(plan.ppv);
      if (!inventory.equals(plan.inventory)) await tx.stockRevaluation.update({ where: { id: row.id }, data: { inventoryDelta: inventory, cogsDelta: cogs } });
      await shiftLotCost(tx, u, amount.dividedBy(u.basis), actor, reason);
      totals.grni = totals.grni.plus(inventory);
      totals.inventory = totals.inventory.plus(inventory);
      totals.cogs = totals.cogs.plus(cogs);
      totals.adjustment = totals.adjustment.plus(plan.adjustment);
      totals.ppv = totals.ppv.plus(plan.ppv);
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "stock_revaluation_reversed", entityType: "stock_revaluation", entityId: row.id, fieldChanged: r.receiptNumber, oldValue: of.id, newValue: `${amount.toFixed(2)} · مخزون ${inventory.toFixed(2)} · تكلفة مبيعات ${cogs.toFixed(2)} · تسويات ${plan.adjustment.toFixed(2)} · فروق أسعار ${plan.ppv.toFixed(2)}`, reason, source: "user", deviceId: actor.deviceId }, tx);
    }
    totals.lines++;
  }
  return totals;
}

/** A receipt's revaluation history (bill and debit notes), for the receipt and bill screens. */
export async function revaluationsOf(db: Pick<Tx, "stockRevaluation">, where: { intakeId?: string; billId?: string }) {
  const rows = await db.stockRevaluation.findMany({ where, orderBy: { createdAt: "asc" }, include: { debitNote: { select: { number: true } }, bill: { select: { number: true } } } });
  return rows.map((r) => ({
    id: r.id, sourceType: r.sourceType, bill: r.bill.number, debitNote: r.debitNote?.number ?? null, reversalOfId: r.reversalOfId, intakeId: r.intakeId, productId: r.productId, date: r.date,
    basisQty: r.basisQty.toString(), onHandQty: r.onHandQty.toString(), provisionalUnitCost: r.provisionalUnitCost.toFixed(4), unitDelta: r.unitDelta.toString(),
    delta: r.delta.toFixed(2), inventory: r.inventoryDelta.toFixed(2), cogs: r.cogsDelta.toFixed(2), adjustment: r.adjustmentDelta.toFixed(2), ppv: r.ppvDelta.toFixed(2),
  }));
}
