import type { StockIssueException } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { advisoryXactLock } from "@/lib/dbLock";
import { requestApproval } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import { D, ZERO, type Dec } from "@/lib/inventory/decimal";
import { productAvailability, productsAvailability } from "@/lib/inventory/balances";
import { lockAvailability, lockAvailabilities } from "@/lib/inventory/picking";
import { resolveWarehouse } from "@/lib/inventory/context";
import { preloadedUnits, toBaseQuantity } from "@/lib/inventory/packaging";
import { issueStock, releaseAllForSource } from "@/lib/inventory/reservations";
import { reverseDocumentInTx } from "@/lib/inventory/documents";

/**
 * Order dispatch ↔ stock ledger.
 *
 * When an order leaves on a truck, what it carried leaves the books: one "issue"
 * document per dispatch, FEFO/FIFO-picked, consuming the order's own reservations.
 * The quantity issued per line is what was physically confirmed last — loaded, else
 * prepared, else required.
 *
 * Every line must be issued in full, or the order does not leave (remediation
 * 2026-11, WF-01). A line that names no catalog product (unmapped), whose unit does
 * not convert to the product's base unit (unit_mismatch), or for which the books hold
 * less than what is on the truck (insufficient) refuses the dispatch with every
 * shortfall listed. Confirmed orders already hold their stock (see
 * lib/sales/stock-commitment.ts), so this is the last line of defence, not a normal
 * path. Products that are not stock-tracked (services, packaging) are not issued.
 *
 * StockIssueException rows exist only for dispatches made under the retired lenient
 * policy; resolveIssueException() reconciles them (late issue with COGS, or an
 * approved no-movement closure). No new exception is ever raised here.
 *
 * Stock never goes negative: the ledger's bucket constraint holds.
 */


type PlannedLine = { itemId: string; productId: string; productName: string; unit: string; requested: Dec; issue: Dec };
type Shortfall = { itemId: string; productId: string | null; productName: string; unit: string; requested: Dec; issued: Dec; reason: "unmapped" | "unit_mismatch" | "insufficient" };

const REASON_LABEL: Record<Shortfall["reason"], string> = {
  unmapped: "الصنف مش متربط بدليل الأصناف",
  unit_mismatch: "وحدة السطر مش بتتحول لوحدة الصنف",
  insufficient: "الرصيد المسجل أقل من اللي خرج",
};

function lineQuantity(i: { loadedQuantity: number | null; preparedQuantity: number | null; requiredQuantity: number }): Dec {
  const raw = i.loadedQuantity ?? i.preparedQuantity ?? i.requiredQuantity;
  return D(raw).toDecimalPlaces(3);
}

export async function issueForDispatch(tx: Tx, orderId: string, actor: ServiceActor) {
  // One live issue per dispatch. A reopened order had its issue reversed, so a
  // re-dispatch issues afresh; a second call for the same dispatch is a no-op.
  // (A reversal is itself a posted "issue" document for the same order; it is not
  // a live issue.)
  const live = await tx.inventoryDocument.findFirst({ where: { type: "issue", status: "posted", reversalOfId: null, sourceType: "order", sourceId: orderId } });
  if (live) return { document: live, exceptions: [] as StockIssueException[] };

  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { include: { stockProduct: true }, orderBy: { id: "asc" } } },
  });
  const warehouse = await resolveWarehouse(tx, undefined);
  // The unit and packaging lookups toBaseQuantity makes, read once for every line sold in
  // another unit than its product's (a crate, a box); none when every line is in base units.
  const converted = order.items.filter((i) => i.stockProduct && i.unit !== i.stockProduct.unit);
  const units = converted.length ? await preloadedUnits(tx, converted.map((i) => ({ productId: i.stockProduct!.id, units: [i.unit, i.stockProduct!.unit] }))) : tx;

  const planned: PlannedLine[] = [];
  const shortfalls: Shortfall[] = [];
  for (const item of order.items) {
    const requested = lineQuantity(item);
    if (!requested.gt(0)) continue;
    const product = item.stockProduct;
    if (!product) {
      shortfalls.push({ itemId: item.id, productId: null, productName: item.productName, unit: item.unit, requested, issued: ZERO, reason: "unmapped" });
      continue;
    }
    if (!product.stockTracked) continue;
    let base: Dec;
    try {
      base = await toBaseQuantity(units, product, requested, item.unit);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      shortfalls.push({ itemId: item.id, productId: product.id, productName: product.name, unit: item.unit, requested, issued: ZERO, reason: "unit_mismatch" });
      continue;
    }
    planned.push({ itemId: item.id, productId: product.id, productName: product.name, unit: product.unit, requested: base, issue: base });
  }

  // Availability locks for every product up front, in one global order, so two
  // dispatches sharing products cannot deadlock (and nothing can reserve or remove
  // between measuring what is issuable and issuing it). One statement for all of them.
  const productIds = [...new Set(planned.map((p) => p.productId))].sort();
  await lockAvailabilities(tx, productIds, warehouse.id);

  // What this order may take of each product: what is available to anyone, plus
  // what is already reserved for this very order. Shared across the order's lines.
  // Read for every product at once (PW-1): the same sums productAvailability reads one by one.
  const [availability, ownRows] = productIds.length
    ? await Promise.all([
        productsAvailability(tx, productIds, warehouse.id),
        tx.stockReservation.groupBy({ by: ["productId"], where: { productId: { in: productIds }, warehouseId: warehouse.id, sourceType: "order", sourceId: orderId, status: "active" }, _sum: { quantity: true } }),
      ])
    : [new Map(), []];
  const ownBy = new Map(ownRows.map((r) => [r.productId, D(r._sum.quantity)]));
  const issuable = new Map<string, Dec>();
  for (const id of productIds) {
    const { available, sellableOnHand } = availability.get(id)!;
    const free = Prisma.Decimal.min(available.plus(ownBy.get(id) ?? ZERO), sellableOnHand);
    issuable.set(id, free.gt(0) ? free : ZERO);
  }
  for (const line of planned) {
    const left = issuable.get(line.productId)!;
    if (left.lessThan(line.requested)) {
      line.issue = left;
      shortfalls.push({ itemId: line.itemId, productId: line.productId, productName: line.productName, unit: line.unit, requested: line.requested, issued: left, reason: "insufficient" });
    }
    issuable.set(line.productId, left.minus(line.issue));
  }

  // Strict, always (remediation 2026-11, WF-01): goods the books cannot issue do not
  // leave. An unmapped line, a unit that does not convert, or a balance below what is
  // on the truck refuses the dispatch — the status change rolls back with it.
  if (shortfalls.length) {
    throw new ApiError(
      409,
      `مينفعش خروج الأوردر — ${shortfalls
        .map((s) => (s.reason === "insufficient" ? `${s.productName} (موجود ${s.issued.toFixed()} من ${s.requested.toFixed()} ${s.unit})` : `${s.productName}: ${REASON_LABEL[s.reason]}`))
        .join("، ")}`,
      "dispatch_stock_shortfall",
      { shortfalls: shortfalls.map((s) => ({ itemId: s.itemId, productId: s.productId, productName: s.productName, unit: s.unit, requested: s.requested.toFixed(), available: s.issued.toFixed(), reason: s.reason })) }
    );
  }

  const toIssue = planned.filter((l) => l.issue.gt(0));
  const issued = toIssue.length
    ? await issueStock(
        tx,
        {
          warehouseId: warehouse.id,
          sourceType: "order",
          sourceId: orderId,
          reference: `أوردر ${order.orderNumber ?? order.id} · ${order.customerName}`,
          lines: toIssue.map((l) => ({ productId: l.productId, quantity: l.issue, sourceLineId: l.itemId })),
        },
        actor
      )
    : null;

  // Anything still promised to this order is moot once it has left.
  await releaseAllForSource(tx, "order", orderId, "الأوردر خرج", actor);

  const exceptions: StockIssueException[] = [];
  return { document: issued?.document ?? null, exceptions };
}

/**
 * A dispatched order is being taken back (reopen or a supervisor override out of
 * "dispatched"): its stock issue is reversed at the cost it left at, and its open
 * exceptions are voided — they described a dispatch that is no longer the record.
 */
export async function reverseDispatchIssue(tx: Tx, orderId: string, reason: string, actor: ServiceActor) {
  const docs = await tx.inventoryDocument.findMany({ where: { type: "issue", status: "posted", reversalOfId: null, sourceType: "order", sourceId: orderId } });
  for (const d of docs) await reverseDocumentInTx(tx, d.id, `الأوردر اتفتح تاني: ${reason}`, actor);
  const open = await tx.stockIssueException.findMany({ where: { orderId, status: "open" } });
  for (const ex of open) {
    await tx.stockIssueException.update({
      where: { id: ex.id, version: ex.version },
      data: { status: "voided", resolution: `الأوردر اتفتح تاني: ${reason}`, resolvedById: actor.id, resolvedBy: actor.name, resolvedAt: new Date(), version: { increment: 1 } },
    });
    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "stock_issue_exception_voided",
        entityType: "stock_issue_exception",
        entityId: ex.id,
        orderId,
        reason,
        source: "system",
        deviceId: actor.deviceId,
      },
      tx
    );
  }
  return { reversed: docs.length, voided: open.length };
}

export async function listIssueExceptions(filters: { status?: string; orderId?: string }) {
  return prisma.stockIssueException.findMany({
    where: { status: filters.status ?? "open", ...(filters.orderId ? { orderId: filters.orderId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { order: { select: { orderNumber: true, customerName: true, customerAccount: { select: { name: true, nameAr: true } }, deliveryDate: true } }, document: { select: { number: true } } },
  });
}

/**
 * Reconciles a stock-issue exception left by the retired lenient dispatch policy.
 * A note alone never closes one (remediation 2026-11, WF-01):
 *   - "issue_now": the goods did leave; the missing quantity is issued now against the
 *     order (FEFO, at cost — the issue posts its COGS). Needs the stock on the books.
 *   - "close_no_movement": nothing physically left, or the sale was fully reversed. Only
 *     allowed when no revenue stands on the order without cost (every invoice void or
 *     fully credited), and only through an approval decided by someone else.
 */
export async function resolveIssueException(id: string, input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.adjust");
  const resolution = typeof input.resolution === "string" ? input.resolution.trim() : "";
  if (resolution.length < 3) throw new ApiError(400, "اكتب إزاي اتحل الاستثناء ده");
  const action = input.action;
  if (action !== "issue_now" && action !== "close_no_movement") {
    throw new ApiError(400, "اختار طريقة التسوية: صرف الكمية دلوقتي، أو قفل بدون حركة مخزون (بموافقة)");
  }
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `stock-issue-exception:${id}`);
    const ex = await tx.stockIssueException.findUnique({ where: { id } });
    if (!ex) throw new ApiError(404, "الاستثناء مش موجود");
    if (ex.status !== "open") throw new ApiError(409, "الاستثناء ده مقفول بالفعل");
    if (input.expected_version !== undefined && input.expected_version !== ex.version) throw new ApiError(409, "الاستثناء اتغيّر، حدّث الشاشة");
    const order = await tx.order.findUniqueOrThrow({ where: { id: ex.orderId } });

    if (action === "issue_now") {
      // Unmapped / unit-mismatch lines name the catalog product and base quantity now.
      const productId = ex.reason === "insufficient" ? ex.productId : typeof input.product_id === "string" ? input.product_id : null;
      if (!productId) throw new ApiError(400, "حدد الصنف من دليل الأصناف");
      const qty = ex.reason === "insufficient" ? D(ex.requestedQty).minus(D(ex.issuedQty)) : D(typeof input.quantity === "number" || typeof input.quantity === "string" ? input.quantity : NaN);
      if (!qty.isFinite() || !qty.gt(0)) throw new ApiError(400, "الكمية اللي هتتصرف لازم تكون أكبر من صفر (بوحدة المخزون)");
      const product = await tx.stockProduct.findUnique({ where: { id: productId } });
      if (!product || !product.stockTracked) throw new ApiError(400, "الصنف مش موجود أو مش متتبع مخزونه");
      const warehouse = await resolveWarehouse(tx, undefined);
      await lockAvailability(tx, product.id, warehouse.id);
      const { available } = await productAvailability(tx, product.id, warehouse.id);
      if (available.lessThan(qty)) throw new ApiError(409, `المتاح من "${product.nameAr ?? product.name}" ${available.gt(0) ? available.toFixed() : "0"} ${product.unit} — سجّل الاستلام الأول`);
      const issued = await issueStock(
        tx,
        { warehouseId: warehouse.id, sourceType: "order", sourceId: ex.orderId, reference: `تسوية استثناء صرف · أوردر ${order.orderNumber ?? order.id}`, lines: [{ productId: product.id, quantity: qty, sourceLineId: ex.orderItemId }] },
        actor
      );
      const updated = await closeException(tx, ex, { resolution, kind: "late_issue", documentId: issued.document.id }, actor);
      return { exception: updated, document: issued.document };
    }

    // close_no_movement: no revenue may stand on the order without its cost.
    const invoices = await tx.salesInvoice.findMany({ where: { orderId: ex.orderId, status: "issued" }, include: { creditNotes: true } });
    const standing = invoices.filter((inv) => inv.creditNotes.reduce((a: Dec, c: { total: Prisma.Decimal }) => a.plus(c.total), D(0)).lessThan(inv.total));
    if (standing.length) {
      throw new ApiError(409, `الأوردر عليه فاتورة قائمة (${standing.map((i) => i.number).join("، ")}) — يا إما تصرف الكمية، يا إما تعمل إشعار دائن الأول`);
    }
    const draft = await tx.salesInvoice.findFirst({ where: { orderId: ex.orderId, status: "draft" } });
    if (draft) throw new ApiError(409, "الأوردر عليه فاتورة مسودة — ألغيها الأول");
    const { request, created } = await requestApproval(tx, {
      type: "stock.issue_exception_close",
      entityId: ex.id,
      title: `قفل استثناء صرف بدون حركة مخزون · ${ex.productName}`,
      summary: `أوردر ${order.orderNumber ?? order.id}: خرج ${D(ex.requestedQty).toFixed()} ${ex.unit} واتصرف ${D(ex.issuedQty).toFixed()}`,
      reason: resolution,
      payload: { resolution },
      requester: { id: actor.id, name: actor.name, role: actor.role, deviceId: actor.deviceId },
    });
    return { exception: ex, approval: request, pending: true, created };
  });
}

async function closeException(
  tx: Tx,
  ex: StockIssueException,
  r: { resolution: string; kind: "late_issue" | "no_movement"; documentId?: string },
  actor: { id: string | null; name: string; role: string; deviceId?: string }
) {
  let updated: StockIssueException;
  try {
    updated = await tx.stockIssueException.update({
      where: { id: ex.id, version: ex.version, status: "open" },
      data: { status: "resolved", resolution: r.resolution, resolutionKind: r.kind, resolutionDocumentId: r.documentId ?? null, resolvedById: actor.id, resolvedBy: actor.name, resolvedAt: new Date(), version: { increment: 1 } },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "الاستثناء اتغيّر، حدّث الشاشة");
    throw err;
  }
  await writeAudit(
    {
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "stock_issue_exception_resolved",
      entityType: "stock_issue_exception",
      entityId: ex.id,
      orderId: ex.orderId,
      fieldChanged: r.kind,
      newValue: r.resolution,
      source: "user",
      deviceId: actor.deviceId,
    },
    tx
  );
  return updated;
}

/** Approval handler: the no-movement closure was approved by someone else. */
export async function applyIssueExceptionClose(tx: Tx, exceptionId: string, decider: { id: string | null; name: string; role: string; deviceId?: string }, payload: unknown) {
  const ex = await tx.stockIssueException.findUnique({ where: { id: exceptionId } });
  if (!ex || ex.status !== "open") return null;
  const resolution = (payload as { resolution?: string } | null)?.resolution ?? "قفل بدون حركة مخزون";
  return closeException(tx, ex, { resolution, kind: "no_movement" }, decider);
}
