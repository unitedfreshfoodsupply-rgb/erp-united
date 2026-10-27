import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { advisoryXactLock } from "@/lib/dbLock";
import type { Tx } from "@/lib/tx";
import { refreshPoReceiptStatus } from "@/lib/purchasing/orders";

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
 * `good` (plus every other posted receipt on the line, except `excludeIntakeId` when
 * correcting) stays within the tolerance.
 */
export async function guardPoReceipt(tx: Tx, input: { lineId: string; good: Prisma.Decimal; tolerancePct: number; excludeIntakeId?: string }) {
  const line = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: input.lineId }, include: { po: true, product: true } });
  await advisoryXactLock(tx, `purchasing:po:${line.poId}`);
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: line.poId } });
  if (!RECEIVABLE.includes(po.status)) {
    throw new ApiError(409, po.status === "pending_approval" || po.status === "draft" ? `أمر الشراء ${po.number} لسه مااتعتمدش` : `أمر الشراء ${po.number} مقفول (${po.status})`);
  }
  const others = await tx.stockIntake.aggregate({
    where: { purchaseOrderLineId: line.id, status: "posted", ...(input.excludeIntakeId ? { id: { not: input.excludeIntakeId } } : {}) },
    _sum: { goodQty: true },
  });
  const total = D(others._sum.goodQty ?? 0).plus(input.good);
  const ceiling = D(line.baseQuantity).times(D(100).plus(input.tolerancePct)).dividedBy(100);
  if (total.greaterThan(ceiling)) {
    const left = Prisma.Decimal.max(ceiling.minus(D(others._sum.goodQty ?? 0)), 0);
    throw new ApiError(
      409,
      `"${line.product.name}": المطلوب في ${po.number} ${D(line.baseQuantity).toFixed()} ${line.product.unit} — أقصى استلام سليم باقي ${left.toFixed()} (سماحية ${input.tolerancePct}%)`
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

export async function afterPoReceipt(tx: Tx, poId: string, actor: { id: string | null; name: string; role: string; deviceId?: string }) {
  return refreshPoReceiptStatus(tx, poId, actor);
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
    ? await prisma.stockIntake.groupBy({ by: ["purchaseOrderLineId"], where: { status: "posted", purchaseOrderLineId: { in: lineIds } }, _sum: { goodQty: true } })
    : [];
  const goodBy = new Map(got.map((g) => [g.purchaseOrderLineId!, D(g._sum.goodQty ?? 0)]));
  return pos.flatMap((p) =>
    p.lines
      .map((l) => {
        const good = goodBy.get(l.id) ?? D(0);
        const remaining = Prisma.Decimal.max(D(l.baseQuantity).minus(good), 0);
        return { lineId: l.id, poId: p.id, poNumber: p.number, expectedDate: p.expectedDate, supplier: p.supplier, product: l.product, ordered: D(l.baseQuantity).toString(), receivedGood: good.toString(), remaining: remaining.toString(), orderedAs: `${l.quantity.toString()} ${l.uomCode}` };
      })
      .filter((x) => Number(x.remaining) > 0)
  );
}
