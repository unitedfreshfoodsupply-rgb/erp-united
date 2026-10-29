import { Prisma, type InventoryDocument } from "@prisma/client";
import { asText } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { advisoryXactLock } from "@/lib/dbLock";
import { assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { getSetting } from "@/lib/core/settings-service";
import { nextDocumentNumber, type SequenceKey } from "@/lib/core/sequences";
import { requestApproval } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import { D, parseQty, type Dec } from "@/lib/inventory/decimal";
import { postMovements, bucketBalance, lockForMoves, lockProductValuations, productValuation, type MoveInput } from "@/lib/inventory/ledger";
import { computeGradingCosts, type GradingCostPolicy, type WasteLossPolicy } from "@/lib/inventory/grading";
import { gradingPrices } from "@/lib/sales/pricing";
import { allocate, lockAvailability, PickClaims } from "@/lib/inventory/picking";
import { resolveLocation, resolveWarehouse, receivingLocation } from "@/lib/inventory/context";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { requestFingerprint } from "@/lib/core/idempotency";
import { requiresAdjustmentApproval } from "@/lib/inventory/adjustment-rules";

/**
 * Inventory documents: every stock operation other than a supplier receipt.
 *
 * Each one is a numbered document whose movements post through the ledger in the
 * same transaction, with its audit row. Posted documents are never edited — they are
 * reversed by a new document. A client-supplied idempotency key makes a retried
 * request return the document it already created instead of posting twice.
 */

export type DocType = "transfer" | "adjustment" | "scrap" | "customer_return" | "supplier_return" | "issue" | "grading" | "release";

const SEQUENCE: Record<DocType, SequenceKey> = {
  transfer: "inventory.transfer",
  adjustment: "inventory.adjustment",
  scrap: "inventory.adjustment",
  customer_return: "inventory.return",
  supplier_return: "inventory.return",
  issue: "inventory.issue",
  grading: "inventory.sorting",
  release: "inventory.release",
};

const DOC_LABEL: Record<DocType, string> = {
  transfer: "تحويل",
  adjustment: "تسوية",
  scrap: "إعدام/تالف",
  customer_return: "مرتجع من عميل",
  supplier_return: "مرتجع لمورد",
  issue: "صرف",
  grading: "فرز",
  release: "إفراج محجوز",
};

type RawLine = {
  product_id?: unknown;
  quantity?: unknown;
  uom?: unknown;
  unit_cost?: unknown;
  expiry_date?: unknown;
  location_id?: unknown;
  lot_id?: unknown;
  to_location_id?: unknown;
  counted_quantity?: unknown;
  source_line_id?: unknown;
};

type Product = { id: string; name: string; unit: string; removalStrategy: string; stockTracked: boolean; active: boolean };

async function loadProduct(db: Tx, id: unknown): Promise<Product> {
  if (typeof id !== "string" || !id) throw new ApiError(400, "اختار الصنف");
  const p = await db.stockProduct.findUnique({ where: { id } });
  if (!p) throw new ApiError(404, "الصنف مش موجود");
  if (!p.stockTracked) throw new ApiError(400, `"${p.name}" مش صنف بيتتبع مخزونه`);
  return p;
}

async function lineQty(db: Tx, product: Product, raw: RawLine, opts: { allowNegative?: boolean } = {}) {
  const qty = parseQty(raw.quantity, `كمية "${product.name}"`, { allowNegative: opts.allowNegative });
  if (typeof raw.uom === "string" && raw.uom && raw.uom !== product.unit) {
    const sign = qty.lt(0) ? -1 : 1;
    return (await toBaseQuantity(db, product, qty.abs(), raw.uom)).times(sign);
  }
  return qty;
}

function lines(input: { lines?: unknown }): RawLine[] {
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ApiError(400, "لازم سطر واحد على الأقل");
  if (input.lines.length > 200) throw new ApiError(400, "عدد السطور كبير أوي");
  return input.lines as RawLine[];
}

function businessDate(raw: unknown) {
  const d = typeof raw === "string" && raw ? raw : todayLocalISO();
  if (!isValidISODate(d)) throw new ApiError(400, "التاريخ لازم يكون بصيغة YYYY-MM-DD");
  return d;
}

function idempotencyKey(raw: unknown) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 120) throw new ApiError(400, "مفتاح التكرار (idempotency_key) غير صالح");
  return raw;
}

async function existingByKey(key: string | null) {
  if (!key) return null;
  return prisma.inventoryDocument.findUnique({ where: { idempotencyKey: key }, include: { movements: true } });
}

async function createDoc(
  tx: Tx,
  type: DocType,
  data: {
    warehouseId: string;
    businessDate: string;
    status: "posted" | "pending_approval";
    reason?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    supplierId?: string | null;
    payload?: Prisma.InputJsonValue;
    idempotencyKey: string | null;
    requestHash?: string;
    reversalOfId?: string | null;
  },
  actor: ServiceActor
) {
  if (data.idempotencyKey) await advisoryXactLock(tx, `inventory-doc-key:${data.idempotencyKey}`);
  const number = await nextDocumentNumber(tx, SEQUENCE[type], data.businessDate);
  return tx.inventoryDocument.create({
    data: {
      number,
      type,
      status: data.status,
      warehouseId: data.warehouseId,
      businessDate: data.businessDate,
      reason: asText(data.reason, "reason")?.trim() || null,
      sourceType: data.sourceType ?? null,
      sourceId: data.sourceId ?? null,
      supplierId: data.supplierId ?? null,
      payload: data.payload ?? Prisma.JsonNull,
      idempotencyKey: data.idempotencyKey,
      requestHash: data.requestHash ?? null,
      reversalOfId: data.reversalOfId ?? null,
      createdById: actor.id,
      createdBy: actor.name,
      postedAt: data.status === "posted" ? new Date() : null,
    },
  });
}

async function auditDoc(tx: Tx, doc: InventoryDocument, actor: ServiceActor, action: string, summary: string) {
  await writeAudit(
    {
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action,
      entityType: "inventory_document",
      entityId: doc.id,
      orderId: doc.sourceType === "order" ? doc.sourceId : null,
      fieldChanged: doc.type,
      newValue: `${doc.number} · ${summary}`,
      reason: doc.reason ?? undefined,
      source: "user",
      deviceId: actor.deviceId,
    },
    tx
  );
}

const ctxOf = (actor: ServiceActor, date: string) => ({ actorId: actor.id, actorName: actor.name, effectiveDate: date });

/** Runs a document-producing function, unless the same idempotency key already did.
 * A unique-index collision (two retries racing) returns the winner. */
async function idempotent<T extends InventoryDocument>(key: string | null, requestHash: string, run: () => Promise<T>) {
  const assertSameRequest = (doc: InventoryDocument) => {
    // Older documents have no fingerprint; retain their safe retry behavior once.
    if (doc.requestHash && doc.requestHash !== requestHash) throw new ApiError(409, "مفتاح التكرار ده اتستخدم قبل كده بطلب مختلف");
  };
  const prior = await existingByKey(key);
  if (prior) {
    assertSameRequest(prior);
    return { document: prior, replayed: true };
  }
  try {
    return { document: await run(), replayed: false };
  } catch (err) {
    if (key && (err as { code?: string })?.code === "P2002") {
      const winner = await existingByKey(key);
      if (winner) {
        assertSameRequest(winner);
        return { document: winner, replayed: true };
      }
    }
    throw err;
  }
}

async function withMovements(id: string) {
  return prisma.inventoryDocument.findUniqueOrThrow({
    where: { id },
    include: {
      movements: { include: { location: { select: { code: true, name: true, nameAr: true } }, lot: { select: { lotNumber: true, expiryDate: true } }, product: { select: { name: true, nameAr: true, unit: true } } } },
    },
  });
}

// ---------------------------------------------------------------------------
// Transfer between locations (same warehouse)
// ---------------------------------------------------------------------------

export async function createTransfer(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.transfer");
  const key = idempotencyKey(input.idempotency_key);
  const date = businessDate(input.business_date);
  const raw = lines(input);
  const requestHash = requestFingerprint(input);
  const result = await idempotent(key, requestHash, () =>
    inTx(async (tx) => {
      const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
      const doc = await createDoc(tx, "transfer", { warehouseId: wh.id, businessDate: date, status: "posted", reason: input.reason as string, idempotencyKey: key, requestHash }, actor);
      // Plan every leg first, then lock every bucket the document touches in one
      // global order, then post: OUT first (so its cost is known), IN at that same
      // cost — moving stock never changes what it is worth.
      const legs: { productId: string; from: string; to: string; lotId: string | null; qty: Dec }[] = [];
      const claims = new PickClaims();
      for (const l of raw) {
        const product = await loadProduct(tx, l.product_id);
        const qty = await lineQty(tx, product, l);
        const from = await resolveLocation(tx, wh.id, l.location_id as string);
        if (from.type === "quarantine") throw new ApiError(400, "المخزون المحجوز لا يُنقل — استخدم التقرير للإفراج أولًا");
        if (!l.to_location_id) throw new ApiError(400, "حدد المكان اللي هيتحول له");
        const to = await resolveLocation(tx, wh.id, l.to_location_id as string);
        if (from.id === to.id) throw new ApiError(400, "مينفعش تحوّل لنفس المكان");
        // A transfer inside one warehouse does not change what is available, so it
        // may move reserved stock: the reservation is on the warehouse, not the shelf.
        const picks = l.lot_id
          ? [{ locationId: from.id, lotId: l.lot_id as string, quantity: qty }]
          : await allocate(tx, { productId: product.id, productName: product.name, warehouseId: wh.id, quantity: qty, strategy: product.removalStrategy as "fefo" | "fifo", locationId: from.id, protectReserved: false, claims });
        if (l.lot_id) claims.add(product.id, from.id, l.lot_id as string, qty);
        for (const p of picks) legs.push({ productId: product.id, from: from.id, to: to.id, lotId: p.lotId, qty: p.quantity });
      }
      await lockForMoves(tx, legs.flatMap((g) => [
        { productId: g.productId, locationId: g.from, lotId: g.lotId },
        { productId: g.productId, locationId: g.to, lotId: g.lotId },
      ]));
      for (const g of legs) {
        const [out] = await postMovements(tx, [{ productId: g.productId, warehouseId: wh.id, locationId: g.from, lotId: g.lotId, quantity: g.qty.negated(), kind: "transfer_out", documentId: doc.id }], ctxOf(actor, date));
        await postMovements(tx, [{ productId: g.productId, warehouseId: wh.id, locationId: g.to, lotId: g.lotId, quantity: g.qty, kind: "transfer_in", documentId: doc.id, unitCost: D(out.unitCost), costSource: "lot" }], ctxOf(actor, date));
      }
      await auditDoc(tx, doc, actor, "inventory_transfer_posted", `${raw.length} سطر`);
      return doc;
    })
  );
  return { ...result, document: await withMovements(result.document.id) };
}

// ---------------------------------------------------------------------------
// Quarantine release — approved exit of held stock (F-03)
// ---------------------------------------------------------------------------

/**
 * Authorised release of quarantined stock to a non-quarantine, non-waste location.
 * The entire bucket (product × location × lot) may be partially released; the
 * server checks availability and the destination must be a valid sellable location.
 * Idempotent via `idempotency_key`: a duplicate submit returns the same document.
 */
export async function releaseFromQuarantine(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.adjust");
  const key = idempotencyKey(input.idempotency_key);
  const date = businessDate(input.business_date);
  const requestHash = requestFingerprint(input);
  const productId = typeof input.product_id === "string" && input.product_id ? input.product_id : "";
  if (!productId) throw new ApiError(400, "حدد الصنف");
  const locationId = typeof input.location_id === "string" && input.location_id ? input.location_id : "";
  if (!locationId) throw new ApiError(400, "حدد المكان المحجوز");
  const destinationId = typeof input.destination_id === "string" && input.destination_id ? input.destination_id : "";
  if (!destinationId) throw new ApiError(400, "حدد المكان المطلوب الإفراج إليه");
  const rawQty = parseQty(input.quantity, "الكمية المفرج عنها", { allowZero: false });
  const lotId = typeof input.lot_id === "string" && input.lot_id ? input.lot_id : null;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new ApiError(400, "لازم تكتب سبب الإفراج");
  const inspectionNote = typeof input.inspection_note === "string" ? input.inspection_note.trim() : null;

  const result = await idempotent(key, requestHash, () =>
    inTx(async (tx) => {
      const product = await loadProduct(tx, productId);
      const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
      const from = await resolveLocation(tx, wh.id, locationId);
      if (from.type !== "quarantine") throw new ApiError(400, "المكان مش محجوز — الإفراج بيشتغل على المحجوز بس");
      const to = await resolveLocation(tx, wh.id, destinationId);
      if (to.type === "quarantine" || to.type === "waste") throw new ApiError(400, "مينفعش تفرج لمكان محجوز أو هالك");
      // Lock the affected bucket so concurrent release cannot double-allocate.
      await lockForMoves(tx, [{ productId: product.id, locationId: from.id, lotId }]);

      // Build exactly two movements: out of quarantine (negative), into destination (positive).
      const moves: MoveInput[] = [
        {
          productId: product.id, warehouseId: wh.id, locationId: from.id,
          lotId, quantity: rawQty.negated(), kind: "release_out", reason,
        },
        {
          productId: product.id, warehouseId: wh.id, locationId: to.id,
          lotId, quantity: rawQty, kind: "release_in", reason,
        },
      ];

      const doc = await createDoc(tx, "release", {
        warehouseId: wh.id, businessDate: date, status: "posted",
        reason, idempotencyKey: key, requestHash,
        payload: { productId, fromLocationId: from.id, toLocationId: to.id, lotId, quantity: rawQty.toFixed(3), inspectionNote },
      }, actor);

      for (const m of moves) m.documentId = doc.id;
      await postMovements(tx, moves, { actorId: actor.id, actorName: actor.name, effectiveDate: date });
      await auditDoc(tx, doc, actor, "inventory_quarantine_release",
        `إفراج ${rawQty.toFixed(3)} كجم ${product.name} من ${from.code} إلى ${to.code}${lotId ? ` · ${lotId.slice(0, 8)}` : ""}${inspectionNote ? ` · فحص: ${inspectionNote}` : ""}`);
      return doc;
    })
  );
  return { ...result, document: await withMovements(result.document.id) };
}

// ---------------------------------------------------------------------------
// Adjustment / stock count — with approval above a threshold
// ---------------------------------------------------------------------------

type PlannedAdjustment = { productId: string; quantity: string; locationId: string | null; lotId: string | null; countedQuantity?: string; expectedQuantity?: string };

/** Turns raw lines into signed base-unit deltas. A line may give a delta (quantity)
 * or what was physically counted in one bucket (counted_quantity). */
async function planAdjustment(tx: Tx, warehouseId: string, raw: RawLine[]): Promise<PlannedAdjustment[]> {
  const out: PlannedAdjustment[] = [];
  const countedBuckets = new Set<string>();
  for (const l of raw) {
    const product = await loadProduct(tx, l.product_id);
    const locationId = typeof l.location_id === "string" && l.location_id ? (await resolveLocation(tx, warehouseId, l.location_id)).id : null;
    const lotId = typeof l.lot_id === "string" && l.lot_id ? l.lot_id : null;
    if (!lotId && locationId && product.stockTracked) {
      // For a product that already has lot-tracked stock, a null lot_id with
      // a specific location would silently create or modify the "no lot" bucket
      // instead of the intended lot bucket — reject so the caller picks the right lot.
      const hasLots = await tx.stockMovement.findFirst({ where: { productId: product.id, lotId: { not: null } }, select: { id: true }, take: 1 });
      if (hasLots) throw new ApiError(400, `الصنف "${product.name}" له دفعات — لازم تحدّد رقم الدفعة في التسوية`);
    }
    let delta: Dec;
    if (l.counted_quantity !== undefined) {
      if (!locationId) throw new ApiError(400, "الجرد لازم يحدد المكان");
      const bucket = `${product.id}|${locationId}|${lotId ?? ""}`;
      if (countedBuckets.has(bucket)) throw new ApiError(400, "مينفعش تكرر نفس الصنف والمكان والدفعة في الجرد");
      countedBuckets.add(bucket);
      const counted = parseQty(l.counted_quantity, `الكمية المعدودة من "${product.name}"`, { allowZero: true });
      const expectedQuantity = await bucketBalance(tx, product.id, locationId, lotId);
      delta = counted.minus(expectedQuantity);
      if (delta.isZero()) continue; // the count agrees with the books: nothing to post
      out.push({ productId: product.id, quantity: delta.toFixed(), locationId, lotId, countedQuantity: counted.toFixed(), expectedQuantity: expectedQuantity.toFixed() });
      continue;
    } else {
      delta = await lineQty(tx, product, l, { allowNegative: true });
    }
    out.push({ productId: product.id, quantity: delta.toFixed(), locationId, lotId });
  }
  if (out.length === 0) throw new ApiError(400, "الجرد مطابق — مفيش فرق يتسجل");
  return out;
}

async function postAdjustmentLines(tx: Tx, doc: InventoryDocument, plan: PlannedAdjustment[], actor: ServiceActor, kind: "adjustment" | "scrap") {
  const moves: MoveInput[] = [];
  const claims = new PickClaims();
  for (const line of plan) {
    const product = await loadProduct(tx, line.productId);
    const qty = D(line.quantity);
    if (qty.gt(0)) {
      const loc = line.locationId ? { id: line.locationId } : await receivingLocation(tx, doc.warehouseId);
      moves.push({ productId: product.id, warehouseId: doc.warehouseId, locationId: loc.id, lotId: line.lotId, quantity: qty, kind, documentId: doc.id, reason: doc.reason });
    } else if (line.locationId && (line.lotId || kind === "adjustment")) {
      // A specific bucket (a count, or "this lot in this room"): take it from there.
      claims.add(product.id, line.locationId, line.lotId, qty.abs());
      moves.push({ productId: product.id, warehouseId: doc.warehouseId, locationId: line.locationId, lotId: line.lotId, quantity: qty, kind, documentId: doc.id, reason: doc.reason });
    } else {
      const picks = await allocate(tx, {
        productId: product.id,
        productName: product.name,
        warehouseId: doc.warehouseId,
        quantity: qty.abs(),
        strategy: product.removalStrategy as "fefo" | "fifo",
        locationId: line.locationId ?? undefined,
        claims,
      });
      for (const p of picks) {
        moves.push({ productId: product.id, warehouseId: doc.warehouseId, locationId: p.locationId, lotId: p.lotId, quantity: p.quantity.negated(), kind, documentId: doc.id, reason: doc.reason });
      }
    }
  }
  return postMovements(tx, moves, ctxOf(actor, doc.businessDate));
}

export async function createAdjustment(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.adjust");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new ApiError(400, "لازم تكتب سبب التسوية");
  const key = idempotencyKey(input.idempotency_key);
  const date = businessDate(input.business_date);
  const raw = lines(input);
  const threshold = D(await getSetting("inventory.adjustment_approval_threshold"));

  const requestHash = requestFingerprint(input);
  const result = await idempotent(key, requestHash, () =>
    inTx(async (tx) => {
      const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
      // Match the stock engine's lock order (availability → product valuation → bucket)
      // before reading a physical-count bucket, so a concurrent receipt/issue cannot
      // make the calculated variance stale before it posts.
      const productIds = [...new Set(raw.map((l) => typeof l.product_id === "string" ? l.product_id : "").filter(Boolean))].sort();
      for (const productId of productIds) await lockAvailability(tx, productId, wh.id);
      await lockProductValuations(tx, productIds);
      const countBuckets: { productId: string; locationId: string; lotId: string | null }[] = [];
      for (const line of raw) {
        if (line.counted_quantity === undefined) continue;
        const product = await loadProduct(tx, line.product_id);
        if (typeof line.location_id !== "string" || !line.location_id) throw new ApiError(400, "الجرد لازم يحدد المكان");
        const location = await resolveLocation(tx, wh.id, line.location_id);
        countBuckets.push({ productId: product.id, locationId: location.id, lotId: typeof line.lot_id === "string" && line.lot_id ? line.lot_id : null });
      }
      await lockForMoves(tx, countBuckets);
      const plan = await planAdjustment(tx, wh.id, raw);
      // Quarantine stock can only leave through the release workflow, not via
      // adjustment (even approved). Check every planned outgoing line.
      for (const p of plan) {
        if (p.locationId && D(p.quantity).lt(0)) {
          const loc = await tx.storageLocation.findUnique({ where: { id: p.locationId }, select: { type: true } });
          if (loc?.type === "quarantine") throw new ApiError(400, "مينفعش تعمل تسوية على المخزون المحجوز — استخدم التقرير للإفراج");
        }
      }
      const needsApproval = requiresAdjustmentApproval(plan, threshold);
      const doc = await createDoc(
        tx,
        "adjustment",
        { warehouseId: wh.id, businessDate: date, status: needsApproval ? "pending_approval" : "posted", reason, idempotencyKey: key, requestHash, payload: { lines: plan } },
        actor
      );
      if (needsApproval) {
        const names = await tx.stockProduct.findMany({ where: { id: { in: plan.map((l) => l.productId) } }, select: { id: true, name: true, unit: true } });
        const nameOf = new Map(names.map((n) => [n.id, n]));
        await requestApproval(tx, {
          type: "inventory.adjustment",
          entityId: doc.id,
          title: `${doc.number} · ${wh.code}`,
          summary: plan.map((l) => `${nameOf.get(l.productId)?.name}: ${D(l.quantity).gt(0) ? "+" : ""}${l.quantity} ${nameOf.get(l.productId)?.unit}`).join("، "),
          amount: plan.reduce((s, l) => s.plus(D(l.quantity).abs()), D(0)),
          payload: { lines: plan },
          reason,
          requester: actor,
        });
        await auditDoc(tx, doc, actor, "inventory_adjustment_requested", `${plan.length} سطر — مستني موافقة`);
        return doc;
      }
      await postAdjustmentLines(tx, doc, plan, actor, "adjustment");
      await auditDoc(tx, doc, actor, "stock_adjustment_created", `${plan.length} سطر`);
      return doc;
    })
  );
  return { ...result, document: await withMovements(result.document.id) };
}

/** Approval handler: posts a pending adjustment exactly as requested. Balances are
 * re-checked at this moment, not at request time — stock may have moved meanwhile. */
export async function postApprovedAdjustment(tx: Tx, documentId: string, decider: ServiceActor) {
  const doc = await tx.inventoryDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.status !== "pending_approval") throw new ApiError(409, "التسوية دي مش مستنية موافقة");
  const plan = ((doc.payload as { lines?: PlannedAdjustment[] } | null)?.lines ?? []) as PlannedAdjustment[];
  const productIds = [...new Set(plan.map((line) => line.productId))].sort();
  for (const productId of productIds) await lockAvailability(tx, productId, doc.warehouseId);
  await lockProductValuations(tx, productIds);
  await lockForMoves(tx, plan.filter((line) => line.locationId !== null).map((line) => ({ productId: line.productId, locationId: line.locationId!, lotId: line.lotId })));
  for (const line of plan) {
    if (line.expectedQuantity === undefined || !line.locationId) continue;
    const current = await bucketBalance(tx, line.productId, line.locationId, line.lotId);
    if (!current.eq(D(line.expectedQuantity))) throw new ApiError(409, "رصيد الدفعة اتغير من وقت طلب الموافقة؛ ارفض التسوية واعمل جرد جديد");
  }
  const updated = await tx.inventoryDocument.update({
    where: { id: doc.id, version: doc.version, status: "pending_approval" },
    data: { status: "posted", postedAt: new Date(), version: { increment: 1 } },
  });
  // Posted by the approver: the movements are theirs; who asked is on the document.
  await postAdjustmentLines(tx, updated, plan, decider, "adjustment");
  await auditDoc(tx, updated, decider, "stock_adjustment_created", `${plan.length} سطر — بعد الموافقة`);
}

export async function rejectPendingAdjustment(tx: Tx, documentId: string, decider: ServiceActor) {
  const doc = await tx.inventoryDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.status !== "pending_approval") throw new ApiError(409, "التسوية دي مش مستنية موافقة");
  const updated = await tx.inventoryDocument.update({
    where: { id: doc.id, version: doc.version },
    data: { status: "rejected", version: { increment: 1 } },
  });
  await auditDoc(tx, updated, decider, "inventory_adjustment_rejected", "اترفضت — مفيش حركة اتسجلت");
}

// ---------------------------------------------------------------------------
// Scrap (spoilage, damage) — always out, always with a reason
// ---------------------------------------------------------------------------

export async function createScrap(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.adjust");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new ApiError(400, "لازم تكتب سبب الإعدام/التالف");
  const key = idempotencyKey(input.idempotency_key);
  const date = businessDate(input.business_date);
  const raw = lines(input);
  const requestHash = requestFingerprint(input);
  const result = await idempotent(key, requestHash, () =>
    inTx(async (tx) => {
      const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
      const plan: PlannedAdjustment[] = [];
      for (const l of raw) {
        const product = await loadProduct(tx, l.product_id);
        const qty = await lineQty(tx, product, l);
        const locationId = typeof l.location_id === "string" && l.location_id ? (await resolveLocation(tx, wh.id, l.location_id)).id : null;
        plan.push({ productId: product.id, quantity: qty.negated().toFixed(), locationId, lotId: typeof l.lot_id === "string" && l.lot_id ? l.lot_id : null });
      }
      const doc = await createDoc(tx, "scrap", { warehouseId: wh.id, businessDate: date, status: "posted", reason, idempotencyKey: key, requestHash, payload: { lines: plan } }, actor);
      await postAdjustmentLines(tx, doc, plan, actor, "scrap");
      await auditDoc(tx, doc, actor, "inventory_scrap_posted", `${plan.length} سطر`);
      return doc;
    })
  );
  return { ...result, document: await withMovements(result.document.id) };
}

// ---------------------------------------------------------------------------
// Sorting — post-receipt produce grading
// ---------------------------------------------------------------------------

/**
 * Sorts produce that was received raw into good-grade, Grade B (separate SKU when
 * configured), and waste. Reconciles outputs against the input quantity exactly
 * (3-dp), posts all movements in one transaction, and links the document to the
 * source intake for traceability. Reuses the ledger's own balances so an
 * insufficient-stock sort is refused the same way every other reduction is.
 */
export async function createSorting(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.adjust");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new ApiError(400, "لازم تكتب سبب الفرز");
  const key = idempotencyKey(input.idempotency_key);
  const date = businessDate(input.business_date);
  const requestHash = requestFingerprint(input);

  const intakeId = typeof input.intake_id === "string" && input.intake_id ? input.intake_id : null;
  if (!intakeId) throw new ApiError(400, "اختار الاستلام المراد فرزه");

  // Exact quantities at 3-dp — the same precision the intake ledger uses.
  const inputKg = parseQty(input.input_kg, "الكمية الإجمالية المفرزة");
  const goodKg = parseQty(input.good_kg, "كمية الفرز الممتاز", { allowZero: true });
  const gradeBKg = parseQty(input.grade_b_kg ?? 0, "كمية الفُرزة (ب)", { allowZero: true });
  const wasteKg = parseQty(input.waste_kg ?? 0, "كمية الهالك", { allowZero: true });
  // Outputs must reconcile exactly with the input — no rounding crumbs.
  if (!inputKg.equals(goodKg.plus(gradeBKg).plus(wasteKg))) {
    throw new ApiError(
      400,
      `مجموع مخرجات الفرز (${goodKg.plus(gradeBKg).plus(wasteKg).toFixed(3)}) لازم يساوي الكمية المدخلة (${inputKg.toFixed(3)})`
    );
  }
  const gradeBProductId = typeof input.grade_b_product_id === "string" && input.grade_b_product_id ? input.grade_b_product_id : null;

  const result = await idempotent(key, requestHash, () =>
    inTx(async (tx) => {
      const intake = await tx.stockIntake.findUnique({
        where: { id: intakeId },
        include: { product: true, location: true, lot: true },
      });
      if (!intake) throw new ApiError(404, "الاستلام مش موجود");
      if (intake.status !== "posted") throw new ApiError(409, "الاستلام ده متلغى — مينفعش يترفرز");
      if (!intake.product.stockTracked) throw new ApiError(400, `"${intake.product.name}" مش صنف بيتتبع مخزونه`);

      // Grade B destination: separate product when one is named, otherwise the
      // legacy loc_grade_b bucket on the same product.
      let gradeBProduct = null;
      if (gradeBProductId) {
        gradeBProduct = await tx.stockProduct.findUnique({ where: { id: gradeBProductId } });
        if (!gradeBProduct) throw new ApiError(400, "المنتج المحدد للفرزة مش موجود");
        if (!gradeBProduct.stockTracked) throw new ApiError(400, "المنتج المحدد للفرزة مش متتبع مخزنيًا");
      }

      const wh = await resolveWarehouse(tx, intake.warehouseId);

      // --- grading cost allocation (policy-gated; proportional by default) ---
      // The raw product's current moving average is the value basis of this sort:
      // sorting_out removes at it; the outputs carry the allocated unit costs.
      // Lock the product valuation so the read and the posting cannot race.
      await lockProductValuations(tx, [intake.productId]);
      const rawVal = await productValuation(tx, intake.productId);
      const avgRaw = rawVal.qty.gt(0) ? rawVal.value.dividedBy(rawVal.qty).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP) : D(0);
      const gradingPolicy: GradingCostPolicy = await getSetting("inventory.grading_cost_policy");
      const wasteLossPolicy: WasteLossPolicy = await getSetting("inventory.grading_waste_loss");
      const priceProds: { id: string; unit: string; name: string }[] = [];
      if (inputKg.gt(0) && gradingPolicy === "nrv") {
        if (goodKg.gt(0)) priceProds.push({ id: intake.productId, unit: intake.product.unit, name: intake.product.name });
        if (gradeBProduct) priceProds.push({ id: gradeBProduct.id, unit: gradeBProduct.unit, name: gradeBProduct.name });
      }
      const prices: (Prisma.Decimal | null)[] = priceProds.length ? await gradingPrices(tx, priceProds, date) : [];
      const gcSort = computeGradingCosts({
        inputQty: inputKg, inputUnitCost: avgRaw,
        goodQty: goodKg, gradeBQty: gradeBKg, wasteQty: wasteKg,
        goodPrice: prices.length > 0 ? prices[0] : null,
        gradeBPrice: prices.length > 1 ? prices[1] : null,
        policy: gradingPolicy, wastePolicy: wasteLossPolicy,
      });
      if (gcSort.costBasis === "nrv_fallback_proportional" && (await getSetting("inventory.grading_price_missing")) === "refuse") {
        throw new ApiError(400, "سعر المخرجات غير متاح — حدد أسعار المنتجات في قائمة الأسعار الأول");
      }
      if (gcSort.costBasis === "nrv_fallback_proportional") {
        // Recorded AFTER createDoc so the audit row carries the real document id.
      }
      const moves: MoveInput[] = [];

      // 1. Take the raw stock being sorted out of the intake's own bucket.
      moves.push({
        productId: intake.productId,
        warehouseId: wh.id,
        locationId: intake.locationId,
        lotId: intake.lotId,
        quantity: inputKg.negated(),
        kind: "sorting_out",
        documentId: null, // set below once the doc exists
        intakeId: intake.id,
        reason,
        unitCost: avgRaw,
        costSource: "average",
      });

      // 2. Good-grade stays on the raw product, back into the same bucket.
      if (goodKg.gt(0)) {
        moves.push({
          productId: intake.productId,
          warehouseId: wh.id,
          locationId: intake.locationId,
          lotId: intake.lotId,
          quantity: goodKg,
          kind: "sorting_in",
          documentId: null,
          intakeId: intake.id,
          reason,
          unitCost: gcSort.goodUnitCost,
          costSource: "average",
        });
      }

      // 3. Grade B: separate product gets its own lot (like intake does); legacy
      //    mode uses loc_grade_b on the same product. The lot carries the
      //    allocated unit cost so lot and valuation layer agree at creation time.
      if (gradeBKg.gt(0)) {
        let gradeBLot = intake.lotId;
        if (gradeBProduct) {
          const lot = await tx.stockLot.create({
            data: {
              productId: gradeBProduct.id,
              lotNumber: await nextDocumentNumber(tx, "inventory.lot", date),
              receivedDate: intake.receivedDate,
              expiryDate: null,
              supplierId: intake.supplierId,
              unitCost: gcSort.gradeBUnitCost,
            },
          });
          gradeBLot = lot.id;
        }
        moves.push({
          productId: gradeBProduct ? gradeBProduct.id : intake.productId,
          warehouseId: wh.id,
          locationId: gradeBProduct ? (await receivingLocation(tx, wh.id)).id : "loc_grade_b",
          lotId: gradeBLot,
          quantity: gradeBKg,
          kind: "sorting_in",
          documentId: null,
          intakeId: intake.id,
          reason,
          unitCost: gcSort.gradeBUnitCost,
          costSource: "average",
        });
      }

      // 4. Waste to the waste bucket at the allocated cost.
      if (wasteKg.gt(0)) {
        moves.push({
          productId: intake.productId,
          warehouseId: wh.id,
          locationId: "loc_waste",
          lotId: intake.lotId,
          quantity: wasteKg,
          kind: "sorting_in",
          documentId: null,
          intakeId: intake.id,
          reason,
          unitCost: gcSort.wasteUnitCost,
          costSource: "average",
        });
      }

      const doc = await createDoc(
        tx,
        "grading",
        {
          warehouseId: wh.id,
          businessDate: date,
          status: "posted",
          reason,
          sourceType: "stock_intake",
          sourceId: intake.id,
          idempotencyKey: key,
          requestHash,
          payload: { inputKg: inputKg.toFixed(3), goodKg: goodKg.toFixed(3), gradeBKg: gradeBKg.toFixed(3), wasteKg: wasteKg.toFixed(3), gradeBProductId, costBasis: gcSort.costBasis, fallbackReason: gcSort.fallbackReason, goodUnitCost: gcSort.goodUnitCost?.toFixed(4) ?? null, gradeBUnitCost: gcSort.gradeBUnitCost?.toFixed(4) ?? null, wasteUnitCost: gcSort.wasteUnitCost?.toFixed(4) ?? null, wasteLoss: gcSort.wasteLoss.toFixed(2) },
        },
        actor
      );
      for (const m of moves) m.documentId = doc.id;
      await postMovements(tx, moves, { actorId: actor.id, actorName: actor.name, effectiveDate: date });
      if (gcSort.costBasis === "nrv_fallback_proportional") {
        await writeAudit({
          userId: actor.id, userName: actor.name, role: actor.role, action: "grading_cost_fallback",
          entityType: "inventory_document", entityId: doc.id, fieldChanged: "costBasis", oldValue: "nrv",
          newValue: `proportional · ${gcSort.fallbackReason ?? "missing_price"}`, source: "user", deviceId: actor.deviceId, reason: "سعر المخرجات غير متاح — اتروزعت التكلفة بالتناسب",
        }, tx);
      }
      await auditDoc(tx, doc, actor, "inventory_sorting_posted", `فرز ${inputKg.toFixed(3)} كجم → ممتاز ${goodKg.toFixed(3)} · فرزة ${gradeBKg.toFixed(3)} · هالك ${wasteKg.toFixed(3)}`);
      return doc;
    })
  );
  return { ...result, document: await withMovements(result.document.id) };
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/** Goods coming back from a customer. Default destination: the quarantine location,
 * when the warehouse has one — returned produce is inspected before it is sold again. */
export async function createCustomerReturn(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.receive");
  const key = idempotencyKey(input.idempotency_key);
  const requestHash = requestFingerprint(input);
  const result = await idempotent(key, requestHash, () => inTx((tx) => postCustomerReturnInTx(tx, input, actor, key, requestHash)));
  return { ...result, document: await withMovements(result.document.id) };
}

/**
 * Goods back from a customer, inside the caller's transaction — the delivery result
 * (Phase 5) posts the rejected goods this way, in the same step as recording it.
 * The caller has already decided the actor may do this.
 */
export async function postCustomerReturnInTx(tx: Tx, input: Record<string, unknown>, actor: ServiceActor, key: string | null = null, requestHash?: string) {
  const date = businessDate(input.business_date);
  const raw = lines(input);
  const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
  const quarantine = await tx.storageLocation.findFirst({ where: { warehouseId: wh.id, type: "quarantine", active: true }, orderBy: { code: "asc" } });
  // The order it came back from, by id or by its printed number — and it must exist:
  // a return pointing at nothing cannot be reconciled against a sale later.
  let orderId: string | null = null;
  const orderRef = typeof input.order_id === "string" ? input.order_id.trim() : "";
  if (orderRef) {
    const order = await tx.order.findFirst({ where: { OR: [{ id: orderRef }, { orderNumber: orderRef }] }, select: { id: true } });
    if (!order) throw new ApiError(404, `الأوردر ${orderRef} مش موجود`);
    orderId = order.id;
  }
  // Serialise customer returns for the same order so no two requests both see
  // room to return the same goods. After the lock, enforce that cumulative
  // returned goods never exceed what was dispatched for the order — a customer
  // can only send back what actually left.
  let issuedPerProduct: Map<string, Prisma.Decimal> | null = null;
  let alreadyReturned: Map<string, Prisma.Decimal> | null = null;
  if (orderId) {
    await advisoryXactLock(tx, `inventory:customer-return:${orderId}`);
    const eligible = await tx.$queryRaw<{ productId: string; qty: Prisma.Decimal }[]>`
      SELECT m."productId", -sum(m."quantity") AS qty
      FROM "StockMovement" m JOIN "InventoryDocument" d ON d."id" = m."documentId"
      WHERE d."type" = 'issue' AND d."reversalOfId" IS NULL
        AND d."sourceType" = 'order' AND d."sourceId" = ${orderId}
        AND m."kind" = 'issue'
      GROUP BY m."productId"`;
    issuedPerProduct = new Map(eligible.map((r) => [r.productId, D(r.qty)]));
    const already = await tx.$queryRaw<{ productId: string; qty: Prisma.Decimal }[]>`
              SELECT m."productId", sum(m."quantity") AS qty
              FROM "StockMovement" m
                JOIN "InventoryDocument" d ON d."id" = m."documentId" AND d."type" = 'customer_return'
              WHERE d."sourceType" = 'order' AND d."sourceId" = ${orderId}
                AND d."status" = 'posted' AND d."reversalOfId" IS NULL
                AND m."kind" = 'customer_return'
              GROUP BY m."productId"`;
    alreadyReturned = new Map(already.map((r) => [r.productId, D(r.qty)]));
  }
  const doc = await createDoc(
    tx,
    "customer_return",
    {
      warehouseId: wh.id,
      businessDate: date,
      status: "posted",
      reason: input.reason as string,
      sourceType: orderId ? "order" : null,
      sourceId: orderId,
      idempotencyKey: key,
      requestHash,
    },
    actor
  );
  const moves: MoveInput[] = [];
  for (const l of raw) {
    const product = await loadProduct(tx, l.product_id);
    const qty = await lineQty(tx, product, l);
    const loc = l.location_id ? await resolveLocation(tx, wh.id, l.location_id as string) : quarantine ?? (await receivingLocation(tx, wh.id));
    moves.push({ productId: product.id, warehouseId: wh.id, locationId: loc.id, lotId: typeof l.lot_id === "string" && l.lot_id ? l.lot_id : null, quantity: qty, kind: "customer_return", documentId: doc.id });
  }
  // Enforce the cumulative physical-return invariant: cumulative returns for an
  // order never exceed what was dispatched for it (issues, net of reversals).
  // Unlinked returns (no order) stay a legitimate warehouse-only workflow. When
  // the order was never issued (e.g. reserved and cancelled before dispatch), the
  // cap does not apply — the sale never economically happened.
  if (orderId && issuedPerProduct && issuedPerProduct.size > 0) {
    for (const m of moves) {
      const issued = issuedPerProduct.get(m.productId) ?? D(0);
      const previously = alreadyReturned?.get(m.productId) ?? D(0);
      if (m.quantity.plus(previously).greaterThan(issued))
        throw new ApiError(409, `المرتجع التراكمي ${m.quantity.plus(previously).toFixed(3)} أكتر من اللي اتشحن للطلب (${issued.toFixed(3)})`);
    }
  }
  await postMovements(tx, moves, ctxOf(actor, date));
  await auditDoc(tx, doc, actor, "inventory_customer_return_posted", `${raw.length} سطر`);
  return doc;
}

/** Goods sent back to a supplier — out at the lot's own cost when the lot is known. */
export async function createSupplierReturn(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.receive");
  if (typeof input.supplier_id !== "string" || !input.supplier_id) throw new ApiError(400, "اختار المورد");
  const key = idempotencyKey(input.idempotency_key);
  const date = businessDate(input.business_date);
  const raw = lines(input);
  const requestHash = requestFingerprint(input);
  const result = await idempotent(key, requestHash, () =>
    inTx(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id: input.supplier_id as string } });
      if (!supplier) throw new ApiError(404, "المورد مش موجود");
      const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
      // A supplier can only take back what we actually received from them: enforce
      // the cumulative received-vs-returned invariant per supplier+product.
      await advisoryXactLock(tx, `inventory:supplier-return:${supplier.id}`);
      const receivedByProduct = new Map(
        (await tx.$queryRaw<{ productId: string; qty: Prisma.Decimal }[]>`
          SELECT m."productId", sum(m."quantity") AS qty
          FROM "StockMovement" m JOIN "StockIntake" si ON si."id" = m."intakeId"
          WHERE si."supplierId" = ${supplier.id}
          GROUP BY m."productId"`).map((r) => [r.productId, D(r.qty)])
      );
      const returnedByProduct = new Map(
        (await tx.$queryRaw<{ productId: string; qty: Prisma.Decimal }[]>`
          SELECT m."productId", sum(-m."quantity") AS qty
          FROM "StockMovement" m
            JOIN "InventoryDocument" d ON d."id" = m."documentId" AND d."type" = 'supplier_return'
          WHERE d."supplierId" = ${supplier.id} AND d."status" = 'posted' AND d."reversalOfId" IS NULL
            AND m."kind" = 'supplier_return'
          GROUP BY m."productId"`).map((r) => [r.productId, D(r.qty)])
      );
      const doc = await createDoc(tx, "supplier_return", { warehouseId: wh.id, businessDate: date, status: "posted", reason: input.reason as string, supplierId: supplier.id, idempotencyKey: key, requestHash }, actor);
      const moves: MoveInput[] = [];
      const claims = new PickClaims();
      for (const l of raw) {
        const product = await loadProduct(tx, l.product_id);
        const qty = await lineQty(tx, product, l);
        const received = receivedByProduct.get(product.id) ?? D(0);
        const alreadyReturned = returnedByProduct.get(product.id) ?? D(0);
        if (qty.plus(alreadyReturned).greaterThan(received))
          throw new ApiError(409, `المرتجع التراكمي ${qty.plus(alreadyReturned).toFixed(3)} أكتر من اللي اتسلم من المورد (${received.toFixed(3)})`);
        if (typeof l.lot_id === "string" && l.lot_id) {
          const lot = await tx.stockLot.findUnique({ where: { id: l.lot_id } });
          if (!lot || lot.productId !== product.id) throw new ApiError(400, "الدفعة مش تابعة للصنف");
          const loc = await resolveLocation(tx, wh.id, l.location_id as string);
          claims.add(product.id, loc.id, lot.id, qty);
          moves.push({ productId: product.id, warehouseId: wh.id, locationId: loc.id, lotId: lot.id, quantity: qty.negated(), kind: "supplier_return", documentId: doc.id, unitCost: lot.unitCost == null ? null : D(lot.unitCost), costSource: "lot" });
        } else {
          const picks = await allocate(tx, { productId: product.id, productName: product.name, warehouseId: wh.id, quantity: qty, strategy: product.removalStrategy as "fefo" | "fifo", locationId: (l.location_id as string) || undefined, claims });
          for (const p of picks) moves.push({ productId: product.id, warehouseId: wh.id, locationId: p.locationId, lotId: p.lotId, quantity: p.quantity.negated(), kind: "supplier_return", documentId: doc.id });
        }
      }
      await postMovements(tx, moves, ctxOf(actor, date));
      await auditDoc(tx, doc, actor, "inventory_supplier_return_posted", `${supplier.name} · ${raw.length} سطر`);
      return doc;
    })
  );
  return { ...result, document: await withMovements(result.document.id) };
}

// ---------------------------------------------------------------------------
// Reversal — the only way to undo a posted document
// ---------------------------------------------------------------------------

export async function reverseDocument(documentId: string, input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "stock.adjust");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new ApiError(400, "لازم تكتب سبب الإلغاء");
  const reversalId = await inTx(async (tx) => {
    const doc = await tx.inventoryDocument.findUnique({ where: { id: documentId }, select: { type: true } });
    if (doc?.type === "issue") throw new ApiError(400, "الصرف بيتلغي من الأوردر نفسه، مش من هنا");
    return reverseDocumentInTx(tx, documentId, reason, actor);
  });
  // Read after commit: inside the transaction, the global client cannot see it yet.
  return withMovements(reversalId);
}

/**
 * Posts the exact opposite of a posted document, in the caller's transaction, and
 * marks the original reversed. Used directly by the order flow (a dispatched order
 * that is reopened takes its stock issue back).
 */
export async function reverseDocumentInTx(tx: Tx, documentId: string, reason: string, actor: ServiceActor) {
    await advisoryXactLock(tx, `inventory-doc:${documentId}`);
    const doc = await tx.inventoryDocument.findUnique({ where: { id: documentId }, include: { movements: true } });
    if (!doc) throw new ApiError(404, "المستند مش موجود");
    if (doc.status !== "posted") throw new ApiError(409, "المستند ده مش متسجل — مفيش حاجة تتلغي");
    const reversal = await createDoc(
      tx,
      doc.type as DocType,
      { warehouseId: doc.warehouseId, businessDate: todayLocalISO(), status: "posted", reason: `إلغاء ${doc.number}: ${reason}`, idempotencyKey: null, reversalOfId: doc.id, sourceType: doc.sourceType, sourceId: doc.sourceId, supplierId: doc.supplierId },
      actor
    );
    // Undo in reverse order (transfer: take back from the destination first), each
    // movement negated at the cost it was posted at, so value returns exactly.
    const opposite: Record<string, MoveInput["kind"]> = {
      transfer_in: "transfer_out",
      transfer_out: "transfer_in",
      adjustment: "adjustment",
      scrap: "adjustment",
      customer_return: "adjustment",
      supplier_return: "adjustment",
    };
    const moves: MoveInput[] = [...doc.movements].reverse().map((m) => ({
      productId: m.productId,
      warehouseId: m.warehouseId,
      locationId: m.locationId,
      lotId: m.lotId,
      quantity: D(m.quantity).negated(),
      kind: opposite[m.kind] ?? "adjustment",
      documentId: reversal.id,
      reason: `إلغاء ${doc.number}`,
      unitCost: m.unitCost == null ? null : D(m.unitCost),
      costSource: "lot",
    }));
    await postMovements(tx, moves, ctxOf(actor, reversal.businessDate));
    await tx.inventoryDocument.update({ where: { id: doc.id, version: doc.version }, data: { status: "reversed", version: { increment: 1 } } });
    await auditDoc(tx, reversal, actor, "inventory_document_reversed", `إلغاء ${doc.number}`);
    return reversal.id;
}

const MAX_LIST_PAGE = 200;

export async function listDocuments(filters: { type?: string; status?: string; limit?: number; offset?: number }) {
  const take = Math.min(Math.max(filters.limit ?? 50, 1), MAX_LIST_PAGE);
  const skip = Math.max(filters.offset ?? 0, 0);
  const where = { ...(filters.type ? { type: filters.type } : {}), ...(filters.status ? { status: filters.status } : {}) };
  const [total, rows] = await Promise.all([
    prisma.inventoryDocument.count({ where }),
    prisma.inventoryDocument.findMany({
      where, orderBy: { createdAt: "desc" }, skip, take,
      include: { movements: { include: { location: { select: { code: true, name: true, nameAr: true } }, lot: { select: { lotNumber: true } }, product: { select: { name: true, nameAr: true, unit: true } } } } },
    }),
  ]);
  return { documents: rows, pagination: { total, limit: take, offset: skip } };
}

export const DOCUMENT_TYPE_LABEL = DOC_LABEL;

// ---------------------------------------------------------------------------
// Go-live opening stock, and returns driven by commercial documents
// ---------------------------------------------------------------------------

/**
 * Stock brought over at go-live: each line becomes a lot (with its cost and expiry) in
 * one adjustment document marked as the opening balance. Through the stock ledger like
 * any receipt — so quantity, valuation and the GL (Inventory ↔ opening-balance equity)
 * move together.
 */
export async function postOpeningStock(input: Record<string, unknown>, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const date = businessDate(input.business_date);
  const raw = lines(input);
  const key = idempotencyKey(input.idempotency_key);
  // A retried submit returns the stock the first one brought in — never twice the opening stock.
  const requestHash = requestFingerprint(input);
  const result = await idempotent(key, requestHash, () => inTx(async (tx) => {
    const wh = await resolveWarehouse(tx, input.warehouse_id as string | undefined);
    const doc = await createDoc(tx, "adjustment", { warehouseId: wh.id, businessDate: date, status: "posted", reason: "رصيد مخزون افتتاحي", sourceType: "opening_balance", idempotencyKey: key, requestHash }, actor);
    const moves: MoveInput[] = [];
    for (const l of raw) {
      const product = await loadProduct(tx, l.product_id);
      const qty = await lineQty(tx, product, l);
      const rawCost = l.unit_cost === undefined || l.unit_cost === null ? "" : String(l.unit_cost).trim();
      if (!/^\d+(\.\d{1,4})?$/.test(rawCost)) throw new ApiError(400, `"${product.name}": تكلفة الوحدة الافتتاحية مطلوبة (رقم موجب)`);
      const cost = D(rawCost);
      const expiry = typeof l.expiry_date === "string" && l.expiry_date ? l.expiry_date : null;
      if (expiry && !isValidISODate(expiry)) throw new ApiError(400, "تاريخ الانتهاء لازم يكون YYYY-MM-DD");
      // Stock already past its expiry at go-live is not opening stock: it is scrapped in
      // the old system (or counted as waste) before the cut-off, never carried over.
      if (expiry && expiry < date) throw new ApiError(400, `"${product.name}": الدفعة منتهية الصلاحية (${expiry}) قبل تاريخ الرصيد الافتتاحي ${date} — اعدمها قبل النقل، ماتنقلهاش كرصيد`);
      const lot = await tx.stockLot.create({ data: { productId: product.id, lotNumber: await nextDocumentNumber(tx, "inventory.lot", date), receivedDate: date, expiryDate: expiry, unitCost: cost } });
      const loc = l.location_id ? await resolveLocation(tx, wh.id, l.location_id as string) : await receivingLocation(tx, wh.id);
      moves.push({ productId: product.id, warehouseId: wh.id, locationId: loc.id, lotId: lot.id, quantity: qty, kind: "adjustment", documentId: doc.id, unitCost: cost, costSource: "purchase", reason: "رصيد افتتاحي" });
    }
    await postMovements(tx, moves, ctxOf(actor, date));
    await auditDoc(tx, doc, actor, "opening_stock_posted", `${raw.length} صنف`);
    return doc;
  }));
  return result.document;
}

/**
 * Goods going back to a supplier, inside the caller's transaction (a debit note that
 * returns goods). Taken first from the lot the receipt created — so they leave at the
 * cost they came in at — then, if that lot no longer holds enough, FEFO across the product.
 */
export async function postReturnToSupplierInTx(tx: Tx, input: { supplierId: string; reason: string; date: string; lines: { productId: string; lotId: string | null; quantity: Dec }[] }, actor: ServiceActor) {
  const wh = await resolveWarehouse(tx, undefined);
  const doc = await createDoc(tx, "supplier_return", { warehouseId: wh.id, businessDate: input.date, status: "posted", reason: input.reason, supplierId: input.supplierId, idempotencyKey: null }, actor);
  const moves: MoveInput[] = [];
  const claims = new PickClaims();
  for (const l of input.lines) {
    const product = await loadProduct(tx, l.productId);
    let left = l.quantity;
    if (l.lotId) {
      const lot = await tx.stockLot.findUnique({ where: { id: l.lotId } });
      const buckets = await tx.stockMovement.groupBy({ by: ["locationId"], where: { productId: product.id, warehouseId: wh.id, lotId: l.lotId }, _sum: { quantity: true } });
      for (const b of buckets) {
        const have = D(b._sum.quantity ?? 0);
        if (!left.gt(0) || !have.gt(0)) continue;
        const take = have.lessThan(left) ? have : left;
        claims.add(product.id, b.locationId, l.lotId, take);
        moves.push({ productId: product.id, warehouseId: wh.id, locationId: b.locationId, lotId: l.lotId, quantity: take.negated(), kind: "supplier_return", documentId: doc.id, unitCost: lot?.unitCost == null ? null : D(lot.unitCost), costSource: "lot" });
        left = left.minus(take);
      }
    }
    if (left.gt(0)) {
      const picks = await allocate(tx, { productId: product.id, productName: product.name, warehouseId: wh.id, quantity: left, strategy: product.removalStrategy as "fefo" | "fifo", claims });
      for (const p of picks) moves.push({ productId: product.id, warehouseId: wh.id, locationId: p.locationId, lotId: p.lotId, quantity: p.quantity.negated(), kind: "supplier_return", documentId: doc.id });
    }
  }
  await postMovements(tx, moves, ctxOf(actor, input.date));
  await auditDoc(tx, doc, actor, "inventory_supplier_return_posted", input.reason);
  return doc;
}
