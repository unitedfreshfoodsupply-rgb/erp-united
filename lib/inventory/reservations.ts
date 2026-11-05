import { Prisma, type StockReservation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber } from "@/lib/core/sequences";
import type { ServiceActor } from "@/lib/core/actor";
import { D, ZERO, parseQty, type Dec } from "@/lib/inventory/decimal";
import { productAvailability, productsBuckets } from "@/lib/inventory/balances";
import { lockAvailability, lockAvailabilities, allocateFrom, PickClaims } from "@/lib/inventory/picking";
import { postMovements, type MoveInput } from "@/lib/inventory/ledger";
import { resolveWarehouse } from "@/lib/inventory/context";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { notify } from "@/lib/core/notifications";
import { availabilityChanged } from "@/lib/inventory/availability-changes";

/**
 * Reservations: stock promised to a demand before it physically leaves.
 *
 * A reservation is not a ledger movement — on-hand does not change — but it reduces
 * what is AVAILABLE, so the same kilo cannot be promised twice. Reserving and every
 * removal that must respect reservations take the same per-(product, warehouse)
 * availability lock, so "check available, then reserve" cannot interleave with a
 * scrap or an adjustment that empties the shelf between the two.
 *
 * A reservation ends one of two ways: released (the demand went away) or consumed
 * (the stock was issued against it, by issueStock below).
 */

const reservationAudit = (r: StockReservation, actor: ServiceActor, action: string, detail: string, reason?: string) => ({
  userId: actor.id,
  userName: actor.name,
  role: actor.role,
  action,
  entityType: "stock_reservation" as const,
  entityId: r.id,
  orderId: r.sourceType === "order" ? r.sourceId : null,
  fieldChanged: r.productId,
  newValue: detail,
  reason,
  source: "user" as const,
  deviceId: actor.deviceId,
});

async function auditReservation(tx: Tx, r: StockReservation, actor: ServiceActor, action: string, detail: string, reason?: string) {
  await writeAudit(reservationAudit(r, actor, action, detail, reason), tx);
}

/**
 * Closes reservations read earlier in this transaction, all in one statement, each only if it
 * is still the version that was read — what one `update where { id, version }` per row did. A row
 * someone else changed meanwhile fails the whole call the same way (P2025: changed meanwhile).
 */
async function closeReservations(tx: Tx, rows: StockReservation[], data: { status: "released" | "consumed"; closedReason: string }) {
  if (!rows.length) return;
  const { count } = await tx.stockReservation.updateMany({
    where: { OR: rows.map((r) => ({ id: r.id, version: r.version })) },
    data: { ...data, closedAt: new Date(), version: { increment: 1 } },
  });
  if (count !== rows.length) throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
}

/** Reserve inside an existing transaction (an order confirmation will call this). */
export async function reserveInTx(
  tx: Tx,
  input: { productId: string; warehouseId: string; quantity: Dec; sourceType: "order" | "manual"; sourceId: string; sourceLineId?: string | null },
  actor: ServiceActor
) {
  const product = await tx.stockProduct.findUnique({ where: { id: input.productId } });
  if (!product) throw new ApiError(404, "الصنف مش موجود");
  if (!product.stockTracked) throw new ApiError(400, `"${product.name}" مش صنف بيتتبع مخزونه`);
  await lockAvailability(tx, product.id, input.warehouseId);
  if (input.sourceLineId) {
    const existing = await tx.stockReservation.findFirst({
      where: { sourceType: input.sourceType, sourceId: input.sourceId, sourceLineId: input.sourceLineId, status: "active" },
    });
    if (existing) return { reservation: existing, created: false }; // one per line — idempotent
  }
  const { available } = await productAvailability(tx, product.id, input.warehouseId);
  if (available.lessThan(input.quantity)) {
    throw new ApiError(400, `المتاح من "${product.name}" ${available.lt(0) ? "0" : available.toFixed()} ${product.unit} بس، والمطلوب حجز ${input.quantity.toFixed()}`);
  }
  const reservation = await tx.stockReservation.create({
    data: {
      productId: product.id,
      warehouseId: input.warehouseId,
      quantity: input.quantity,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceLineId: input.sourceLineId ?? null,
      createdById: actor.id,
      createdBy: actor.name,
    },
  });
  await auditReservation(tx, reservation, actor, "stock_reserved", `${product.name} · ${input.quantity.toFixed()} ${product.unit}`);
  await availabilityChanged(tx, [{ productId: product.id, delta: D(input.quantity).negated() }], actor);
  return { reservation, created: true };
}

export async function reserve(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.reserve");
  const sourceType = input.source_type === "order" ? "order" : input.source_type === "manual" ? "manual" : null;
  if (!sourceType) throw new ApiError(400, "نوع المصدر لازم يكون order أو manual");
  if (typeof input.source_id !== "string" || !input.source_id) throw new ApiError(400, "حدد المصدر");
  if (typeof input.product_id !== "string") throw new ApiError(400, "اختار الصنف");
  return inTx(async (tx) => {
    const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
    const product = await tx.stockProduct.findUnique({ where: { id: input.product_id as string } });
    if (!product) throw new ApiError(404, "الصنف مش موجود");
    let qty = parseQty(input.quantity, "كمية الحجز");
    if (typeof input.uom === "string" && input.uom && input.uom !== product.unit) qty = await toBaseQuantity(tx, product, qty, input.uom);
    if (sourceType === "order") {
      const order = await tx.order.findUnique({ where: { id: input.source_id as string }, include: { items: { select: { id: true } } } });
      if (!order) throw new ApiError(404, "الأوردر مش موجود");
      if (["dispatched", "cancelled"].includes(order.status)) throw new ApiError(409, "الأوردر مقفول — مينفعش يتحجزله");
      if (input.source_line_id && !order.items.some((i) => i.id === input.source_line_id)) throw new ApiError(400, "السطر مش تابع للأوردر");
    }
    return reserveInTx(
      tx,
      { productId: product.id, warehouseId: wh.id, quantity: qty, sourceType, sourceId: input.source_id as string, sourceLineId: (input.source_line_id as string) || null },
      actor
    );
  });
}

export async function releaseReservation(id: string, reason: unknown, actor: ServiceActor, expectedVersion?: number) {
  assertPermission(actor, "stock.reserve");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new ApiError(400, "اكتب سبب فك الحجز");
  return inTx(async (tx) => {
    const r = await tx.stockReservation.findUnique({ where: { id } });
    if (!r) throw new ApiError(404, "الحجز مش موجود");
    if (r.status !== "active") throw new ApiError(409, "الحجز ده مقفول بالفعل");
    if (expectedVersion !== undefined && expectedVersion !== r.version) throw new ApiError(409, "الحجز اتغيّر من واحد تاني، حدّث الشاشة");
    // A live order's hold is part of the order (WF-01): it changes with the order's
    // quantities and ends with its cancellation or dispatch, never by hand.
    if (r.sourceType === "order") {
      const o = await tx.order.findUnique({ where: { id: r.sourceId }, select: { status: true, orderNumber: true } });
      if (o && o.status !== "dispatched" && o.status !== "cancelled") {
        throw new ApiError(409, `الحجز ده تبع أوردر شغال (${o.orderNumber ?? r.sourceId}) — بيتغير بتعديل كمية السطر أو بإلغاء الأوردر، مش بفك الحجز يدويًا`);
      }
    }
    let updated: StockReservation;
    try {
      updated = await tx.stockReservation.update({
        where: { id, version: r.version, status: "active" },
        data: { status: "released", closedReason: why, closedAt: new Date(), version: { increment: 1 } },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "الحجز اتغيّر من واحد تاني، حدّث الشاشة");
      throw err;
    }
    await auditReservation(tx, updated, actor, "stock_reservation_released", `${D(r.quantity).toFixed()}`, why);
    await availabilityChanged(tx, [{ productId: r.productId, delta: D(r.quantity) }], actor);
    return updated;
  });
}

/** Releases one active reservation inside the caller's transaction. */
export async function releaseReservationInTx(tx: Tx, r: StockReservation, reason: string, actor: ServiceActor) {
  const updated = await tx.stockReservation.update({
    where: { id: r.id, version: r.version, status: "active" },
    data: { status: "released", closedReason: reason, closedAt: new Date(), version: { increment: 1 } },
  });
  await auditReservation(tx, updated, actor, "stock_reservation_released", `${D(r.quantity).toFixed()}`, reason);
  await availabilityChanged(tx, [{ productId: r.productId, delta: D(r.quantity) }], actor);
  return updated;
}

/** Releases every active reservation of a source (an order that was cancelled). */
export async function releaseAllForSource(tx: Tx, sourceType: "order" | "manual", sourceId: string, reason: string, actor: ServiceActor) {
  const active = await tx.stockReservation.findMany({ where: { sourceType, sourceId, status: "active" } });
  await closeReservations(tx, active, { status: "released", closedReason: reason });
  await writeAuditMany(active.map((r) => reservationAudit(r, actor, "stock_reservation_released", `${D(r.quantity).toFixed()}`, reason)), tx);
  await availabilityChanged(tx, active.map((r) => ({ productId: r.productId, delta: D(r.quantity) })), actor);
  return active.length;
}

/**
 * Issues stock out of the warehouse for a demand (an order leaving on a truck), in the
 * caller's transaction. Picks FEFO/FIFO; the line's own reservation (if any) is
 * consumed, and only stock NOT promised to someone else may be taken beyond it.
 */
export async function issueStock(
  tx: Tx,
  input: {
    warehouseId: string;
    sourceType: "order";
    sourceId: string;
    reference: string;
    lines: { productId: string; quantity: Dec; sourceLineId: string }[];
  },
  actor: ServiceActor
) {
  const date = todayLocalISO();
  const doc = await tx.inventoryDocument.create({
    data: {
      number: await nextDocumentNumber(tx, "inventory.issue", date),
      type: "issue",
      status: "posted",
      warehouseId: input.warehouseId,
      businessDate: date,
      reason: input.reference,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdById: actor.id,
      createdBy: actor.name,
      postedAt: new Date(),
    },
  });
  const moves: MoveInput[] = [];
  const claims = new PickClaims();
  const expiredPicks: string[] = [];
  // Every product's availability lock first, in one global order (availability →
  // valuation → bucket), so two issues sharing products cannot deadlock.
  await lockAvailabilities(tx, new Set(input.lines.map((l) => l.productId)), input.warehouseId);
  const lines = input.lines.filter((l) => l.quantity.gt(0));
  if (lines.length) {
    // Read once for the whole document, under those locks: the products, each line's own
    // reservation, every bucket and what is reserved of each product. Nothing moves until
    // postMovements below, so these are what each line read for itself before (PW-1).
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const [products, ownRows, buckets, reservedRows] = await Promise.all([
      tx.stockProduct.findMany({ where: { id: { in: productIds } } }),
      tx.stockReservation.findMany({ where: { sourceType: input.sourceType, sourceId: input.sourceId, sourceLineId: { in: [...new Set(lines.map((l) => l.sourceLineId))] }, status: "active" } }),
      productsBuckets(tx, productIds, input.warehouseId),
      tx.stockReservation.groupBy({ by: ["productId"], where: { productId: { in: productIds }, warehouseId: input.warehouseId, status: "active" }, _sum: { quantity: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const reserved = new Map(reservedRows.map((r) => [r.productId, D(r._sum.quantity)]));
    const consumed: StockReservation[] = [];
    for (const line of lines) {
      const product = productById.get(line.productId);
      if (!product) throw new Prisma.PrismaClientKnownRequestError("No StockProduct found", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
      // Consume this line's reservation first, so the allocation below may use the
      // stock it was holding; everyone else's reservations stay protected.
      const own = ownRows.find((r) => r.sourceLineId === line.sourceLineId && !consumed.includes(r));
      if (own) {
        consumed.push(own);
        if (own.warehouseId === input.warehouseId && reserved.has(own.productId)) reserved.set(own.productId, reserved.get(own.productId)!.minus(D(own.quantity)));
      }
      const picks = allocateFrom(buckets.get(product.id) ?? [], reserved.get(product.id) ?? ZERO, {
        productId: product.id,
        productName: product.name,
        warehouseId: input.warehouseId,
        quantity: line.quantity,
        strategy: product.removalStrategy as "fefo" | "fifo",
        claims,
        excludeExpiredOn: date,
      });
      for (const p of picks) if (p.expiryDate && p.expiryDate < date) expiredPicks.push(`${product.name}: ${p.quantity.toFixed()} ${product.unit} من الدفعة ${p.lotNumber ?? "—"} (انتهت ${p.expiryDate})`);
      for (const p of picks) {
        moves.push({ productId: product.id, warehouseId: input.warehouseId, locationId: p.locationId, lotId: p.lotId, quantity: p.quantity.negated(), kind: "issue", documentId: doc.id });
      }
    }
    await closeReservations(tx, consumed, { status: "consumed", closedReason: doc.number });
    // Nets out against the issue movements below (stock it held leaves with it).
    await availabilityChanged(tx, consumed.map((own) => ({ productId: own.productId, delta: D(own.quantity) })), actor);
  }
  await postMovements(tx, moves, { actorId: actor.id, actorName: actor.name, effectiveDate: date });
  await writeAudit(
    {
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "inventory_issue_posted",
      entityType: "inventory_document",
      entityId: doc.id,
      orderId: input.sourceType === "order" ? input.sourceId : null,
      fieldChanged: "issue",
      newValue: `${doc.number} · ${input.reference}`,
      source: "system",
      deviceId: actor.deviceId,
    },
    tx
  );
  // Only expired lots were left on the books for what went out: either expired goods
  // were shipped, or the books disagree with the cold room. Either way, someone looks.
  if (expiredPicks.length) {
    await notify(
      tx,
      { permission: "stock.adjust" },
      {
        type: "stock.expired_issued",
        severity: "warning",
        title: `صرف من دفعات منتهية الصلاحية — ${input.reference}`,
        body: expiredPicks.join(" · "),
        entityType: "inventory_document",
        entityId: doc.id,
        link: "/stock/inventory",
        dedupeKey: `expired-issue:${doc.id}`,
      }
    );
  }
  return { document: doc, movements: moves.length, expiredPicks };
}

export async function listReservations(filters: { productId?: string; sourceId?: string; status?: string }) {
  return prisma.stockReservation.findMany({
    where: {
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
      status: filters.status ?? "active",
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { product: { select: { name: true, nameAr: true, unit: true } }, warehouse: { select: { code: true } } },
  });
}
