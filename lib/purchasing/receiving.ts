import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { advisoryXactLock } from "@/lib/dbLock";
import { afterCommit, inTx, type Tx } from "@/lib/tx";
import { refreshPoReceiptStatus, releasePoCoverage } from "@/lib/purchasing/orders";

/**
 * The purchase-order side of a goods receipt.
 *
 * A receipt against a PO line inherits its supplier and product, and its cost: the
 * line's price net of discount, per base unit — set by purchasing, never typed at the
 * gate (the receiver does not see prices). Receiving is allowed only on an approved or
 * sent order, and the GOOD quantity accepted against a line may exceed what was
 * ordered only by the configured tolerance (weights of fresh produce are never exact).
 *
 * Rejected (sorted-out) quantity is recorded on the receipt and on the line's tally,
 * but does not count toward the order: it was not accepted.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const RECEIVABLE = ["approved", "sent", "partially_received", "received"];

export async function loadPoLine(lineId: string) {
  const line = await prisma.purchaseOrderLine.findUnique({ where: { id: lineId }, include: { po: true, product: true } });
  if (!line) throw new ApiError(404, "سطر أمر الشراء مش موجود");
  return line;
}

/** Cost per base unit from the PO line: price × ordered qty × (1 − discount) ÷ base qty. */
export function poLineUnitCost(line: { unitPrice: Prisma.Decimal; quantity: Prisma.Decimal; baseQuantity: Prisma.Decimal; discountPct: Prisma.Decimal }) {
  return D(line.unitPrice)
    .times(line.quantity)
    .times(D(100).minus(line.discountPct))
    .dividedBy(100)
    .dividedBy(line.baseQuantity)
    .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Inside the receipt's transaction, before it is written: locks the order (receipts
 * against the same PO queue), re-checks it can still be received against, and that
 * `accepted` (plus every other posted receipt on the line, except `excludeIntakeId` when
 * correcting) stays within the tolerance. Accepted = received − rejected: everything that
 * enters stock and GRNI and that the supplier bills for — first grade, second grade and the
 * waste graded out of it alike. (Measuring the good quantity alone let a receipt graded into
 * Grade B or waste pass well beyond the approved quantity.)
 */
export async function guardPoReceipt(tx: Tx, input: { lineId: string; accepted: Prisma.Decimal; tolerancePct: number; excludeIntakeId?: string }) {
  const line = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: input.lineId }, include: { po: true, product: true } });
  await advisoryXactLock(tx, `purchasing:po:${line.poId}`);
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: line.poId } });
  if (!RECEIVABLE.includes(po.status)) {
    throw new ApiError(409, po.status === "pending_approval" || po.status === "draft" ? `أمر الشراء ${po.number} لسه مااتعتمدش` : `أمر الشراء ${po.number} مقفول (${po.status})`);
  }
  const others = await tx.stockIntake.aggregate({
    where: { purchaseOrderLineId: line.id, status: "posted", ...(input.excludeIntakeId ? { id: { not: input.excludeIntakeId } } : {}) },
    _sum: { receivedQty: true, rejectedQty: true },
  });
  const before = D(others._sum.receivedQty ?? 0).minus(D(others._sum.rejectedQty ?? 0));
  const total = before.plus(input.accepted);
  const ceiling = D(line.baseQuantity).times(D(100).plus(input.tolerancePct)).dividedBy(100);
  if (total.greaterThan(ceiling)) {
    const left = Prisma.Decimal.max(ceiling.minus(before), 0);
    throw new ApiError(
      409,
      `"${line.product.name}": المطلوب في ${po.number} ${D(line.baseQuantity).toFixed()} ${line.product.unit} — أقصى استلام مقبول باقي ${left.toFixed()} (سماحية ${input.tolerancePct}%)`
    );
  }
  return { line, po };
}

/** Voiding a receipt only lowers what was received: lock the order, no tolerance check. */
export async function lockPoForReceipt(tx: Tx, lineId: string) {
  const line = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: lineId }, select: { poId: true } });
  await advisoryXactLock(tx, `purchasing:po:${line.poId}`);
  return line.poId;
}

/**
 * After a receipt against a PO is posted, corrected or voided: the PO's receiving status, then
 * the suggestions of the orders it serves (release gate D-1, Nov 2026). What the PO still has to
 * bring just changed, so may what its order lines lack beyond it — a rejected or graded-out part
 * of a delivery that closed the line, a voided receipt. A receipt voided or corrected down after
 * the PO was closed can leave a request with nothing accepted on it: it is released as the close
 * would have released it.
 *
 * The purchasing side runs once the receipt has committed, in its own transaction, outside the
 * receipt's stock locks: a receipt never waits for, deadlocks with or fails on a purchase request
 * being decided at the same moment. Should it fail, it is logged and the next re-size corrects it.
 */
export async function afterPoReceipt(tx: Tx, poId: string, actor: { id: string | null; name: string; role: string; deviceId?: string }) {
  const status = await refreshPoReceiptStatus(tx, poId, actor);
  if (!afterCommit(tx, `po-coverage:${poId}`, () => syncPoCoverageByOrder(poId, actor))) await syncPoCoverage(tx, poId, actor);
  return status;
}

/**
 * syncPoCoverage once the receipt has committed, in steps (Nov 2026): the PO's own part in one
 * transaction, then each order it serves in its own, under the PO's lock as before. One
 * transaction for every order of a large PO could run past the 20 s limit, and the failure was
 * only logged — every order's suggestions stayed stale. Now an order that fails is logged and
 * the others are still re-sized; the next re-size corrects it. Any after-commit re-size of a
 * PO's coverage (a receipt here; a grading or other inventory document) should register this.
 */
export async function syncPoCoverageByOrder(poId: string, actor: { id: string | null; name: string; role: string; deviceId?: string }) {
  const orderIds = await inTx(async (t) => {
    await advisoryXactLock(t, `purchasing:po:${poId}`);
    const po = await t.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    const released = po.status === "closed" ? await releasePoCoverage(t, po, "closed", "استلام اتلغى أو اتعدّل بعد قفل أمر الشراء", actor, { noteKept: false, resync: false }) : [];
    const served = await t.purchaseRequest.findMany({ where: { purchaseOrderId: poId, status: "ordered", orderItemId: { not: null } }, select: { orderId: true } });
    return [...new Set([...released, ...served.map((r) => r.orderId).filter((x): x is string => !!x)])];
  });
  const { syncOrderSuggestions } = await import("@/lib/purchasing/requests");
  for (const orderId of orderIds) {
    try {
      await inTx(async (t) => {
        await advisoryXactLock(t, `purchasing:po:${poId}`);
        await syncOrderSuggestions(t, orderId, actor, { forOrder: true });
      });
    } catch (err) {
      console.error(`[purchasing] re-sizing the suggestions of order ${orderId} after a receipt on PO ${poId} failed`, err);
    }
  }
}

export async function syncPoCoverage(tx: Tx, poId: string, actor: { id: string | null; name: string; role: string; deviceId?: string }) {
  await advisoryXactLock(tx, `purchasing:po:${poId}`);
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
  if (po.status === "closed") await releasePoCoverage(tx, po, "closed", "استلام اتلغى أو اتعدّل بعد قفل أمر الشراء", actor, { noteKept: false });
  const { syncSuggestionsOfPo } = await import("@/lib/purchasing/requests");
  await syncSuggestionsOfPo(tx, poId, actor);
}

/** What is still expected, per open PO line, for the receiving screen (no prices). */
export async function openLinesForReceiving(filters: { supplierId?: string }) {
  const pos = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["approved", "sent", "partially_received"] }, ...(filters.supplierId ? { supplierId: filters.supplierId } : {}) },
    orderBy: [{ expectedDate: "asc" }, { createdAt: "asc" }],
    include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } }, lines: { include: { product: { select: { id: true, name: true, nameAr: true, unit: true } } }, orderBy: { lineNo: "asc" } } },
    take: 100,
  });
  const lineIds = pos.flatMap((p) => p.lines.map((l) => l.id));
  const got = lineIds.length
    ? await prisma.stockIntake.groupBy({ by: ["purchaseOrderLineId"], where: { status: "posted", purchaseOrderLineId: { in: lineIds } }, _sum: { goodQty: true, receivedQty: true, rejectedQty: true } })
    : [];
  const goodBy = new Map(got.map((g) => [g.purchaseOrderLineId!, D(g._sum.goodQty ?? 0)]));
  const acceptedBy = new Map(got.map((g) => [g.purchaseOrderLineId!, D(g._sum.receivedQty ?? 0).minus(D(g._sum.rejectedQty ?? 0))]));
  return pos.flatMap((p) =>
    p.lines
      .map((l) => {
        const good = goodBy.get(l.id) ?? D(0);
        // Still expected: the ordered quantity less what was accepted (graded output included).
        const remaining = Prisma.Decimal.max(D(l.baseQuantity).minus(acceptedBy.get(l.id) ?? D(0)), 0);
        return { lineId: l.id, poId: p.id, poNumber: p.number, expectedDate: p.expectedDate, supplier: p.supplier, product: l.product, ordered: D(l.baseQuantity).toString(), receivedGood: good.toString(), remaining: remaining.toString(), orderedAs: `${l.quantity.toString()} ${l.uomCode}` };
      })
      .filter((x) => Number(x.remaining) > 0)
  );
}
