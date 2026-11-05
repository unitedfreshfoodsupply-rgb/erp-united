import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { notify } from "@/lib/core/notifications";
import { optText, parse, text, version } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * Operational exceptions — one list for everything that went wrong on the floor or the
 * road: shortage, damage, customer rejection, delivery failure, loading discrepancy.
 * Raised automatically by the delivery result and the loading check, or by hand; each
 * has an owner and is closed with a written resolution. Supervisors (orders.approve)
 * own the list. They carry quantities, never money.
 */

export const EXCEPTION_TYPES = ["shortage", "damage", "rejection", "delivery_failure", "loading_discrepancy"] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

const audit = (tx: Tx, actor: Actorish, id: string, action: string, detail: string | null, orderId?: string | null, reason?: string | null) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "operational_exception", entityId: id, orderId: orderId ?? null, newValue: detail, reason: reason ?? undefined, source: "user", deviceId: actor.deviceId }, tx);

export const TYPE_LABEL: Record<ExceptionType, string> = {
  shortage: "عجز",
  damage: "تالف",
  rejection: "رفض العميل",
  delivery_failure: "فشل التسليم",
  loading_discrepancy: "فرق تحميل",
};

/** Inside the caller's transaction: records it, audits it, tells the supervisors. */
export async function raiseException(
  tx: Tx,
  e: { type: ExceptionType; sourceType: "order" | "trip_stop" | "trip"; sourceId: string; orderId?: string | null; tripId?: string | null; orderItemId?: string | null; productName?: string | null; quantity?: Prisma.Decimal | null; description: string },
  actor: Actorish
) {
  const row = await tx.operationalException.create({
    data: { ...e, orderId: e.orderId ?? null, tripId: e.tripId ?? null, orderItemId: e.orderItemId ?? null, productName: e.productName ?? null, quantity: e.quantity ?? null, createdById: actor.id, createdBy: actor.name },
  });
  await audit(tx, actor, row.id, "exception_raised", `${TYPE_LABEL[e.type]} · ${e.description}`, e.orderId);
  await notify(tx, { permission: "orders.approve", exclude: [actor.id] }, { type: "operations.exception", severity: "warning", title: `${TYPE_LABEL[e.type]}: ${e.productName ?? e.description}`, body: e.description, entityType: "operational_exception", entityId: row.id, link: "/operations?tab=exceptions" });
  return row;
}

const createInput = z.object({
  type: z.enum(EXCEPTION_TYPES),
  order_id: text("الأوردر"),
  order_item_id: z.string().optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
  description: text("الوصف", 1000),
});

/** By hand, from the floor: anyone working an order may report what went wrong with it. */
export async function createException(input: unknown, actor: ServiceActor) {
  if (!["orders.prepare", "orders.load", "orders.dispatch", "orders.approve"].some((p) => actorCan(actor, p as never))) throw new ApiError(403, "مالكش صلاحية");
  const v = parse(createInput, input);
  const order = await prisma.order.findUnique({ where: { id: v.order_id }, include: { items: true } });
  if (!order) throw new ApiError(404, "الأوردر مش موجود");
  const item = v.order_item_id ? order.items.find((i) => i.id === v.order_item_id) : null;
  if (v.order_item_id && !item) throw new ApiError(400, "الصنف مش في الأوردر");
  let quantity: Prisma.Decimal | null = null;
  if (v.quantity !== undefined && v.quantity !== "") {
    quantity = new Prisma.Decimal(String(v.quantity));
    if (!quantity.gt(0)) throw new ApiError(400, "الكمية لازم تكون أكبر من صفر");
  }
  return inTx((tx) => raiseException(tx, { type: v.type, sourceType: "order", sourceId: order.id, orderId: order.id, orderItemId: item?.id, productName: item?.productName, quantity, description: v.description }, actor));
}

export async function listExceptions(filters: { status?: string; type?: string; orderId?: string; tripId?: string }) {
  const rows = await prisma.operationalException.findMany({
    where: { ...(filters.status ? { status: filters.status } : {}), ...(filters.type ? { type: filters.type } : {}), ...(filters.orderId ? { orderId: filters.orderId } : {}), ...(filters.tripId ? { tripId: filters.tripId } : {}) },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 300,
  });
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))];
  const orders = new Map((await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, customerName: true, customerAccount: { select: { name: true, nameAr: true } } } })).map((o) => [o.id, o]));
  return rows.map((r) => ({ ...r, quantity: r.quantity?.toString() ?? null, order: r.orderId ? orders.get(r.orderId) ?? null : null }));
}

async function load(tx: Tx, id: string, expected?: number) {
  const row = await tx.operationalException.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, "الاستثناء مش موجود");
  if (expected !== undefined && expected !== row.version) throw new ApiError(409, "الاستثناء اتعدل من حد تاني — حدّث الصفحة");
  return row;
}

export async function resolveException(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "orders.approve");
  const v = parse(z.object({ resolution: text("الحل", 1000), expected_version: version }), input);
  return inTx(async (tx) => {
    const row = await load(tx, id, v.expected_version);
    if (row.status === "resolved") throw new ApiError(409, "الاستثناء اتقفل بالفعل");
    const updated = await tx.operationalException.update({ where: { id, version: row.version }, data: { status: "resolved", resolution: v.resolution, resolvedAt: new Date(), resolvedById: actor.id, resolvedBy: actor.name, version: { increment: 1 } } });
    await audit(tx, actor, id, "exception_resolved", v.resolution, row.orderId);
    return updated;
  });
}

export async function assignException(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "orders.approve");
  const v = parse(z.object({ user_id: optText("المسؤول", 100), expected_version: version }), input);
  const user = v.user_id ? await prisma.user.findFirst({ where: { id: v.user_id, active: true }, select: { id: true, name: true } }) : null;
  if (v.user_id && !user) throw new ApiError(404, "المستخدم مش موجود");
  return inTx(async (tx) => {
    const row = await load(tx, id, v.expected_version);
    if (row.status === "resolved") throw new ApiError(409, "الاستثناء اتقفل بالفعل");
    const updated = await tx.operationalException.update({ where: { id, version: row.version }, data: { ownerId: user?.id ?? null, ownerName: user?.name ?? null, version: { increment: 1 } } });
    await audit(tx, actor, id, "exception_assigned", user?.name ?? null, row.orderId);
    if (user) await notify(tx, { userIds: [user.id], exclude: [actor.id] }, { type: "operations.exception", title: `اتوزّع عليك: ${TYPE_LABEL[row.type as ExceptionType]}`, body: row.description, entityType: "operational_exception", entityId: id, link: "/operations?tab=exceptions" });
    return updated;
  });
}
