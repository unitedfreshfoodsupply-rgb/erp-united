import { Prisma } from "@prisma/client";
import { asText } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { writeAudit, writeAuditMany } from "@/lib/audit";
import { ApiError } from "@/lib/rbac";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import type { StockActor } from "@/lib/stock-auth";
import { isValidISODate } from "@/lib/dates";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { D, num, parseMoney, parseQty, type Dec } from "@/lib/inventory/decimal";
import { postMovements, type MoveInput } from "@/lib/inventory/ledger";
import { resolveLocation, resolveWarehouse } from "@/lib/inventory/context";
import { toBaseQuantity } from "@/lib/inventory/packaging";
import { createAdjustment as createAdjustmentDocument } from "@/lib/inventory/documents";
import { computeGradingCosts, type GradingCostPolicy, type WasteLossPolicy } from "@/lib/inventory/grading";
import { gradingPrices } from "@/lib/sales/pricing";
import { getSetting } from "@/lib/core/settings-service";
import { afterPoReceipt, guardPoReceipt, loadPoLine, poLineUnitCost, lockPoForReceipt } from "@/lib/purchasing/receiving";
import { assertReceiptNotBilled } from "@/lib/purchasing/bills";
import { postJournal } from "@/lib/accounting/ledger";

/** Row-locks a receipt (a supplier bill being booked on it takes the same lock) and
 * refuses when it is already on a live bill — the bill was matched against it. */
async function lockUnbilledReceipt(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "StockIntake" WHERE "id" = ${id} FOR UPDATE`;
  await assertReceiptNotBilled(tx, id);
}

// ---------------------------------------------------------------------------
// Stock service.
//
// The one rule everything else follows: current stock is never stored. It is
// SUM(quantity) over an append-only StockMovement ledger, so a balance cannot
// drift from the history that produced it, and no two requests can ever race to
// update "the current number" — there isn't one. Corrections are compensating
// entries, exactly like a journal, so yesterday's reported figures stay reportable.
//
// Every write below: computes its own numbers server-side (the client never sends a
// derived value), runs in one transaction together with its ledger rows, and leaves
// an audit trail through the existing writeAudit().
// ---------------------------------------------------------------------------

// The ledger, its movement kinds and its rules live in lib/inventory/ledger.ts; this
// module is the receiving desk and the legacy stock screens built on top of it.
export { MOVEMENT_KINDS, type MovementKind } from "@/lib/inventory/ledger";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Weights are kilos to 3 decimals; rounding at the boundary keeps float noise
 * (0.1 + 0.2) out of the ledger and out of the yield percentages built from it. */
const KG_DP = 3;

export function roundKg(n: number) {
  return Math.round(n * 10 ** KG_DP) / 10 ** KG_DP;
}

/** Yield is good output as a share of what arrived. Undefined (not 0, not 100) when
 * nothing arrived — a supplier with no deliveries has no yield, and showing 0% would
 * read as "they delivered nothing usable". */
export function yieldPct(receivedKg: number, goodKg: number): number | null {
  if (receivedKg <= 0) return null;
  return Math.round((goodKg / receivedKg) * 1000) / 10;
}

function assertDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new ApiError(400, `${label} لازم يكون بصيغة YYYY-MM-DD`);
  }
}

function versionConflict(what: string, current: number): never {
  throw new ApiError(
    409,
    `${what} اتغيّر من واحد تاني، حدّث الشاشة وحاول تاني (النسخة الحالية: ${current})`
  );
}

/**
 * Same compare-and-swap the order service uses: the expected version goes into the
 * UPDATE's WHERE, so two concurrent edits can't both read version N and both write
 * N+1. The loser matches no row and gets a 409 instead of silently overwriting.
 */
function isNoRowMatched(err: unknown) {
  return (err as { code?: string })?.code === "P2025";
}

function assertVersion(current: number, expected: number | undefined, what: string) {
  if (expected !== undefined && expected !== current) versionConflict(what, current);
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function listSuppliers(opts: { includeInactive?: boolean } = {}) {
  return prisma.supplier.findMany({
    where: opts.includeInactive ? undefined : { active: true },
    orderBy: { name: "asc" },
  });
}

export async function createSupplier(
  input: { name: string; phone?: string; notes?: string },
  actor: StockActor
) {
  const name = asText(input.name, "name")?.trim();
  if (!name) throw new ApiError(400, "اسم المورد مطلوب");

  return inTx(async (tx) => {
    let supplier;
    try {
      supplier = await tx.supplier.create({
        data: { code: await nextDocumentNumber(tx, "purchasing.supplier", todayLocalISO()), name, phone: asText(input.phone, "phone")?.trim() || null, notes: asText(input.notes, "notes")?.trim() || null },
      });
    } catch (err) {
      // Unique on name and on lower(name) — the second is what catches "Mango"/"mango".
      if ((err as { code?: string })?.code === "P2002") {
        throw new ApiError(409, `المورد "${name}" موجود بالفعل`);
      }
      throw err;
    }

    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "supplier_created",
        entityType: "supplier",
        entityId: supplier.id,
        newValue: supplier.name,
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    return supplier;
  });
}

export async function updateSupplier(
  id: string,
  fields: Partial<{ name: string; phone: string; notes: string; active: boolean }>,
  actor: StockActor,
  expectedVersion?: number
) {
  const existing = await prisma.supplier.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "المورد مش موجود");
  assertVersion(existing.version, expectedVersion, "المورد");

  const data: Prisma.SupplierUpdateInput = {};
  const changes: [string, string | null, string | null][] = [];
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (!name) throw new ApiError(400, "اسم المورد مطلوب");
    if (name !== existing.name) {
      data.name = name;
      changes.push(["name", existing.name, name]);
    }
  }
  for (const key of ["phone", "notes"] as const) {
    if (fields[key] !== undefined) {
      const next = fields[key]!.trim() || null;
      if (next !== existing[key]) {
        (data as Record<string, unknown>)[key] = next;
        changes.push([key, existing[key], next]);
      }
    }
  }
  if (fields.active !== undefined && fields.active !== existing.active) {
    data.active = fields.active;
    changes.push(["active", String(existing.active), String(fields.active)]);
  }
  if (changes.length === 0) return existing;

  return inTx(async (tx) => {
    let updated;
    try {
      updated = await tx.supplier.update({
        where: { id, version: existing.version },
        data: { ...data, version: { increment: 1 } },
      });
    } catch (err) {
      if (isNoRowMatched(err)) versionConflict("المورد", existing.version);
      if ((err as { code?: string })?.code === "P2002") throw new ApiError(409, "فيه مورد بنفس الاسم");
      throw err;
    }

    await writeAuditMany(
      changes.map(([field, oldValue, newValue]) => ({
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "supplier_updated",
        entityType: "supplier" as const,
        entityId: id,
        fieldChanged: field,
        oldValue,
        newValue,
        source: "user" as const,
        deviceId: actor.deviceId,
      })),
      tx
    );
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

// Product CRUD moved to lib/product-master-service.ts. Products now carry canonical
// identity (names, aliases, SKU) that this module has no business duplicating — stock
// operations consume a product id, they do not decide what a product is.

// ---------------------------------------------------------------------------
// Receipt numbering — RC-YYYYMMDD-####, same advisory-lock approach as orders.
// ---------------------------------------------------------------------------

function receiptPrefix(receivedDate: string) {
  return `RC-${receivedDate.replace(/-/g, "")}-`;
}

async function nextReceiptNumber(tx: Prisma.TransactionClient, prefix: string) {
  const suffixStart = prefix.length + 1; // Postgres SUBSTRING is 1-indexed
  const rows = await tx.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX(SUBSTRING("receiptNumber" FROM ${suffixStart}::int)::int) AS max_seq
    FROM "StockIntake"
    WHERE "receiptNumber" LIKE ${prefix + "%"}
      AND SUBSTRING("receiptNumber" FROM ${suffixStart}::int) ~ '^[0-9]+$'
  `;
  return `${prefix}${String(Number(rows[0]?.max_seq ?? 0) + 1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Serialisation for the stock screens.
//
// The ledger is exact decimal now. The screens and API built on the original stock
// module read numbers named *Kg; they keep getting them (exact at 3 dp), alongside
// the decimal-string fields the inventory API uses.
// ---------------------------------------------------------------------------

const INTAKE_INCLUDE = {
  supplier: { select: { id: true, name: true, nameAr: true } },
  product: { select: { id: true, name: true, nameAr: true, unit: true } },
  gradeBProduct: { select: { id: true, name: true, nameAr: true, unit: true } },
  location: { select: { id: true, code: true, name: true, nameAr: true } },
  lot: { select: { id: true, lotNumber: true, expiryDate: true } },
  purchaseOrderLine: { select: { id: true, lineNo: true, po: { select: { id: true, number: true } } } },
} as const;

type IntakeRow = Prisma.StockIntakeGetPayload<{ include: typeof INTAKE_INCLUDE }>;

export function serializeIntake(row: IntakeRow) {
  return {
    ...row,
    receivedKg: num(row.receivedQty),
    rejectedKg: num(row.rejectedQty),
    goodKg: num(row.goodQty),
    gradeBQty: num(row.gradeBQty),
    wasteQty: num(row.wasteQty),
  };
}

const MOVEMENT_INCLUDE = {
  product: { select: { id: true, name: true, nameAr: true, unit: true } },
  intake: { select: { id: true, receiptNumber: true, supplier: { select: { name: true, nameAr: true } } } },
  location: { select: { id: true, code: true } },
  lot: { select: { id: true, lotNumber: true, expiryDate: true } },
  document: { select: { id: true, number: true, type: true } },
} as const;

type MovementRow = Prisma.StockMovementGetPayload<{ include: typeof MOVEMENT_INCLUDE }>;

export function serializeMovement(m: MovementRow) {
  return { ...m, quantityKg: num(m.quantity) };
}

// ---------------------------------------------------------------------------
// Intake — the daily entry
// ---------------------------------------------------------------------------

export type IntakeInput = {
  supplier_id: string;
  product_id: string;
  received_date?: string;
  /** Base-unit quantity. Named for the original kg-only screens; `received_qty` is
   * the same thing. */
  received_kg?: unknown;
  received_qty?: unknown;
  rejected_kg?: unknown;
  rejected_qty?: unknown;
  /** Quantity sorted as second-grade / فرزة at intake. */
  grade_b_qty?: unknown;
  /** Quantity identified as unsaleable waste / هالك at intake. */
  waste_qty?: unknown;
  /** Optional separate product for Grade B / فرزة output (own SKU, own pricing). */
  grade_b_product_id?: unknown;
  /** Counted in another unit (e.g. 40 CRATE) — converted through the product's packaging. */
  entered_qty?: unknown;
  entered_uom?: unknown;
  crate_count?: number | null;
  notes?: string;
  warehouse_id?: string;
  location_id?: string;
  expiry_date?: string;
  unit_cost?: unknown;
  /** The purchase order line this delivery fulfils. */
  purchase_order_line_id?: string;
  /** Why the rejected part was rejected (sorting / quality). */
  rejection_reason?: string;
  /** One key per submitted receiving form: the same key returns the same receipt. */
  idempotency_key?: unknown;
};

/** The key's first receipt, if it is the same receipt; a different one under the same key is refused. */
function sameIntake<T extends { supplierId: string; productId: string; purchaseOrderLineId: string | null; receivedQty: Dec; rejectedQty: Dec }>(
  prev: T,
  now: { supplierId: string; productId: string; purchaseOrderLineId: string | null; received: Dec; rejected: Dec }
): T {
  const same = prev.supplierId === now.supplierId && prev.productId === now.productId && prev.purchaseOrderLineId === now.purchaseOrderLineId && prev.receivedQty.equals(now.received) && prev.rejectedQty.equals(now.rejected);
  if (!same) throw new ApiError(409, `مفتاح التكرار ده اتسجل بيه استلام تاني (${(prev as unknown as { receiptNumber?: string }).receiptNumber ?? ""}) بكميات أو صنف مختلف`);
  return prev;
}

function intakeKey(raw: unknown) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 120) throw new ApiError(400, "مفتاح التكرار (idempotency_key) غير صالح");
  return raw;
}

function validateCrates(crateCount: number | null) {
  if (crateCount !== null && (!Number.isInteger(crateCount) || crateCount < 0)) {
    throw new ApiError(400, "عدد الأقفاص لازم يكون رقم صحيح موجب");
  }
}

function receivedNumbers(receivedRaw: unknown, rejectedRaw: unknown, gradeBRaw?: unknown, wasteRaw?: unknown) {
  const received = parseQty(receivedRaw, "الكمية المستلمة");
  const rejected = parseQty(rejectedRaw ?? 0, "كمية الفرز/المرفوض", { allowZero: true });
  const gradeB = parseQty(gradeBRaw ?? 0, "كمية الفُرزة", { allowZero: true });
  const waste = parseQty(wasteRaw ?? 0, "كمية الهالك", { allowZero: true });
  if (gradeB.plus(waste).plus(rejected).greaterThan(received)) throw new ApiError(400, "مجموع الفُرزة والهالك والمرفوض مينفعش يكون أكبر من الكمية المستلمة");
  return { received, rejected, gradeB, waste, good: received.minus(gradeB).minus(waste).minus(rejected) };
}

function addDays(dateISO: string, days: number) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function createIntake(input: IntakeInput, actor: StockActor) {
  return (await recordIntake(input, actor)).intake;
}

/**
 * Records a receipt once per client key. A repeat of the same request — sequential, a
 * retry after a timeout, or concurrent — returns the first receipt (`replayed`) and
 * posts nothing; the same key on a different receipt is refused. Without a key the
 * receipt is recorded as before.
 */
export async function recordIntake(input: IntakeInput, actor: StockActor) {
  const key = intakeKey(input.idempotency_key);
  const receivedDate = input.received_date ?? todayLocalISO();
  assertDate(receivedDate, "تاريخ الاستلام");
  // Against a purchase order: the line names the supplier and the product, and sets
  // the cost — the receiver neither chooses nor sees it.
  const poLine = input.purchase_order_line_id ? await loadPoLine(input.purchase_order_line_id) : null;
  if (poLine) {
    if (input.supplier_id && input.supplier_id !== poLine.po.supplierId) throw new ApiError(400, `المورد مش هو مورد أمر الشراء ${poLine.po.number}`);
    if (input.product_id && input.product_id !== poLine.productId) throw new ApiError(400, `الصنف مش هو صنف السطر في أمر الشراء ${poLine.po.number}`);
    if (input.unit_cost !== undefined && input.unit_cost !== null && input.unit_cost !== "") throw new ApiError(400, "تكلفة الاستلام على أمر شراء بتيجي من الأمر نفسه");
    input = { ...input, supplier_id: poLine.po.supplierId, product_id: poLine.productId };
  }
  const tolerancePct = poLine ? await getSetting("purchasing.over_receipt_tolerance_pct") : 0;
  if (!input.supplier_id) throw new ApiError(400, "اختار المورد");
  if (!input.product_id) throw new ApiError(400, "اختار الصنف");
  const crateCount = input.crate_count == null ? null : Number(input.crate_count);
  validateCrates(crateCount);
  if (input.expiry_date !== undefined && input.expiry_date !== null && input.expiry_date !== "" && !isValidISODate(input.expiry_date)) {
    throw new ApiError(400, "تاريخ الصلاحية لازم يكون بصيغة YYYY-MM-DD");
  }
  const unitCost = poLine ? poLineUnitCost(poLine) : parseMoney(input.unit_cost, "سعر الوحدة");

  const [supplier, product] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: input.supplier_id } }),
    prisma.stockProduct.findUnique({ where: { id: input.product_id } }),
  ]);
  if (!supplier) throw new ApiError(404, "المورد مش موجود");
  if (!product) throw new ApiError(404, "الصنف مش موجود");
  if (!supplier.active) throw new ApiError(400, `المورد "${supplier.name}" موقوف`);
  if (!product.active) throw new ApiError(400, `الصنف "${product.name}" موقوف`);
  // Validate grade B product when specified.
  let gradeBProduct: typeof product | null = null;
  if (typeof input.grade_b_product_id === "string" && input.grade_b_product_id) {
    gradeBProduct = await prisma.stockProduct.findUnique({ where: { id: input.grade_b_product_id } });
    if (!gradeBProduct) throw new ApiError(400, "المنتج المحدد للفرزة مش موجود");
    if (!gradeBProduct.stockTracked) throw new ApiError(400, "المنتج المحدد للفرزة مش متتبع مخزنيًا");
  }
  // A product the business has said it does not hold stock for must not acquire a
  // balance by the side door. The flag is the statement; this is it being enforced.
  if (!product.stockTracked) {
    throw new ApiError(400, `"${product.name}" مش صنف بيتتبع مخزونه — مينفعش يتسجل عليه استلام`);
  }

  // Counted in packages: convert to the base unit through THIS product's packaging.
  let receivedRaw = input.received_qty ?? input.received_kg;
  let entered: { qty: Dec; uom: string } | null = null;
  if (input.entered_qty !== undefined && input.entered_qty !== null && input.entered_qty !== "") {
    if (typeof input.entered_uom !== "string" || !input.entered_uom) throw new ApiError(400, "حدد وحدة الكمية المعدودة");
    const qty = parseQty(input.entered_qty, "الكمية المعدودة");
    receivedRaw = (await toBaseQuantity(prisma, product, qty, input.entered_uom)).toFixed();
    entered = { qty, uom: input.entered_uom };
  }
  const { received, rejected, gradeB, waste, good } = receivedNumbers(receivedRaw, input.rejected_qty ?? input.rejected_kg, input.grade_b_qty, input.waste_qty);

  // --- grading cost allocation (policy-gated; proportional by default) ---
  const gradingPolicy: GradingCostPolicy = await getSetting("inventory.grading_cost_policy");
  const wasteLossPolicy: WasteLossPolicy = await getSetting("inventory.grading_waste_loss");
  const priceProds: { id: string; unit: string; name: string }[] = [];
  if (received.gt(0) && gradingPolicy === "nrv") {
    if (good.gt(0)) priceProds.push({ id: product.id, unit: product.unit, name: product.name });
    if (gradeBProduct) priceProds.push({ id: gradeBProduct.id, unit: gradeBProduct.unit, name: gradeBProduct.name });
  }
  const prices: (Prisma.Decimal | null)[] = priceProds.length ? await gradingPrices(prisma, priceProds, receivedDate) : [];
  // Unknown cost (received without a price): grading allocation is moot — the
  // movements stay null-cost and the unknown-cost reporting path keeps working.
  const gc =
    unitCost == null
      ? { goodUnitCost: null as Dec | null, gradeBUnitCost: null as Dec | null, wasteUnitCost: null as Dec | null, wasteLoss: D(0), costBasis: "proportional" as const, fallbackReason: null, allocatedInput: D(0) }
      : computeGradingCosts({
          inputQty: received, inputUnitCost: unitCost,
          goodQty: good, gradeBQty: gradeB, wasteQty: waste,
          goodPrice: prices.length > 0 ? prices[0] : null,
          gradeBPrice: prices.length > 1 ? prices[1] : null,
          policy: gradingPolicy, wastePolicy: wasteLossPolicy,
        });
  if (gc.costBasis === "nrv_fallback_proportional" && gradingPolicy === "nrv" && (await getSetting("inventory.grading_price_missing")) === "refuse") {
    throw new ApiError(400, "سعر المخرجات غير متاح — حدد أسعار المنتجات في قائمة الأسعار الأول");
  }
  const fallbackReason = gc.costBasis === "nrv_fallback_proportional" ? gc.fallbackReason : null;
  // --- end grading cost allocation ---
  const expiryDate =
    input.expiry_date || (product.shelfLifeDays ? addDays(receivedDate, product.shelfLifeDays) : null);
  if (expiryDate && expiryDate < receivedDate) throw new ApiError(400, "تاريخ الصلاحية قبل تاريخ الاستلام");

  const prefix = receiptPrefix(receivedDate);

  // Receipt, lot, ledger entry, valuation and audit are written together or not at
  // all: a receipt without its movement would understate stock, and a movement
  // without its receipt would be unexplainable.
  const result = await inTx(async (tx) => {
    // The client key first: a concurrent duplicate waits here, then finds the receipt
    // the first request committed and returns it — no second stock posting.
    if (key) {
      await advisoryXactLock(tx, `stock-intake-key:${key}`);
      const prev = await tx.stockIntake.findUnique({ where: { idempotencyKey: key }, include: INTAKE_INCLUDE });
      if (prev) return { intake: sameIntake(prev, { supplierId: supplier.id, productId: product.id, purchaseOrderLineId: poLine?.id ?? null, received, rejected }), replayed: true };
    }
    // The order first (lock, still receivable, within tolerance), then the receipt.
    if (poLine) await guardPoReceipt(tx, { lineId: poLine.id, good, tolerancePct });
    const warehouse = await resolveWarehouse(tx, input.warehouse_id ?? poLine?.po.warehouseId);
    const location = await resolveLocation(tx, warehouse.id, input.location_id);
    await advisoryXactLock(tx, `stock-receipt:${prefix}`);
    const receiptNumber = await nextReceiptNumber(tx, prefix);

    // Only what survived sorting enters stock — and only stock gets a lot. The
    // rejected quantity stays on the receipt as the record of what was thrown away.
    // A lot exists whenever any main-product stock enters (good, waste, or legacy
    // Grade B): a waste-only / Grade-B-only receipt must still carry a lot, or the
    // movements below dereference null.
    const lot = good.gt(0) || waste.gt(0) || (gradeB.gt(0) && !gradeBProduct)
      ? await tx.stockLot.create({
          data: {
            productId: product.id,
            lotNumber: await nextDocumentNumber(tx, "inventory.lot", receivedDate),
            receivedDate,
            expiryDate,
            supplierId: supplier.id,
            unitCost: good.gt(0) ? gc.goodUnitCost : gc.wasteUnitCost,
          },
        })
      : null;

    const created = await tx.stockIntake.create({
      data: {
        receiptNumber,
        idempotencyKey: key,
        receivedDate,
        supplierId: supplier.id,
        productId: product.id,
        receivedQty: received,
        gradeBQty: gradeB,
        wasteQty: waste,
        rejectedQty: rejected,
        goodQty: good,
        gradeBProductId: gradeBProduct?.id ?? null,
        enteredQty: entered?.qty ?? null,
        enteredUom: entered?.uom ?? null,
        unitCost,
        crateCount,
        warehouseId: warehouse.id,
        locationId: location.id,
        lotId: lot?.id ?? null,
        notes: asText(input.notes, "notes")?.trim() || null,
        purchaseOrderLineId: poLine?.id ?? null,
        rejectionReason: rejected.gt(0) ? asText(input.rejection_reason, "rejection_reason")?.trim() || null : null,
        recordedById: actor.id,
        recordedBy: actor.name,
      },
      include: INTAKE_INCLUDE,
    });

    const movements: MoveInput[] = [];
    if (good.gt(0)) {
      movements.push({
        productId: product.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        lotId: lot!.id,
        quantity: good,
        kind: "intake",
        intakeId: created.id,
        unitCost: gc.goodUnitCost,
        costSource: "purchase",
      });
    }
    if (gradeB.gt(0)) {
      // Grade B enters stock at the allocated unit cost (proportionally by weight
      // under the default policy; by relative NRV when that policy is activated).
      // When gradeBProductId is set, Grade B becomes a separate product with its
      // own inventory identity, pricing, and margin tracking — it needs its own lot.
      let gradeBLot: typeof lot | null = null;
      if (gradeBProduct) {
        gradeBLot = await tx.stockLot.create({
          data: {
            productId: gradeBProduct.id,
            lotNumber: await nextDocumentNumber(tx, "inventory.lot", receivedDate),
            receivedDate,
            expiryDate,
            supplierId: supplier.id,
            unitCost: gc.gradeBUnitCost,
          },
        });
      }
      movements.push({
        productId: gradeBProduct?.id ?? product.id,
        warehouseId: warehouse.id,
        locationId: gradeBProduct ? location.id : "loc_grade_b",
        lotId: gradeBProduct ? gradeBLot!.id : lot!.id,
        quantity: gradeB,
        kind: "intake",
        intakeId: created.id,
        unitCost: gc.gradeBUnitCost,
        costSource: "purchase",
      });
    }
    if (waste.gt(0)) {
      // Waste is sent to the waste location at the purchase cost, tracked by
      // the same lot. It stays there as a stock record until a separate
      // adjustment or count writes it off through the standard scrap/ adjustment
      // workflow — the ledger and the GL see the full cost at intake, so GRNI
      // clears correctly when the supplier bill arrives. The waste location's
      // balance is the inventory value awaiting write-off; periodic counts
      // trigger the write-off through the existing adjustment-approval path.
      movements.push({
        productId: product.id,
        warehouseId: warehouse.id,
        locationId: "loc_waste",
        lotId: lot!.id,
        quantity: waste,
        kind: "intake",
        intakeId: created.id,
        unitCost: gc.wasteUnitCost,
        costSource: "purchase",
      });
    }
    if (movements.length > 0) {
      await postMovements(tx, movements, { actorId: actor.id, actorName: actor.name, effectiveDate: receivedDate });
    }
    // NRV grading with waste "expensed at grading": the waste enters stock at no cost, so the
    // movements put only the allocable value into GRNI. The loss is the rest of what the
    // supplier is owed for: Dr inventory adjustments / Cr GRNI, in the same transaction, so
    // GRNI holds the full purchase value and clears when the bill arrives.
    if (gc.wasteLoss.gt(0)) {
      const p = await tx.accountingPeriod.findUnique({ where: { code: receivedDate.slice(0, 7) }, select: { status: true } });
      await postJournal(tx, {
        date: p?.status === "closed" ? todayLocalISO() : receivedDate,
        description: `هالك الفرز عند الاستلام ${created.receiptNumber} (${waste.toFixed()} ${product.unit})`,
        sourceType: "stock_valuation", sourceId: `intake-waste|${created.id}`,
        lines: [{ key: "inventory_adjustment", amount: gc.wasteLoss, description: "هالك الفرز" }, { key: "grni", amount: gc.wasteLoss.negated(), description: "هالك الفرز" }],
      }, { id: actor.id, name: actor.name, role: actor.role });
    }

    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "stock_intake_created",
        entityType: "stock_intake",
        entityId: created.id,
        newValue: `${created.receiptNumber} · ${product.name} · ${received.toFixed()} ${product.unit}${lot ? ` · ${lot.lotNumber}` : ""} · ${location.code}${poLine ? ` · ${poLine.po.number}` : ""}`,
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    // inventory.grading_price_missing = "fallback" promises the reason is recorded — the same
    // row the post-receipt sort writes (lib/inventory/documents.ts), never a silent switch.
    if (fallbackReason) {
      await writeAudit({
        userId: actor.id, userName: actor.name, role: actor.role, action: "grading_cost_fallback",
        entityType: "stock_intake", entityId: created.id, fieldChanged: "costBasis", oldValue: "nrv",
        newValue: `proportional · ${fallbackReason}`, source: "user", deviceId: actor.deviceId, reason: "سعر المخرجات غير متاح — اتروزعت التكلفة بالتناسب",
      }, tx);
    }
    if (poLine) await afterPoReceipt(tx, poLine.poId, actor);
    return { intake: created, replayed: false };
  });

  return { intake: serializeIntake(result.intake), replayed: result.replayed };
}

export async function getIntake(id: string) {
  const intake = await prisma.stockIntake.findUnique({ where: { id }, include: INTAKE_INCLUDE });
  if (!intake) throw new ApiError(404, "الاستلام مش موجود");
  return serializeIntake(intake);
}

export async function listIntakes(filters: {
  date?: string;
  from?: string;
  to?: string;
  supplierId?: string;
  productId?: string;
  includeVoided?: boolean;
  limit?: number;
}) {
  const where: Prisma.StockIntakeWhereInput = {
    supplierId: filters.supplierId,
    productId: filters.productId,
    ...(filters.includeVoided ? {} : { status: "posted" }),
  };
  if (filters.date) where.receivedDate = filters.date;
  else if (filters.from || filters.to) {
    where.receivedDate = { gte: filters.from, lte: filters.to };
  }

  const rows = await prisma.stockIntake.findMany({
    where,
    include: INTAKE_INCLUDE,
    orderBy: [{ receivedDate: "desc" }, { createdAt: "desc" }],
    take: Math.min(filters.limit ?? 200, 500),
  });
  return rows.map(serializeIntake);
}

/** What a receipt still has in its own bucket, and at what cost it entered. */
function intakeBucket(row: { productId: string; warehouseId: string; locationId: string; lotId: string | null; unitCost: Prisma.Decimal | null }) {
  return { productId: row.productId, warehouseId: row.warehouseId, locationId: row.locationId, lotId: row.lotId };
}

/**
 * Correct a posted receipt.
 *
 * The ledger is never rewritten. Whatever the correction does to good output is
 * posted as an `intake_correction` for the delta only, in the receipt's own bucket
 * (its location and lot), so the running balance ends up where the corrected receipt
 * says it should be, while the original entry — and the fact that it was corrected —
 * both stay on the record. A downward correction is refused if that stock has
 * already left the bucket (moved, issued or scrapped): the ledger decides, not the form.
 */
export async function updateIntake(
  id: string,
  fields: Partial<{
    received_kg: unknown;
    rejected_kg: unknown;
    crate_count: number | null;
    notes: string;
    received_date: string;
  }>,
  actor: StockActor,
  reason: string,
  expectedVersion?: number
) {
  if (!asText(reason, "reason")?.trim()) throw new ApiError(400, "لازم تكتب سبب التعديل");
  const existing = await prisma.stockIntake.findUnique({ where: { id }, include: INTAKE_INCLUDE });
  if (!existing) throw new ApiError(404, "الاستلام مش موجود");
  if (existing.status !== "posted") throw new ApiError(400, "الاستلام ده ملغي، مينفعش يتعدل");
  assertVersion(existing.version, expectedVersion, "الاستلام");

  const crateCount =
    fields.crate_count === undefined ? existing.crateCount : fields.crate_count == null ? null : Number(fields.crate_count);
  validateCrates(crateCount);
  const receivedDate = fields.received_date ?? existing.receivedDate;
  assertDate(receivedDate, "تاريخ الاستلام");
  const { received, rejected, good } = receivedNumbers(
    fields.received_kg ?? existing.receivedQty.toFixed(),
    fields.rejected_kg ?? existing.rejectedQty.toFixed()
  );
  const notes = fields.notes === undefined ? existing.notes : fields.notes.trim() || null;

  const changes: [string, string | null, string | null][] = [];
  if (!received.equals(existing.receivedQty)) changes.push(["receivedQty", existing.receivedQty.toFixed(), received.toFixed()]);
  if (!rejected.equals(existing.rejectedQty)) changes.push(["rejectedQty", existing.rejectedQty.toFixed(), rejected.toFixed()]);
  if (!good.equals(existing.goodQty)) changes.push(["goodQty", existing.goodQty.toFixed(), good.toFixed()]);
  if (crateCount !== existing.crateCount)
    changes.push(["crateCount", existing.crateCount?.toString() ?? null, crateCount?.toString() ?? null]);
  if (receivedDate !== existing.receivedDate) changes.push(["receivedDate", existing.receivedDate, receivedDate]);
  if (notes !== existing.notes) changes.push(["notes", existing.notes, notes]);
  if (changes.length === 0) return serializeIntake(existing);

  const delta = good.minus(existing.goodQty);
  const tolerancePct = existing.purchaseOrderLineId ? await getSetting("purchasing.over_receipt_tolerance_pct") : 0;

  const notesOnly = changes.every(([field]) => field === "notes");

  const updated = await inTx(async (tx) => {
    if (!notesOnly) await lockUnbilledReceipt(tx, id);
    // A correction against a PO is held to the same tolerance as the receipt was.
    const po = existing.purchaseOrderLineId ? await guardPoReceipt(tx, { lineId: existing.purchaseOrderLineId, good, tolerancePct, excludeIntakeId: id }) : null;
    // A fully rejected receipt never got a lot; correcting it upward gives it one now.
    let lotId = existing.lotId;
    if (delta.gt(0) && !lotId && !existing.goodQty.gt(0)) {
      const lot = await tx.stockLot.create({
        data: {
          productId: existing.productId,
          lotNumber: await nextDocumentNumber(tx, "inventory.lot", existing.receivedDate),
          receivedDate: existing.receivedDate,
          supplierId: existing.supplierId,
          unitCost: existing.unitCost,
        },
      });
      lotId = lot.id;
    }
    let result;
    try {
      result = await tx.stockIntake.update({
        where: { id, version: existing.version, status: "posted" },
        data: {
          receivedQty: received,
          rejectedQty: rejected,
          goodQty: good,
          crateCount,
          receivedDate,
          notes,
          lotId,
          version: { increment: 1 },
        },
        include: INTAKE_INCLUDE,
      });
    } catch (err) {
      if (isNoRowMatched(err)) versionConflict("الاستلام", existing.version);
      throw err;
    }

    if (!delta.isZero()) {
      await postMovements(
        tx,
        [
          {
            ...intakeBucket({ ...existing, lotId }),
            quantity: delta,
            kind: "intake_correction",
            intakeId: id,
            reason: reason.trim(),
            // In or out of the receipt at the receipt's own price, when it has one.
            unitCost: existing.unitCost,
            costSource: existing.unitCost == null ? undefined : "lot",
          },
        ],
        { actorId: actor.id, actorName: actor.name, effectiveDate: receivedDate }
      );
    }

    await writeAuditMany(
      changes.map(([field, oldValue, newValue]) => ({
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "stock_intake_updated",
        entityType: "stock_intake" as const,
        entityId: id,
        fieldChanged: field,
        oldValue,
        newValue,
        reason: reason.trim(),
        source: "user" as const,
        deviceId: actor.deviceId,
      })),
      tx
    );
    if (po) await afterPoReceipt(tx, po.po.id, actor);
    return result;
  });

  return serializeIntake(updated);
}

/**
 * Void a receipt entered in error. Nothing is deleted: the receipt is marked voided
 * and a compensating `intake_void` reverses exactly what it had added, from its own
 * bucket — refused if that stock is no longer there to take back.
 */
export async function voidIntake(id: string, actor: StockActor, reason: string, expectedVersion?: number) {
  if (!asText(reason, "reason")?.trim()) throw new ApiError(400, "لازم تكتب سبب الإلغاء");
  const existing = await prisma.stockIntake.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "الاستلام مش موجود");
  if (existing.status === "voided") throw new ApiError(400, "الاستلام ملغي بالفعل");
  assertVersion(existing.version, expectedVersion, "الاستلام");

  const voided = await inTx(async (tx) => {
    await lockUnbilledReceipt(tx, id);
    const poId = existing.purchaseOrderLineId ? await lockPoForReceipt(tx, existing.purchaseOrderLineId) : null;
    let result;
    try {
      result = await tx.stockIntake.update({
        where: { id, version: existing.version, status: "posted" },
        data: { status: "voided", version: { increment: 1 } },
        include: INTAKE_INCLUDE,
      });
    } catch (err) {
      if (isNoRowMatched(err)) versionConflict("الاستلام", existing.version);
      throw err;
    }

    // Reverse the receipt's own net effect, read from the ledger rather than
    // recomputed from the receipt — if it was corrected along the way, the sum of
    // its movements is the only accurate statement of what it actually contributed.
    const net = await tx.stockMovement.aggregate({ where: { intakeId: id }, _sum: { quantity: true } });
    const contributed = D(net._sum.quantity);
    if (!contributed.isZero()) {
      await postMovements(
        tx,
        [
          {
            ...intakeBucket(existing),
            quantity: contributed.negated(),
            kind: "intake_void",
            intakeId: id,
            reason: reason.trim(),
            unitCost: existing.unitCost,
            costSource: existing.unitCost == null ? undefined : "lot",
          },
        ],
        { actorId: actor.id, actorName: actor.name, effectiveDate: existing.receivedDate }
      );
    }

    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "stock_intake_voided",
        entityType: "stock_intake",
        entityId: id,
        fieldChanged: "status",
        oldValue: "posted",
        newValue: "voided",
        reason: reason.trim(),
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    // The order's received status follows its receipts.
    if (poId) await afterPoReceipt(tx, poId, actor);
    return result;
  });

  return serializeIntake(voided);
}

// ---------------------------------------------------------------------------
// Manual adjustment (the original one-product form)
// ---------------------------------------------------------------------------

/**
 * The stock screen's quick adjustment. It is an inventory adjustment document with
 * one line: an increase lands in the receiving bay, a decrease is picked FEFO across
 * the warehouse, and above the configured threshold it waits for approval. Returns a
 * movement-shaped summary so the original screen keeps working.
 */
export async function createAdjustment(
  input: { product_id: string; quantity_kg: unknown; effective_date?: string; reason: string; idempotency_key?: string },
  actor: StockActor
) {
  const { document } = await createAdjustmentDocument(
    {
      reason: input.reason,
      business_date: input.effective_date,
      idempotency_key: input.idempotency_key,
      lines: [{ product_id: input.product_id, quantity: input.quantity_kg }],
    },
    actor
  );
  const product = await prisma.stockProduct.findUnique({ where: { id: input.product_id }, select: { id: true, name: true, unit: true } });
  const total = document.movements.reduce((s, m) => s.plus(D(m.quantity)), D(0));
  return {
    pendingApproval: document.status === "pending_approval",
    document: { id: document.id, number: document.number, status: document.status },
    movement: {
      id: document.movements[0]?.id ?? null,
      productId: input.product_id,
      kind: "adjustment" as const,
      quantity: total.toFixed(),
      quantityKg: num(total),
      effectiveDate: document.businessDate,
      reason: document.reason,
      product,
      lines: document.movements.map((m) => ({ location: m.location.code, lot: m.lot?.lotNumber ?? null, quantity: D(m.quantity).toFixed() })),
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger reads
// ---------------------------------------------------------------------------

export async function listMovements(filters: { productId?: string; from?: string; to?: string; limit?: number }) {
  const where: Prisma.StockMovementWhereInput = { productId: filters.productId };
  if (filters.from || filters.to) where.effectiveDate = { gte: filters.from, lte: filters.to };
  const rows = await prisma.stockMovement.findMany({
    where,
    include: MOVEMENT_INCLUDE,
    orderBy: { occurredAt: "desc" },
    take: Math.min(filters.limit ?? 50, 500),
  });
  return rows.map(serializeMovement);
}

/** Current stock per product, straight from the ledger. No stored balance exists. */
export async function currentStock() {
  const [products, sums] = await Promise.all([
    prisma.stockProduct.findMany({ orderBy: { name: "asc" } }),
    prisma.stockMovement.groupBy({ by: ["productId"], _sum: { quantity: true } }),
  ]);
  const byProduct = new Map(sums.map((s) => [s.productId, D(s._sum.quantity)]));
  return products
    .map((p) => {
      const balance = byProduct.get(p.id) ?? D(0);
      return {
        productId: p.id,
        productName: p.name,
        productNameAr: p.nameAr,
        unit: p.unit,
        active: p.active,
        balance: balance.toFixed(),
        balanceKg: num(balance),
      };
    })
    .filter((p) => p.active || p.balanceKg !== 0)
    .sort((a, b) => b.balanceKg - a.balanceKg || a.productName.localeCompare(b.productName, "ar"));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type PeriodTotals = {
  from: string;
  to: string;
  receivedKg: number;
  rejectedKg: number;
  goodKg: number;
  crates: number;
  yieldPct: number | null;
  intakeCount: number;
};

/** Totals are summed by the database over posted receipts only — a voided receipt
 * never happened as far as the day's production numbers are concerned. */
async function totalsBetween(from: string, to: string): Promise<PeriodTotals> {
  const agg = await prisma.stockIntake.aggregate({
    where: { status: "posted", receivedDate: { gte: from, lte: to } },
    _sum: { receivedQty: true, rejectedQty: true, goodQty: true, crateCount: true },
    _count: { _all: true },
  });
  const receivedKg = num(agg._sum.receivedQty);
  const goodKg = num(agg._sum.goodQty);
  return {
    from,
    to,
    receivedKg,
    rejectedKg: num(agg._sum.rejectedQty),
    goodKg,
    crates: agg._sum.crateCount ?? 0,
    yieldPct: yieldPct(receivedKg, goodKg),
    intakeCount: agg._count._all,
  };
}

/** Calendar-day arithmetic on the YYYY-MM-DD strings the receipts are keyed by. Done
 * in UTC deliberately: these are plain dates, not instants, so shifting them through a
 * local timezone is what introduces off-by-one-day errors, not what prevents them. */
export function shiftDate(dateISO: string, days: number) {
  return addDays(dateISO, days);
}

export function startOfMonth(dateISO: string) {
  return `${dateISO.slice(0, 7)}-01`;
}

export type SupplierPerformance = {
  supplierId: string;
  supplierName: string;
  supplierNameAr: string | null;
  intakeCount: number;
  receivedKg: number;
  rejectedKg: number;
  goodKg: number;
  yieldPct: number | null;
  lastDeliveryDate: string | null;
};

/**
 * Supplier performance over a window, built only from receipts that were actually
 * recorded. No scoring, no ranking bonus, no estimated figures: a supplier with two
 * deliveries shows two deliveries, and one with none does not appear at all.
 */
export async function supplierPerformance(from: string, to: string): Promise<SupplierPerformance[]> {
  const [grouped, suppliers] = await Promise.all([
    prisma.stockIntake.groupBy({
      by: ["supplierId"],
      where: { status: "posted", receivedDate: { gte: from, lte: to } },
      _sum: { receivedQty: true, rejectedQty: true, goodQty: true },
      _count: { _all: true },
      _max: { receivedDate: true },
    }),
    prisma.supplier.findMany({ select: { id: true, name: true, nameAr: true } }),
  ]);
  const nameById = new Map(suppliers.map((s) => [s.id, s.name]));
  const nameArById = new Map(suppliers.map((s) => [s.id, s.nameAr]));
  return grouped
    .map((g) => {
      const receivedKg = num(g._sum.receivedQty);
      const goodKg = num(g._sum.goodQty);
      return {
        supplierId: g.supplierId,
        supplierName: nameById.get(g.supplierId) ?? "—",
        supplierNameAr: nameArById.get(g.supplierId) ?? null,
        intakeCount: g._count._all,
        receivedKg,
        rejectedKg: num(g._sum.rejectedQty),
        goodKg,
        yieldPct: yieldPct(receivedKg, goodKg),
        lastDeliveryDate: g._max.receivedDate ?? null,
      };
    })
    .sort((a, b) => b.receivedKg - a.receivedKg);
}

/** Per-product breakdown of one window — what the day's entry screen summarises. */
export async function productTotals(from: string, to: string) {
  const [grouped, products] = await Promise.all([
    prisma.stockIntake.groupBy({
      by: ["productId"],
      where: { status: "posted", receivedDate: { gte: from, lte: to } },
      _sum: { receivedQty: true, rejectedQty: true, goodQty: true },
      _count: { _all: true },
    }),
    prisma.stockProduct.findMany({ select: { id: true, name: true, nameAr: true, unit: true } }),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  return grouped
    .map((g) => {
      const receivedKg = num(g._sum.receivedQty);
      const goodKg = num(g._sum.goodQty);
      return {
        productId: g.productId,
        productName: byId.get(g.productId)?.name ?? "—",
        productNameAr: byId.get(g.productId)?.nameAr ?? null,
        unit: byId.get(g.productId)?.unit ?? "KG",
        intakeCount: g._count._all,
        receivedKg,
        rejectedKg: num(g._sum.rejectedQty),
        goodKg,
        yieldPct: yieldPct(receivedKg, goodKg),
      };
    })
    .sort((a, b) => b.receivedKg - a.receivedKg);
}

/**
 * Everything the dashboard needs, in one round trip — the same pattern the supervisor
 * Command Center uses, so opening the stock screen is one request rather than seven
 * polling in parallel from a tablet on site wifi.
 */
export async function stockDashboard(todayISO = todayLocalISO()) {
  const weekFrom = shiftDate(todayISO, -6); // rolling 7 days, today inclusive
  const monthFrom = startOfMonth(todayISO);

  const [today, week, month, stock, movements, suppliers, todayByProduct, todayIntakes] = await Promise.all([
    totalsBetween(todayISO, todayISO),
    totalsBetween(weekFrom, todayISO),
    totalsBetween(monthFrom, todayISO),
    currentStock(),
    listMovements({ limit: 20 }),
    supplierPerformance(monthFrom, todayISO),
    productTotals(todayISO, todayISO),
    listIntakes({ date: todayISO, limit: 50 }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    date: todayISO,
    today,
    week,
    month,
    currentStock: stock,
    totalStockKg: num(stock.reduce((sum, p) => sum.plus(D(p.balance)), D(0))),
    recentMovements: movements,
    supplierPerformance: suppliers,
    todayByProduct,
    todayIntakes,
  };
}
