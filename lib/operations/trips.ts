import { Prisma, type Trip } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { active, optText, parse, text, version } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { moveOrderStatus } from "@/lib/orders-service";
import { postCustomerReturnInTx } from "@/lib/inventory/documents";
import { preloadedUnits, toBaseQuantity } from "@/lib/inventory/packaging";
import { raiseException, raiseExceptions } from "@/lib/operations/exceptions";
import { isoDate } from "@/lib/purchasing/orders";
import { isValidISODate } from "@/lib/dates";
import { searchWhere } from "@/lib/core/search";

/**
 * Trips: a vehicle, a driver and the orders it carries, in delivery sequence.
 *
 *   planned ──start loading──▶ loading ──confirm loaded──▶ loaded ──dispatch──▶ dispatched
 *     ──depart──▶ in_transit ──every stop has a result──▶ completed        (cancel: before dispatch)
 *
 * A trip owns no quantities. Each order moves through its own existing workflow
 * (moveOrderStatus): loading starts and finishes per order, and dispatching the trip
 * dispatches each order — which issues its stock exactly as before. The trip only
 * refuses what must not happen: an order on two trips (DB-enforced), loading an order
 * that is not ready, leaving with an order that is not loaded, dispatching an order on
 * a trip from anywhere but the trip.
 *
 * The delivery result (POD) of a stop is recorded once (idempotent): per line what was
 * delivered, short, damaged or rejected. Rejected goods — everything, when the
 * delivery failed — come back into stock through a customer-return document in the
 * same transaction; damaged and short goods already left with the dispatch issue and
 * are not moved again. Every non-delivered quantity raises an operational exception,
 * and the order is invoiced on what was delivered.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const asOrderActor = (a: ServiceActor) => ({ ...a, source: "user" as const });
const auditTrip = (tx: Tx | typeof prisma, actor: ServiceActor, entityType: "trip" | "vehicle" | "driver", id: string, action: string, detail: string | null, reason?: string | null, orderId?: string | null) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType, entityId: id, orderId: orderId ?? null, newValue: detail, reason: reason ?? undefined, source: "user", deviceId: actor.deviceId }, tx as Tx);

// ---------------------------------------------------------------------------
// Fleet (minimum): vehicles and drivers
// ---------------------------------------------------------------------------

const vehicleInput = z.object({
  code: text("كود العربية", 30),
  plate: text("رقم اللوحة", 30),
  type: z.enum(["van", "truck", "pickup", "other"]).optional(),
  capacity_kg: z.union([z.number().positive(), z.null()]).optional(),
  refrigerated: z.boolean().optional(),
  active: active().optional(),
  expected_version: version,
});
const driverInput = z.object({ name: text("اسم السواق", 100), phone: optText("التليفون", 30).optional(), active: active().optional(), expected_version: version });

function uniqueClash(err: unknown, msg: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ApiError(409, msg);
  throw err;
}

export async function saveVehicle(id: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "operations.trips.manage");
  const v = parse(vehicleInput, input);
  const data = { code: v.code, plate: v.plate, type: v.type ?? "truck", capacityKg: v.capacity_kg ?? null, refrigerated: v.refrigerated ?? false, ...(v.active !== undefined ? { active: v.active } : {}) };
  return inTx(async (tx) => {
    let row;
    try {
      if (id) {
        const cur = await tx.vehicle.findUnique({ where: { id } });
        if (!cur) throw new ApiError(404, "العربية مش موجودة");
        if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "اتعدلت من حد تاني — حدّث الصفحة");
        row = await tx.vehicle.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      } else row = await tx.vehicle.create({ data });
    } catch (err) {
      uniqueClash(err, "الكود أو رقم اللوحة متسجل لعربية تانية");
    }
    await auditTrip(tx, actor, "vehicle", row.id, id ? "vehicle_updated" : "vehicle_created", `${row.code} · ${row.plate}${row.refrigerated ? " · مبردة" : ""}${row.active ? "" : " · موقوفة"}`);
    return row;
  });
}

export async function saveDriver(id: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "operations.trips.manage");
  const v = parse(driverInput, input);
  return inTx(async (tx) => {
    let row;
    if (id) {
      const cur = await tx.driver.findUnique({ where: { id } });
      if (!cur) throw new ApiError(404, "السواق مش موجود");
      if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "اتعدل من حد تاني — حدّث الصفحة");
      row = await tx.driver.update({ where: { id }, data: { name: v.name, phone: v.phone ?? null, ...(v.active !== undefined ? { active: v.active } : {}), version: { increment: 1 } } });
    } else row = await tx.driver.create({ data: { name: v.name, phone: v.phone ?? null } });
    await auditTrip(tx, actor, "driver", row.id, id ? "driver_updated" : "driver_created", `${row.name}${row.active ? "" : " · موقوف"}`);
    return row;
  });
}

export const listFleet = async () => ({
  vehicles: (await prisma.vehicle.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }] })).map((v) => ({ ...v, capacityKg: v.capacityKg?.toString() ?? null })),
  drivers: await prisma.driver.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const shippedQty = (i: { loadedQuantity: number | null; preparedQuantity: number | null; requiredQuantity: number }) => D(String(i.loadedQuantity ?? i.preparedQuantity ?? i.requiredQuantity)).toDecimalPlaces(3);

async function lockTrip(tx: Tx, id: string) {
  await advisoryXactLock(tx, `operations:trip:${id}`);
  const trip = await tx.trip.findUnique({ where: { id }, include: { vehicle: true, driver: true, stops: { where: { active: true }, orderBy: { sequence: "asc" }, include: { order: { include: { items: true } } } } } });
  if (!trip) throw new ApiError(404, "الرحلة مش موجودة");
  return trip;
}

async function transition(tx: Tx, trip: Trip, data: Prisma.TripUpdateInput) {
  try {
    return await tx.trip.update({ where: { id: trip.id, version: trip.version }, data: { ...data, version: { increment: 1 } } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") throw new ApiError(409, "الرحلة اتعدلت من حد تاني — حدّث الصفحة");
    throw err;
  }
}

/** Orders may be planned onto a trip at any stage before they leave; capacity is checked on their weight in KG. */
async function placeOrders(tx: Tx, tripId: string, orderIds: string[], vehicle: { capacityKg: Prisma.Decimal | null; code: string }) {
  if (new Set(orderIds).size !== orderIds.length) throw new ApiError(400, "نفس الأوردر متكرر في الرحلة");
  const orders = await tx.order.findMany({ where: { id: { in: orderIds } }, include: { items: true } });
  if (orders.length !== orderIds.length) throw new ApiError(404, "أوردر مش موجود");
  for (const o of orders) {
    if (["dispatched", "cancelled"].includes(o.status)) throw new ApiError(409, `الأوردر ${o.orderNumber} ${o.status === "cancelled" ? "ملغي" : "خرج بالفعل"}`);
    const other = await tx.tripStop.findFirst({ where: { orderId: o.id, active: true, tripId: { not: tripId } }, include: { trip: { select: { number: true } } } });
    if (other) throw new ApiError(409, `الأوردر ${o.orderNumber} على الرحلة ${other.trip.number} بالفعل`);
  }
  if (vehicle.capacityKg) {
    const lines = orders.flatMap((o) => o.items);
    let kg = lines.filter((i) => i.unit.toUpperCase() === "KG").reduce((a, i) => a.plus(shippedQty(i)), D(0));
    // A line in another unit of a product kept in KG (a crate of 18 kg, a ton) weighs what it
    // converts to (LOG-8). Lines whose weight is not known (pieces, unmapped) stay out, as before.
    const other = lines.filter((i) => i.unit.toUpperCase() !== "KG" && i.stockProductId);
    const weighed = other.length ? new Map((await tx.stockProduct.findMany({ where: { id: { in: [...new Set(other.map((i) => i.stockProductId!))] }, unit: "KG" }, select: { id: true, name: true, unit: true } })).map((p) => [p.id, p])) : new Map<string, { id: string; name: string; unit: string }>();
    const inKg = other.filter((i) => weighed.has(i.stockProductId!));
    const units = inKg.length ? await preloadedUnits(tx, inKg.map((i) => ({ productId: i.stockProductId!, units: [i.unit, "KG"] }))) : tx;
    for (const i of inKg) {
      try {
        kg = kg.plus(await toBaseQuantity(units, weighed.get(i.stockProductId!)!, shippedQty(i), i.unit));
      } catch (err) {
        if (!(err instanceof ApiError)) throw err; // a unit that does not convert: weight unknown
      }
    }
    if (kg.greaterThan(vehicle.capacityKg)) throw new ApiError(409, `الحمولة ${kg.toFixed()} كجم أكبر من سعة العربية ${vehicle.code} (${vehicle.capacityKg.toFixed()} كجم)`);
  }
  await tx.tripStop.deleteMany({ where: { tripId, status: "pending" } });
  try {
    await tx.tripStop.createMany({ data: orderIds.map((orderId, i) => ({ tripId, orderId, sequence: i + 1 })) });
  } catch (err) {
    uniqueClash(err, "أوردر من دول اتحط على رحلة تانية في نفس اللحظة");
  }
  return orders;
}

const tripInput = z.object({
  trip_date: isoDate("تاريخ الرحلة").optional(),
  vehicle_id: text("العربية"),
  driver_id: text("السواق"),
  order_ids: z.array(z.string()).min(1, "لازم أوردر واحد على الأقل").max(100),
  notes: optText("ملاحظات", 1000).optional(),
  expected_version: version,
});

async function fleetFor(tx: Tx, vehicleId: string, driverId: string) {
  const [vehicle, driver] = await Promise.all([tx.vehicle.findUnique({ where: { id: vehicleId } }), tx.driver.findUnique({ where: { id: driverId } })]);
  if (!vehicle?.active) throw new ApiError(400, "العربية مش موجودة أو موقوفة");
  if (!driver?.active) throw new ApiError(400, "السواق مش موجود أو موقوف");
  return { vehicle, driver };
}

export async function createTrip(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "operations.trips.manage");
  const v = parse(tripInput, input);
  return inTx(async (tx) => {
    const { vehicle, driver } = await fleetFor(tx, v.vehicle_id, v.driver_id);
    const tripDate = v.trip_date ?? todayLocalISO();
    const trip = await tx.trip.create({ data: { number: await nextDocumentNumber(tx, "operations.trip", tripDate), tripDate, vehicleId: vehicle.id, driverId: driver.id, notes: v.notes ?? null, createdById: actor.id, createdBy: actor.name } });
    await advisoryXactLock(tx, `operations:trip:${trip.id}`);
    const orders = await placeOrders(tx, trip.id, v.order_ids, vehicle);
    await auditTrip(tx, actor, "trip", trip.id, "trip_planned", `${trip.number} · ${vehicle.code} · ${driver.name} · ${orders.map((o) => o.orderNumber).join("، ")}`);
    return trip;
  });
}

/** While planned: change the vehicle, driver, orders or their sequence. */
export async function updateTrip(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "operations.trips.manage");
  const v = parse(tripInput, input);
  return inTx(async (tx) => {
    const trip = await lockTrip(tx, id);
    if (trip.status !== "planned") throw new ApiError(409, "الرحلة بدأت تتحمل — مينفعش تتعدل");
    if (v.expected_version !== undefined && v.expected_version !== trip.version) throw new ApiError(409, "الرحلة اتعدلت من حد تاني — حدّث الصفحة");
    const { vehicle, driver } = await fleetFor(tx, v.vehicle_id, v.driver_id);
    const orders = await placeOrders(tx, id, v.order_ids, vehicle);
    const updated = await transition(tx, trip, { tripDate: v.trip_date ?? trip.tripDate, vehicle: { connect: { id: vehicle.id } }, driver: { connect: { id: driver.id } }, notes: v.notes ?? null });
    await auditTrip(tx, actor, "trip", id, "trip_replanned", `${vehicle.code} · ${driver.name} · ${orders.map((o) => o.orderNumber).join("، ")}`);
    return updated;
  });
}

export async function cancelTrip(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "operations.trips.manage");
  const v = parse(z.object({ reason: text("سبب الإلغاء", 500) }), input);
  return inTx(async (tx) => {
    const trip = await lockTrip(tx, id);
    if (!["planned", "loading", "loaded"].includes(trip.status)) throw new ApiError(409, "الرحلة خرجت بالفعل — مينفعش تتلغي");
    // The orders stay where they are in their own workflow, free for another trip.
    await tx.tripStop.updateMany({ where: { tripId: id, active: true }, data: { active: false } });
    const updated = await transition(tx, trip, { status: "cancelled", cancelReason: v.reason });
    await auditTrip(tx, actor, "trip", id, "trip_cancelled", null, v.reason);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Loading and dispatch — each order through its own workflow
// ---------------------------------------------------------------------------

/** Every order must be ready (prepared) before the truck is loaded. */
export async function startLoading(id: string, actor: ServiceActor) {
  assertPermission(actor, "orders.load");
  const trip = await prisma.trip.findUnique({ where: { id }, include: { stops: { where: { active: true }, include: { order: true } } } });
  if (!trip) throw new ApiError(404, "الرحلة مش موجودة");
  if (trip.status !== "planned" && trip.status !== "loading") throw new ApiError(409, "الرحلة مش في مرحلة التحميل");
  const notReady = trip.stops.filter((s) => !["ready_for_loading", "loading", "loaded"].includes(s.order.status));
  if (notReady.length) throw new ApiError(409, `أوردرات لسه مش جاهزة للتحميل: ${notReady.map((s) => s.order.orderNumber).join("، ")}`);
  for (const s of trip.stops) if (s.order.status === "ready_for_loading") await moveOrderStatus(s.orderId, "loading", asOrderActor(actor));
  return inTx(async (tx) => {
    const t = await lockTrip(tx, id);
    if (t.status === "loading") return t;
    const updated = await transition(tx, t, { status: "loading", loadingStartedAt: new Date() });
    await auditTrip(tx, actor, "trip", id, "trip_loading_started", null);
    return updated;
  });
}

/**
 * Every order must be loaded (its lines confirmed by the loaders). A line loaded at a
 * different quantity than was prepared is a loading discrepancy — raised once per line.
 */
export async function confirmLoaded(id: string, actor: ServiceActor) {
  assertPermission(actor, "orders.load");
  const trip = await prisma.trip.findUnique({ where: { id }, include: { stops: { where: { active: true }, include: { order: true } } } });
  if (!trip) throw new ApiError(404, "الرحلة مش موجودة");
  if (trip.status !== "loading") throw new ApiError(409, trip.status === "planned" ? "ابدأ التحميل الأول" : "الرحلة مش في مرحلة التحميل");
  for (const s of trip.stops) if (s.order.status === "loading") await moveOrderStatus(s.orderId, "loaded", asOrderActor(actor));
  return inTx(async (tx) => {
    const t = await lockTrip(tx, id);
    if (t.status === "loaded") return t;
    const notLoaded = t.stops.filter((s) => s.order.status !== "loaded");
    if (notLoaded.length) throw new ApiError(409, `أوردرات لسه متحملتش: ${notLoaded.map((s) => s.order.orderNumber).join("، ")}`);
    // Raised once per line: those this trip already has are read once, the new ones raised together.
    const already = new Set((await tx.operationalException.findMany({ where: { type: "loading_discrepancy", tripId: id }, select: { orderItemId: true } })).map((x) => x.orderItemId));
    const raised: Parameters<typeof raiseExceptions>[1] = [];
    for (const s of t.stops) {
      for (const i of s.order.items) {
        if (i.preparedQuantity == null || i.loadedQuantity == null || i.loadedQuantity === i.preparedQuantity) continue;
        if (already.has(i.id)) continue;
        const diff = D(String(i.loadedQuantity)).minus(String(i.preparedQuantity));
        raised.push({ type: "loading_discrepancy", sourceType: "trip", sourceId: id, tripId: id, orderId: s.orderId, orderItemId: i.id, productName: i.productName, quantity: diff.abs(), description: `${s.order.orderNumber}: اتجهز ${i.preparedQuantity} واتحمل ${i.loadedQuantity} ${i.unit}` });
      }
    }
    await raiseExceptions(tx, raised, actor);
    const updated = await transition(tx, t, { status: "loaded", loadedAt: new Date() });
    await auditTrip(tx, actor, "trip", id, "trip_loaded", `${t.stops.length} أوردر`);
    return updated;
  });
}

/**
 * Dispatches every order of the trip with the trip's vehicle and driver (each order's
 * dispatch issues its stock as always). Resumable: if one order is refused — strict
 * stock policy, say — the others stay dispatched and calling again finishes the rest.
 */
export async function dispatchTrip(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "orders.dispatch");
  const v = parse(z.object({ crates: z.record(z.number().int().positive()).optional() }), input);
  const trip = await prisma.trip.findUnique({ where: { id }, include: { vehicle: true, driver: true, stops: { where: { active: true }, orderBy: { sequence: "asc" }, include: { order: true } } } });
  if (!trip) throw new ApiError(404, "الرحلة مش موجودة");
  if (trip.status !== "loaded") throw new ApiError(409, trip.status === "dispatched" || trip.status === "in_transit" ? "الرحلة خرجت بالفعل" : "الرحلة لازم تكون اتحملت بالكامل الأول");
  for (const s of trip.stops) {
    const crates = v.crates?.[s.orderId] ?? s.order.crateCount ?? undefined;
    if (!crates) throw new ApiError(400, `دخّل عدد البرنيكة للأوردر ${s.order.orderNumber}`);
  }
  for (const s of trip.stops) {
    if (s.order.status === "dispatched") continue;
    const crates = v.crates?.[s.orderId] ?? s.order.crateCount!;
    await moveOrderStatus(s.orderId, "dispatched", asOrderActor(actor), { vehicle: `${trip.vehicle.code} · ${trip.vehicle.plate}`, driverName: trip.driver.name, crateCount: crates, viaTrip: true });
    await prisma.tripStop.update({ where: { id: s.id }, data: { crateCount: crates } });
  }
  return inTx(async (tx) => {
    const t = await lockTrip(tx, id);
    if (t.status !== "loaded") return t;
    const updated = await transition(tx, t, { status: "dispatched", dispatchedAt: new Date() });
    await auditTrip(tx, actor, "trip", id, "trip_dispatched", `${t.vehicle.code} · ${t.driver.name} · ${t.stops.length} أوردر`);
    return updated;
  });
}

export async function departTrip(id: string, actor: ServiceActor) {
  assertPermission(actor, "orders.dispatch");
  return inTx(async (tx) => {
    const t = await lockTrip(tx, id);
    if (t.status === "in_transit") return t;
    if (t.status !== "dispatched") throw new ApiError(409, "الرحلة لازم تكون خرجت الأول");
    const updated = await transition(tx, t, { status: "in_transit", departedAt: new Date() });
    await auditTrip(tx, actor, "trip", id, "trip_departed", null);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Delivery result (POD)
// ---------------------------------------------------------------------------

const qtyField = z.union([z.number(), z.string()]).optional().transform((v, ctx) => {
  if (v === undefined || v === "") return D(0);
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "الكمية لازم تكون رقم موجب بحد أقصى 3 خانات عشرية" });
    return z.NEVER;
  }
  return D(s);
});
const deliveryInput = z.object({
  result: z.enum(["delivered", "failed"]),
  receiver_name: optText("اسم المستلم", 100).optional(),
  customer_notes: optText("ملاحظات العميل", 1000).optional(),
  failure_reason: optText("سبب فشل التسليم", 500).optional(),
  lines: z.array(z.object({ order_item_id: text("الصنف"), shortage_qty: qtyField, damaged_qty: qtyField, rejected_qty: qtyField, reason: optText("السبب", 500).optional() })).max(200).optional(),
});

type Wanted = { itemId: string; shipped: Prisma.Decimal; delivered: Prisma.Decimal; shortage: Prisma.Decimal; damaged: Prisma.Decimal; rejected: Prisma.Decimal; reason: string | null };

export async function recordDelivery(stopId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "orders.dispatch");
  const v = parse(deliveryInput, input);
  if (v.result === "failed" && !v.failure_reason) throw new ApiError(400, "اكتب سبب فشل التسليم");
  if (v.result === "delivered" && !v.receiver_name) throw new ApiError(400, "اكتب اسم اللي استلم");
  if (v.result === "delivered") {
    for (const line of v.lines ?? []) {
      if (line.shortage_qty.gt(0) && !line.reason) throw new ApiError(400, "اكتب سبب العجز في سطر الصنف");
      if (line.damaged_qty.gt(0) && !line.reason) throw new ApiError(400, "اكتب سبب التلف في سطر الصنف");
      if (line.rejected_qty.gt(0) && !line.reason) throw new ApiError(400, "اكتب سبب رفض العميل في سطر الصنف");
    }
  }
  return inTx(async (tx) => {
    const head = await tx.tripStop.findUnique({ where: { id: stopId }, select: { tripId: true } });
    if (!head) throw new ApiError(404, "محطة التسليم مش موجودة");
    const trip = await lockTrip(tx, head.tripId);
    const stop = trip.stops.find((s) => s.id === stopId);
    if (!stop) throw new ApiError(409, "الأوردر اتشال من الرحلة");
    if (!["dispatched", "in_transit", "completed"].includes(trip.status)) throw new ApiError(409, "الرحلة لسه مخرجتش");
    const order = stop.order;

    // What each line should be, from the request.
    const byItem = new Map((v.lines ?? []).map((l) => [l.order_item_id, l]));
    for (const id of byItem.keys()) if (!order.items.some((i) => i.id === id)) throw new ApiError(400, "صنف مش في الأوردر");
    const wanted: Wanted[] = order.items
      .map((i) => {
        const shipped = shippedQty(i);
        const l = byItem.get(i.id);
        if (v.result === "failed") return { itemId: i.id, shipped, delivered: D(0), shortage: D(0), damaged: D(0), rejected: shipped, reason: v.failure_reason ?? null };
        const shortage = l?.shortage_qty ?? D(0), damaged = l?.damaged_qty ?? D(0), rejected = l?.rejected_qty ?? D(0);
        const delivered = shipped.minus(shortage).minus(damaged).minus(rejected);
        if (delivered.lt(0)) throw new ApiError(400, `"${i.productName}": العجز والتالف والمرفوض أكتر من اللي خرج (${shipped.toFixed()} ${i.unit})`);
        return { itemId: i.id, shipped, delivered, shortage, damaged, rejected, reason: l?.reason ?? null };
      })
      .filter((w) => w.shipped.gt(0));

    // Recorded once. The same result again (a retried request) is answered, not repeated.
    if (stop.status !== "pending") {
      const prior = await tx.deliveryLine.findMany({ where: { stopId } });
      const same =
        (stop.status === "failed") === (v.result === "failed") &&
        prior.length === wanted.length &&
        wanted.every((w) => {
          const p = prior.find((x) => x.orderItemId === w.itemId);
          return p && p.deliveredQty.equals(w.delivered) && p.shortageQty.equals(w.shortage) && p.damagedQty.equals(w.damaged) && p.rejectedQty.equals(w.rejected);
        });
      if (!same) throw new ApiError(409, "نتيجة التسليم اتسجلت بالفعل بشكل مختلف — التصحيح من الاستثناءات");
      return { stop: await tx.tripStop.findUniqueOrThrow({ where: { id: stopId } }), replayed: true };
    }

    await tx.deliveryLine.createMany({ data: wanted.map((w) => ({ stopId, orderItemId: w.itemId, shippedQty: w.shipped, deliveredQty: w.delivered, shortageQty: w.shortage, damagedQty: w.damaged, rejectedQty: w.rejected, reason: w.reason })) });

    // Goods that came back go into stock (quarantine) on one return document.
    const items = new Map(order.items.map((i) => [i.id, i]));
    const back = wanted.filter((w) => w.rejected.gt(0));
    const returnable = back.filter((w) => items.get(w.itemId)!.stockProductId);
    let returnDocumentId: string | null = null;
    if (returnable.length) {
      const doc = await postCustomerReturnInTx(
        tx,
        // In the order line's own unit (a crate, a box): the return converts it to the base unit,
        // as the dispatch issue did (PW-10).
        { order_id: order.id, reason: v.result === "failed" ? `فشل تسليم ${trip.number}: ${v.failure_reason}` : `رفض العميل — ${trip.number}`, lines: returnable.map((w) => ({ product_id: items.get(w.itemId)!.stockProductId, quantity: w.rejected.toString(), uom: items.get(w.itemId)!.unit })) },
        actor,
        null,
        undefined,
        { lineLabels: returnable.map((w) => items.get(w.itemId)!.productName) }
      );
      returnDocumentId = doc.id;
    }

    // Everything not delivered is an exception someone has to close.
    const label = (w: Wanted) => `${order.orderNumber} · ${items.get(w.itemId)!.productName}`;
    const unmapped = (w: Wanted) => (items.get(w.itemId)!.stockProductId ? "" : " — الصنف مش مربوط بالمخزون، المرتجع ماتسجلش في المخزون");
    if (v.result === "failed") {
      await raiseException(tx, { type: "delivery_failure", sourceType: "trip_stop", sourceId: stopId, tripId: trip.id, orderId: order.id, description: `${order.orderNumber} · ${order.customerName}: ${v.failure_reason}${back.some((w) => !items.get(w.itemId)!.stockProductId) ? " — فيه أصناف مش مربوطة بالمخزون رجعت" : ""}` }, actor);
    } else {
      const raised: Parameters<typeof raiseExceptions>[1] = [];
      for (const w of wanted) {
        const base = { sourceType: "trip_stop" as const, sourceId: stopId, tripId: trip.id, orderId: order.id, orderItemId: w.itemId, productName: items.get(w.itemId)!.productName };
        if (w.shortage.gt(0)) raised.push({ ...base, type: "shortage", quantity: w.shortage, description: `${label(w)}: عجز ${w.shortage.toFixed()} عند العميل${w.reason ? ` — ${w.reason}` : ""}` });
        if (w.damaged.gt(0)) raised.push({ ...base, type: "damage", quantity: w.damaged, description: `${label(w)}: تالف ${w.damaged.toFixed()}${w.reason ? ` — ${w.reason}` : ""}` });
        if (w.rejected.gt(0)) raised.push({ ...base, type: "rejection", quantity: w.rejected, description: `${label(w)}: العميل رفض ${w.rejected.toFixed()} (رجعت المخزن)${w.reason ? ` — ${w.reason}` : ""}${unmapped(w)}` });
      }
      await raiseExceptions(tx, raised, actor);
    }

    const status = v.result === "failed" ? "failed" : wanted.every((w) => w.delivered.equals(w.shipped)) ? "delivered" : "partial";
    const updated = await tx.tripStop.update({
      where: { id: stopId },
      data: { status, receiverName: v.receiver_name ?? null, customerNotes: v.customer_notes ?? null, failureReason: v.failure_reason ?? null, deliveredAt: new Date(), recordedById: actor.id, recordedBy: actor.name, returnDocumentId },
    });
    await auditTrip(tx, actor, "trip", trip.id, "delivery_recorded", `${order.orderNumber}: ${status}${v.receiver_name ? ` · استلم ${v.receiver_name}` : ""}`, v.failure_reason, order.id);

    // The trip is done when every stop has a result.
    const pending = await tx.tripStop.count({ where: { tripId: trip.id, active: true, status: "pending" } });
    if (pending === 0 && trip.status !== "completed") {
      await transition(tx, trip, { status: "completed", completedAt: new Date() });
      await auditTrip(tx, actor, "trip", trip.id, "trip_completed", null);
    }
    return { stop: updated, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Reads — quantities only; no prices, costs or credit anywhere in a trip.
// ---------------------------------------------------------------------------

export async function listTrips(filters: { status?: string; date?: string; open?: boolean; q?: string; from?: string; to?: string }) {
  const dates = { ...(filters.from && isValidISODate(filters.from) ? { gte: filters.from } : {}), ...(filters.to && isValidISODate(filters.to) ? { lte: filters.to } : {}) };
  const rows = await prisma.trip.findMany({
    // A status and the "open" scope both apply (the open condition used to replace the status one).
    where: {
      ...(await searchWhere("trip", filters.q)),
      ...(filters.date ? { tripDate: filters.date } : Object.keys(dates).length ? { tripDate: dates } : {}),
      AND: [...(filters.status ? [{ status: filters.status }] : []), ...(filters.open ? [{ status: { notIn: ["completed", "cancelled"] } }] : [])],
    },
    orderBy: [{ tripDate: "desc" }, { createdAt: "desc" }],
    include: { vehicle: { select: { code: true, plate: true, refrigerated: true } }, driver: { select: { name: true, phone: true } }, stops: { where: { active: true }, select: { status: true } } },
    take: 200,
  });
  return rows.map((t) => ({ id: t.id, number: t.number, status: t.status, tripDate: t.tripDate, vehicle: t.vehicle, driver: t.driver, stops: t.stops.length, delivered: t.stops.filter((s) => s.status !== "pending").length, version: t.version }));
}

export async function getTrip(id: string) {
  const t = await prisma.trip.findUnique({
    where: { id },
    include: {
      vehicle: true,
      driver: true,
      stops: {
        where: { active: true },
        orderBy: { sequence: "asc" },
        include: { lines: true, order: { select: { id: true, orderNumber: true, customerName: true, customerAccount: { select: { name: true, nameAr: true } }, status: true, deliveryTime: true, crateCount: true, items: { select: { id: true, productName: true, unit: true, requiredQuantity: true, preparedQuantity: true, loadedQuantity: true, stockProductId: true } } } } },
      },
    },
  });
  if (!t) throw new ApiError(404, "الرحلة مش موجودة");
  return {
    ...t,
    vehicle: { ...t.vehicle, capacityKg: t.vehicle.capacityKg?.toString() ?? null },
    stops: t.stops.map((s) => ({
      ...s,
      lines: s.lines.map((l) => ({ orderItemId: l.orderItemId, shippedQty: l.shippedQty.toString(), deliveredQty: l.deliveredQty.toString(), shortageQty: l.shortageQty.toString(), damagedQty: l.damagedQty.toString(), rejectedQty: l.rejectedQty.toString(), reason: l.reason })),
      order: { ...s.order, items: s.order.items.map((i) => ({ ...i, shippedQty: shippedQty(i).toString() })) },
    })),
  };
}

/** Orders that can still go on a trip: not out yet, not on another live trip. */
export async function plannableOrders(date?: string) {
  return prisma.order.findMany({
    // An order waiting for stock is not planned onto a trip until it is released (Nov 2026).
    where: { status: { in: ["new", "preparing", "ready_for_loading", "loading", "loaded"] }, stockStatus: "ok", tripStops: { none: { active: true } }, ...(date ? { deliveryDate: date } : {}) },
    orderBy: [{ deliveryDate: "asc" }, { deliveryTime: "asc" }],
    // The linked card travels with the order: the planner sees the customer as it is now.
    select: { id: true, orderNumber: true, customerName: true, customerAccount: { select: { name: true, nameAr: true } }, status: true, deliveryDate: true, deliveryTime: true },
    take: 300,
  });
}
