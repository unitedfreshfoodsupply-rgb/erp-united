import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/rbac";
import { writeAuditMany, type AuditInput } from "@/lib/audit";
import { newId } from "@/lib/core/ids";
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
  return (await receiptUnitsOf(tx, [intakeId])).get(intakeId) ?? [];
}

/** receiptUnits for several receipts in three reads, whatever their number (Nov 2026). */
export async function receiptUnitsOf(tx: Tx, intakeIds: string[]): Promise<Map<string, ReceiptUnits[]>> {
  const out = new Map<string, ReceiptUnits[]>();
  const allLots = await tx.stockMovement.findMany({ where: { intakeId: { in: intakeIds }, lotId: { not: null } }, distinct: ["intakeId", "productId", "lotId"], select: { intakeId: true, productId: true, lotId: true } });
  if (!allLots.length) return out;
  const lotIds = [...new Set(allLots.map((l) => l.lotId!))];
  const [allBuckets, allGone] = await Promise.all([
    tx.stockMovement.groupBy({ by: ["productId", "warehouseId", "locationId", "lotId"], where: { lotId: { in: lotIds } }, _sum: { quantity: true } }),
    tx.stockMovement.groupBy({ by: ["lotId", "productId", "kind"], where: { lotId: { in: lotIds }, kind: { in: [...GONE_COGS, ...GONE_ADJ, ...GONE_RET] } }, _sum: { quantity: true } }),
  ]);
  for (const intakeId of new Set(intakeIds)) {
    const lotRows = allLots.filter((l) => l.intakeId === intakeId);
    if (!lotRows.length) continue;
    const mine = new Set(lotRows.map((l) => l.lotId!));
    const buckets = allBuckets.filter((b) => mine.has(b.lotId!));
    const gone = allGone.filter((g) => mine.has(g.lotId!));
    const products = [...new Set(lotRows.map((l) => l.productId))].sort();
    out.set(intakeId, products.map((productId) => {
      const own = buckets.filter((b) => b.productId === productId && D(b._sum.quantity ?? 0).gt(0)).map((b) => ({ productId, warehouseId: b.warehouseId, locationId: b.locationId, lotId: b.lotId!, qty: D(b._sum.quantity ?? 0) }));
      own.sort((a, b) => `${a.locationId}|${a.lotId}`.localeCompare(`${b.locationId}|${b.lotId}`));
      const left = (kinds: string[]) => {
        const net = gone.filter((g) => g.productId === productId && kinds.includes(g.kind)).reduce((s, g) => s.plus(g._sum.quantity ?? 0), ZERO).negated();
        return net.gt(0) ? net : ZERO;
      };
      const onHand = own.reduce((s, b) => s.plus(b.qty), ZERO);
      const cogsQty = left(GONE_COGS), adjQty = left(GONE_ADJ), retQty = left(GONE_RET);
      return { productId, lotIds: [...new Set(lotRows.filter((l) => l.productId === productId).map((l) => l.lotId!))], onHand, cogsQty, adjQty, retQty, basis: onHand.plus(cogsQty).plus(adjQty).plus(retQty), buckets: own };
    }).filter((u) => u.basis.gt(0)));
  }
  return out;
}

/** Valuation locks for every product the receipts touch, taken once in the global (sorted) order. */
async function lockReceipts(tx: Tx, intakeIds: string[]) {
  const rows = await tx.stockMovement.findMany({ where: { intakeId: { in: intakeIds }, lotId: { not: null } }, distinct: ["productId"], select: { productId: true } });
  await lockProductValuations(tx, rows.map((r) => r.productId));
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
 * per bucket, the in priced at the out's own cost plus the change per unit. Returns the
 * movements it posted (out, in); what reached the GL is read from their layers afterwards.
 */
async function revalueOnHand(tx: Tx, u: ReceiptUnits, amount: Dec, ctx: { intakeId: string; revaluationId: string; reason: string; date: string; actor: Actorish }) {
  if (amount.isZero() || u.onHand.isZero() || !u.buckets.length) return null;
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
  return { outIds: outRows.map((m) => m.id), inIds: inRows.map((m) => m.id) };
}

type Plan = ReturnType<typeof planFor>;
/** One StockRevaluation row to write: a product of a receipt line. */
type UnitJob = {
  u: ReceiptUnits;
  amount: Dec;
  plan: Plan;
  data: Omit<Prisma.StockRevaluationCreateManyInput, "id">;
  audit: (rowId: string, inventory: Dec, cogs: Dec) => AuditInput;
};
type LineJob = { intakeId: string; reason: string; date: string; units: UnitJob[] };

/**
 * Writes the revaluation of every line, in line order, with the same rows, movements, lot
 * costs and audit rows as one line at a time (Nov 2026: ~60 statements per line with stock
 * on hand, so a bill of ~8 provisional receipts ran past the 20 s limit). The rows are
 * created first (the movements point at them), each line's on-hand units are moved by their
 * own pair of postMovements calls as before — one stock-valuation entry each — and the lot
 * costs, corrections and audit rows are written once at the end. Refusals are raised at the
 * same point as before.
 */
async function applyRevaluations(tx: Tx, jobs: LineJob[], actor: Actorish, totals: RevaluationTotals) {
  const units = jobs.flatMap((j) => j.units.map((x) => ({ ...x, job: j, id: newId() })));
  if (!units.length) return;
  const lotIds = [...new Set(units.flatMap((x) => x.u.lotIds))];
  const [, lots] = await Promise.all([
    tx.stockRevaluation.createMany({ data: units.map((x) => ({ id: x.id, ...x.data })) }),
    lotIds.length ? tx.stockLot.findMany({ where: { id: { in: lotIds }, unitCost: { not: null } } }) : [],
  ]);
  const lotCost = new Map(lots.map((l) => [l.id, D(l.unitCost!)]));
  const moved: ({ outIds: string[]; inIds: string[] } | null)[] = [];
  const lotAudits: AuditInput[][] = [];
  const changedLots = new Set<string>();
  for (const x of units) {
    moved.push(await revalueOnHand(tx, x.u, x.plan.inventory, { intakeId: x.job.intakeId, revaluationId: x.id, reason: x.job.reason, date: x.job.date, actor }));
    // The lots of the product move to the new unit cost (what a return to the supplier leaves at).
    const perUnit = x.amount.dividedBy(x.u.basis);
    const audits: AuditInput[] = [];
    if (!perUnit.isZero()) {
      const mine = new Set(x.u.lotIds);
      for (const lot of lots.filter((l) => mine.has(l.id))) {
        const before = lotCost.get(lot.id)!;
        const next = q4(before.plus(perUnit));
        if (next.lt(0)) throw new ApiError(409, `تكلفة الدفعة ${lot.lotNumber} هتبقى بالسالب — راجع سعر الفاتورة أو الإشعار`);
        lotCost.set(lot.id, next);
        changedLots.add(lot.id);
        audits.push({ userId: actor.id, userName: actor.name, role: actor.role, action: "stock_lot_cost_revalued", entityType: "stock_lot", entityId: lot.id, fieldChanged: "unitCost", oldValue: before.toFixed(4), newValue: next.toFixed(4), reason: x.job.reason, source: "user", deviceId: actor.deviceId });
      }
    }
    lotAudits.push(audits);
  }
  const movementIds = moved.flatMap((m) => (m ? [...m.outIds, ...m.inIds] : []));
  const layers = movementIds.length ? await tx.stockValuationLayer.findMany({ where: { movementId: { in: movementIds } }, select: { movementId: true, value: true } }) : [];
  const valueOf = new Map<string, Dec>();
  for (const l of layers) valueOf.set(l.movementId, (valueOf.get(l.movementId) ?? ZERO).plus(l.value));
  const sum = (ids: string[]) => ids.reduce((s, id) => s.plus(valueOf.get(id) ?? ZERO), ZERO);
  const corrections: Prisma.Sql[] = [];
  const audits: AuditInput[] = [];
  for (const [i, x] of units.entries()) {
    const m = moved[i];
    // postMovementValuation posts one entry per call: Inventory ± r2(Σ values) ↔ GRNI.
    const inventory = m ? r2(sum(m.outIds)).plus(r2(sum(m.inIds))) : ZERO;
    // What reached the GL is the inventory part; the cost of the sold units absorbs the piastre.
    const cogs = x.amount.minus(inventory).minus(x.plan.adjustment).minus(x.plan.ppv);
    if (!inventory.equals(x.plan.inventory)) corrections.push(Prisma.sql`(${x.id}::text, ${inventory.toString()}::numeric, ${cogs.toString()}::numeric)`);
    totals.grni = totals.grni.plus(inventory);
    totals.inventory = totals.inventory.plus(inventory);
    totals.cogs = totals.cogs.plus(cogs);
    totals.adjustment = totals.adjustment.plus(x.plan.adjustment);
    totals.ppv = totals.ppv.plus(x.plan.ppv);
    audits.push(...lotAudits[i], x.audit(x.id, inventory, cogs));
  }
  if (corrections.length) {
    await tx.$executeRaw`UPDATE "StockRevaluation" AS r SET "inventoryDelta" = v.inventory, "cogsDelta" = v.cogs
      FROM (VALUES ${Prisma.join(corrections)}) AS v(id, inventory, cogs) WHERE r."id" = v.id`;
  }
  if (changedLots.size) {
    const values = [...changedLots].map((id) => Prisma.sql`(${id}::text, ${lotCost.get(id)!.toString()}::numeric)`);
    await tx.$executeRaw`UPDATE "StockLot" AS l SET "unitCost" = v.unit_cost FROM (VALUES ${Prisma.join(values)}) AS v(id, unit_cost) WHERE l."id" = v.id`;
  }
  await writeAuditMany(audits, tx);
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
  const unitsBy = await receiptUnitsOf(tx, lines.map((l) => l.intakeId));
  const standard = await standardCostProducts(tx, [...unitsBy.values()].flat());
  const jobs: LineJob[] = [];
  let refusal: ApiError | null = null;
  for (const l of lines) {
    const r = l.intake;
    const provisional = D(r.unitCost!);
    const provisionalValue = r2(acceptedQty(r).times(provisional));
    const delta = D(l.net).minus(provisionalValue);
    const units = unitsBy.get(r.id) ?? [];
    // Raised once the lines before it are written, as when they were written one by one.
    if (!units.length) { refusal = new ApiError(409, `الاستلام ${r.receiptNumber}: مش لاقي كمياته في دفتر المخزون — مينفعش يتعاد تقييمه`); break; }
    const shares = shareByProduct(delta, units);
    const reason = `إعادة تقييم الاستلام ${r.receiptNumber} (سعر مؤقت ${provisional.toFixed(4)}) بفاتورة ${bill.number}`;
    totals.grni = totals.grni.plus(provisionalValue);
    jobs.push({
      intakeId: r.id, reason, date: bill.billDate,
      units: units.map((u, i) => {
        const amount = shares[i];
        const plan = planFor(amount, u, standard);
        return {
          u, amount, plan,
          data: {
            sourceType: "supplier_bill", billId, billLineId: l.id, intakeId: r.id, productId: u.productId, date: bill.billDate,
            basisQty: u.basis, onHandQty: u.onHand, provisionalUnitCost: provisional, unitDelta: q6(amount.dividedBy(u.basis)),
            delta: amount, inventoryDelta: plan.inventory, cogsDelta: plan.cogs, adjustmentDelta: plan.adjustment, ppvDelta: plan.ppv,
            createdById: actor.id, createdBy: actor.name,
          },
          audit: (rowId, inventory, cogs) => ({ userId: actor.id, userName: actor.name, role: actor.role, action: "stock_revaluation_posted", entityType: "stock_revaluation", entityId: rowId, fieldChanged: r.receiptNumber, oldValue: provisionalValue.toFixed(2), newValue: `فرق ${amount.toFixed(2)} · مخزون ${inventory.toFixed(2)} · تكلفة مبيعات ${cogs.toFixed(2)} · تسويات ${plan.adjustment.toFixed(2)} · فروق أسعار ${plan.ppv.toFixed(2)}`, reason, source: "user", deviceId: actor.deviceId }),
        };
      }),
    });
    totals.lines++;
  }
  await applyRevaluations(tx, jobs, actor, totals);
  if (refusal) throw refusal;
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
  const [allOriginals, unitsBy] = await Promise.all([
    tx.stockRevaluation.findMany({ where: { billLineId: { in: lines.map((l) => l.billLineId) }, sourceType: "supplier_bill" } }),
    receiptUnitsOf(tx, lines.map((l) => l.billLine.intakeId)),
  ]);
  const standard = await standardCostProducts(tx, [...unitsBy.values()].flat());
  const jobs: LineJob[] = [];
  let refusal: ApiError | null = null;
  for (const l of lines) {
    const r = l.billLine.intake;
    const originals = allOriginals.filter((o) => o.billLineId === l.billLineId);
    if (!originals.length) { refusal = new ApiError(409, `سطر الفاتورة ${dn.bill.number} على الاستلام ${r.receiptNumber} مالوش إعادة تقييم — مينفعش إشعار مدين بتخفيض تكلفته`); break; }
    const units = unitsBy.get(r.id) ?? [];
    if (!units.length) { refusal = new ApiError(409, `الاستلام ${r.receiptNumber}: مش لاقي كمياته في دفتر المخزون`); break; }
    const credited = D(l.net).negated();
    const shares = shareByProduct(credited, units);
    const reason = `تخفيض تكلفة الاستلام ${r.receiptNumber} بإشعار مدين ${dn.number} على ${dn.bill.number}`;
    jobs.push({
      intakeId: r.id, reason, date: dn.issueDate,
      units: units.map((u, i) => {
        const amount = shares[i];
        const of = originals.find((o) => o.productId === u.productId) ?? originals[0];
        const plan = planFor(amount, u, standard);
        return {
          u, amount, plan,
          data: {
            sourceType: "debit_note", billId: dn.billId, billLineId: l.billLineId, debitNoteId: dn.id, reversalOfId: of.id, intakeId: r.id, productId: u.productId, date: dn.issueDate,
            basisQty: u.basis, onHandQty: u.onHand, provisionalUnitCost: of.provisionalUnitCost, unitDelta: q6(amount.dividedBy(u.basis)),
            delta: amount, inventoryDelta: plan.inventory, cogsDelta: plan.cogs, adjustmentDelta: plan.adjustment, ppvDelta: plan.ppv,
            createdById: actor.id, createdBy: actor.name,
          },
          audit: (rowId, inventory, cogs) => ({ userId: actor.id, userName: actor.name, role: actor.role, action: "stock_revaluation_reversed", entityType: "stock_revaluation", entityId: rowId, fieldChanged: r.receiptNumber, oldValue: of.id, newValue: `${amount.toFixed(2)} · مخزون ${inventory.toFixed(2)} · تكلفة مبيعات ${cogs.toFixed(2)} · تسويات ${plan.adjustment.toFixed(2)} · فروق أسعار ${plan.ppv.toFixed(2)}`, reason, source: "user", deviceId: actor.deviceId }),
        };
      }),
    });
    totals.lines++;
  }
  await applyRevaluations(tx, jobs, actor, totals);
  if (refusal) throw refusal;
  return totals;
}

/** A receipt's revaluation history (bill and debit notes), for the receipt and bill screens. */
export async function revaluationsOf(db: Pick<Tx, "stockRevaluation">, where: { intakeId?: string; billId?: string }) {
  // Rows written together share a creation time; their ids are made in writing order.
  const rows = await db.stockRevaluation.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { debitNote: { select: { number: true } }, bill: { select: { number: true } } } });
  return rows.map((r) => ({
    id: r.id, sourceType: r.sourceType, bill: r.bill.number, debitNote: r.debitNote?.number ?? null, reversalOfId: r.reversalOfId, intakeId: r.intakeId, productId: r.productId, date: r.date,
    basisQty: r.basisQty.toString(), onHandQty: r.onHandQty.toString(), provisionalUnitCost: r.provisionalUnitCost.toFixed(4), unitDelta: r.unitDelta.toString(),
    delta: r.delta.toFixed(2), inventory: r.inventoryDelta.toFixed(2), cogs: r.cogsDelta.toFixed(2), adjustment: r.adjustmentDelta.toFixed(2), ppv: r.ppvDelta.toFixed(2),
  }));
}
