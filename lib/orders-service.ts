import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asText } from "@/lib/http";
import { writeAudit, writeAuditMany } from "@/lib/audit";
import { inTx, type Tx } from "@/lib/tx";
import { ApiError } from "@/lib/rbac";
import { lockOrderNumberDay, nextOrderNumber, orderNumberPrefix } from "@/lib/orderNumber";
import { advisoryXactLock } from "@/lib/dbLock";
import { canTransition, isStandardTransition } from "@/lib/orderWorkflow";
import { isShortage, needsSupervisorReview } from "@/lib/config";
import { getOperationalSettings, getSetting } from "@/lib/core/settings-service";
import type { OperationalSettings } from "@/lib/core/settings-registry";
import { cancelPendingApproval, findPending, recordDecision, requestApproval } from "@/lib/core/approvals";
import {
  exceptionCategory,
  isOrderOpen,
  isStalledInProgress,
  isWaitingTooLong,
  orderUrgency,
  STATUS_LABEL,
  OPEN_STATUSES,
} from "@/lib/orderPresentation";
import { validateProducts, type RawIncomingItem } from "@/lib/product-validation";
import { ORDER_STATUSES, type OrderStatus, type Role } from "@/lib/types";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { STATUS_PERMISSION } from "@/lib/permissions";
import { endOfBusinessDay, startOfBusinessDay, todayLocalISO } from "@/lib/localDate";
import { isValidISODate, isValidTimeOfDay } from "@/lib/dates";
import type { ServiceActor } from "@/lib/core/actor";
import { notify } from "@/lib/core/notifications";
import { issueForDispatch, reverseDispatchIssue } from "@/lib/inventory/dispatch";
import { releaseAllForSource } from "@/lib/inventory/reservations";
import { resolveCustomer } from "@/lib/sales/customers";
import { applyListPrices } from "@/lib/sales/pricing";
import { evaluateOrderCredit } from "@/lib/sales/credit";
import { syncOrderReservations } from "@/lib/sales/fulfilment";
import { releaseOrderInvoiceForReopen } from "@/lib/sales/invoicing";

function assertValidQuantity(quantity: unknown, label: string): asserts quantity is number {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0 || quantity > 999_999_999_999 || !Number.isInteger(quantity * 1000)) {
    throw new ApiError(400, `${label} لازم يكون من صفر إلى 999,999,999,999 وبحد أقصى 3 خانات عشرية`);
  }
}

export type Actor = {
  id: string | null;
  name: string;
  role: Role | "SYSTEM";
  source: "user" | "manual" | "system" | "n8n" | "hermes";
  deviceId?: string;
  /** Effective permissions resolved for this caller. Every authorization decision in
   * this service reads this list — never actor.role — so the rule is identical no
   * matter which route, integration or future caller reaches the function. */
  permissions: readonly string[];
};

// The linked customer account's names travel with the order so every screen can show the
// customer in the UI language (`customerName` is the text captured when the order came in).
const ORDER_INCLUDE = { items: true, customerAccount: { select: { name: true, nameAr: true, code: true } } } as const;

/** The order actor as the inventory services take it. "SYSTEM" (an integration) is
 * only a label there: those services check permissions, never the role. */
const stockActor = (a: Actor) => a as unknown as ServiceActor;

/** The live trip an order is on, if any. */
export function liveTripStop(orderId: string) {
  return prisma.tripStop.findFirst({ where: { orderId, active: true }, include: { trip: { select: { id: true, number: true, status: true } } } });
}

/** A supervisor assigns (or clears) who prepares an order. */
export async function assignOrder(orderId: string, userId: string | null, actor: Actor) {
  assertPermission(actor, "orders.approve", "بس المشرف يوزّع الأوردرات");
  const order = await getOrder(orderId);
  if (["dispatched", "cancelled"].includes(order.status)) throw new ApiError(409, "الأوردر مقفول");
  const user = userId ? await prisma.user.findFirst({ where: { id: userId, active: true }, select: { id: true, name: true } }) : null;
  if (userId && !user) throw new ApiError(404, "المستخدم مش موجود");
  return inTx(async (tx) => {
    const updated = await tx.order.update({ where: { id: orderId }, data: { assignedToId: user?.id ?? null, assignedToName: user?.name ?? null }, include: ORDER_INCLUDE });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "order_assigned", entityType: "order", entityId: orderId, orderId, fieldChanged: "assignedTo", oldValue: order.assignedToName, newValue: user?.name ?? null, source: actor.source, deviceId: actor.deviceId }, tx);
    if (user) await notify(tx, { userIds: [user.id], exclude: [actor.id] }, { type: "order.assigned", title: `اتوزّع عليك أوردر ${order.orderNumber}`, body: order.customerName, link: `/orders/${orderId}` });
    return updated;
  });
}

/** How long a dispatched or cancelled order stays on the boards (command center, exceptions). */
export const BOARD_HISTORY_DAYS = 7;

/**
 * The orders a live board shows: every open order, whatever its date, plus orders closed
 * (dispatched or cancelled) within the last BOARD_HISTORY_DAYS. History beyond that lives in
 * the reports and the audit log; without a bound every board loaded every order ever made.
 */
export function boardScope(now = new Date()): Prisma.OrderWhereInput {
  const since = new Date(now.getTime() - BOARD_HISTORY_DAYS * 86_400_000);
  return { OR: [{ status: { in: OPEN_STATUSES } }, { updatedAt: { gte: since } }, { deliveryDate: { gte: todayLocalISO(since) } }] };
}

/**
 * Today's production: every open order (a fresh order counts at once, whatever its delivery
 * date) and every non-cancelled order delivered or closed today (a dispatched order stays as
 * the record of what was produced today). Shared by the totals and the drill-down list.
 */
export function productionScope(now = new Date()): Prisma.OrderWhereInput {
  return {
    status: { not: "cancelled" },
    OR: [{ status: { in: OPEN_STATUSES } }, { deliveryDate: todayLocalISO(now) }, { updatedAt: { gte: startOfBusinessDay(now) } }],
  };
}

export async function listOrders(filters: {
  status?: OrderStatus | OrderStatus[];
  date?: string;
  assignedToId?: string;
  /** board (default when nothing else narrows the list) | production */
  scope?: "board" | "production";
}) {
  const unfiltered = !filters.status && !filters.date && !filters.assignedToId;
  const scope = filters.scope === "production" ? productionScope() : unfiltered || filters.scope === "board" ? boardScope() : {};
  return prisma.order.findMany({
    where: {
      // The scope is its own AND term: merged as keys, an absent status filter would
      // overwrite the scope's own status condition.
      AND: [
        scope,
        {
          ...(filters.assignedToId ? { assignedToId: filters.assignedToId } : {}),
          status: filters.status
            ? Array.isArray(filters.status)
              ? { in: filters.status }
              : filters.status
            : undefined,
          deliveryDate: filters.date,
        },
      ],
    },
    include: ORDER_INCLUDE,
    orderBy: [{ deliveryDate: "asc" }, { deliveryTime: "asc" }, { createdAt: "asc" }],
  });
}

export async function getOrder(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
  if (!order) throw new ApiError(404, "الأوردر مش موجود");
  return order;
}

export async function createOrder(
  input: {
    external_id?: string;
    customer_id?: string;
    /** The customer account chosen on screen (a typed name resolves by itself). */
    customer_account_id?: string;
    customer_name: string;
    delivery_date: string;
    delivery_time?: string;
    notes?: string;
    items: RawIncomingItem[];
  },
  actor: Actor,
  opts: {
    /** Runs inside the creating transaction, after the order and its audit row —
     * for callers whose own audit entry must commit with the order (clone). Not run
     * when the call is deduplicated to an existing order. */
    afterCreate?: (tx: Tx, order: { id: string; orderNumber: string }) => Promise<void>;
  } = {}
) {
  if (!asText(input.customer_name, "customer_name")?.trim() && !input.customer_account_id) throw new ApiError(400, "اختار حساب العميل من دليل العملاء");
  if (actor.source === "manual" && !input.customer_account_id) {
    throw new ApiError(400, "الأوردر اليدوي لازم يرتبط بحساب عميل من دليل العملاء");
  }
  if (!input.delivery_date) throw new ApiError(400, "تاريخ التسليم مطلوب");
  // A non-date used to be stored as-is, and the order number then silently fell back
  // to TODAY's date — an order "for next Tuesday" numbered and sorted as today's.
  if (!isValidISODate(input.delivery_date)) {
    throw new ApiError(400, "تاريخ التسليم لازم يكون تاريخ حقيقي بصيغة YYYY-MM-DD");
  }
  if (input.delivery_time && !isValidTimeOfDay(input.delivery_time)) {
    throw new ApiError(400, "ميعاد التسليم لازم يكون بصيغة HH:mm (24 ساعة)");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError(400, "لازم يكون فيه صنف واحد على الأقل");
  }
  input.items.forEach((i, idx) => {
    if (!asText(i.product_name, "product_name")?.trim() && !i.stock_product_id) throw new ApiError(400, `اختار الصنف رقم ${idx + 1} من دليل الأصناف`);
    const label = i.product_name?.trim() || `الصنف رقم ${idx + 1}`;
    assertValidQuantity(i.quantity, `كمية "${label}"`);
    if (i.quantity <= 0) throw new ApiError(400, `كمية "${label}" لازم تكون أكبر من صفر`);
    if (actor.source === "manual" && !i.stock_product_id) throw new ApiError(400, `الصنف رقم ${idx + 1} لازم يتحدد من دليل الأصناف`);
  });

  // Fast path for the ordinary n8n retry, where the original order already exists.
  // The authoritative check runs inside the transaction below, under a lock — two
  // retries that arrive at the same instant both miss this one.
  if (input.external_id) {
    const existing = await prisma.order.findFirst({
      where: { externalId: input.external_id },
      include: ORDER_INCLUDE,
    });
    if (existing) return existing; // idempotent create for n8n retries
  }

  const validatedItems = await validateProducts(input.items);
  // Sales policies, read before the transaction opens.
  const [creditMode, autoReserve] = await Promise.all([getSetting("sales.credit_check_mode"), getSetting("sales.auto_reserve")]);
  // Exact customer resolution (explicit account → integration id → name/alias);
  // an unknown customer never blocks the order — it is mapped later by a person.
  const customer = await resolveCustomer(prisma, {
    accountId: input.customer_account_id,
    externalRef: input.customer_id,
    name: input.customer_name,
  });
  if (actor.source === "manual" && customer.status !== "matched") {
    throw new ApiError(400, "العميل مش مربوط بكارت في دليل العملاء");
  }
  const customerCard = customer.status === "matched"
    ? await prisma.customer.findUnique({ where: { id: customer.customerId }, select: { name: true, nameAr: true } })
    : null;
  const orderCustomerName = customerCard?.nameAr ?? customerCard?.name ?? input.customer_name.trim();

  // Order numbers are sequential per delivery day, so generating one and inserting it
  // must be atomic — otherwise two simultaneous creates read the same "next" value and
  // one of them dies on the unique index. Both steps run inside a single transaction
  // holding that day's advisory lock, which makes concurrent creates queue instead of
  // collide. The P2002 retry stays as a safety net (e.g. a number inserted by some
  // other path outside this lock).
  const orderNumberPrefixForDay = orderNumberPrefix(input.delivery_date);
  let order;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      order = await prisma.$transaction(async (tx) => {
        // Lock order: external_id first, then the order-number day. Every caller uses
        // this same order, so concurrent creates queue instead of deadlocking.
        if (input.external_id) {
          await advisoryXactLock(tx, `order-external-id:${input.external_id}`);
          const existing = await tx.order.findFirst({
            where: { externalId: input.external_id },
            include: ORDER_INCLUDE,
          });
          // A retry gets the original order back, with no second order_created row.
          if (existing) return existing;
        }
        await lockOrderNumberDay(tx, orderNumberPrefixForDay);
        const orderNumber = await nextOrderNumber(tx, orderNumberPrefixForDay);
        const created = await tx.order.create({
          data: {
            orderNumber,
            externalId: input.external_id,
            customerId: input.customer_id,
            customerAccountId: customer.status === "matched" ? customer.customerId : null,
            customerName: orderCustomerName,
            deliveryDate: input.delivery_date,
            // Blank means "no time given"; the DB CHECK only admits NULL or HH:mm.
            deliveryTime: asText(input.delivery_time, "delivery_time")?.trim() || null,
            notes: input.notes,
            source: actor.source,
            items: {
              create: validatedItems.map((i) => ({
                productId: i.productId,
                stockProductId: i.stockProductId,
                productName: i.productName,
                unit: i.unit,
                requiredQuantity: i.quantity,
              })),
            },
          },
          include: ORDER_INCLUDE,
        });
        // The order and the record of its creation commit together: an order that
        // exists with no order_created row would have no origin in its own timeline.
        await writeAudit(
          {
            userId: actor.id,
            userName: actor.name,
            role: actor.role,
            action: "order_created",
            entityType: "order",
            entityId: created.id,
            orderId: created.id,
            newValue: created.orderNumber,
            source: actor.source,
            deviceId: actor.deviceId,
          },
          tx
        );
        // Priced in the same transaction: an order is never visible half-priced.
        await applyListPrices(tx, created.id, actor);
        if (opts.afterCreate) await opts.afterCreate(tx, created);
        // Credit is judged on the priced order (quotation prices included); the
        // reservation holds stock for it from the moment it exists.
        await evaluateOrderCredit(tx, created.id, creditMode, actor);
        if (autoReserve) await syncOrderReservations(tx, created.id, stockActor(actor));
        // Re-read: the steps above set fields (credit status) on the row created above.
        return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: ORDER_INCLUDE });
      }, {
        // Concurrent creates for the same day queue on the advisory lock, so allow a
        // realistic wait before giving up rather than the 2s Prisma default.
        maxWait: 15_000,
        timeout: 20_000,
      });
      break;
    } catch (err) {
      if (isPrismaCode(err, "P2002") && attempt < 2) continue; // orderNumber collision, retry
      throw err;
    }
  }
  if (!order) throw new ApiError(500, "مش قادرين ننشئ رقم أوردر، حاول تاني");
  return order;
}

function versionConflict(what: string, current: number): never {
  throw new ApiError(
    409,
    `${what} اتغيّر من واحد تاني، حدّث الشاشة وحاول تاني (نسخة الطلب: ${current})`
  );
}

function assertVersion(current: number, expected: number | undefined, what: string) {
  if (expected !== undefined && expected !== current) versionConflict(what, current);
}

/**
 * Every mutation below reads the row, checks its version, then writes an incremented
 * one. Read-check-write is not atomic: two requests that arrive together (a double-tap
 * on a tablet, an offline client replaying a queued action, two people on the same
 * order) both read the same version, both pass the check, and both write — producing a
 * duplicate action and a duplicate audit row. SQLite's single-writer lock hid this;
 * Postgres runs them genuinely in parallel. Folding the version into the UPDATE's WHERE
 * turns it into a real compare-and-swap: the second writer matches no row and gets the
 * same 409 the caller already handles, so the API contract is unchanged.
 */
function isNoRowMatched(err: unknown) {
  return isPrismaCode(err, "P2025");
}

function isPrismaCode(err: unknown, code: string) {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

async function casOrderUpdate<T>(
  orderId: string,
  currentVersion: number,
  run: (where: { id: string; version: number }) => Promise<T>
): Promise<T> {
  try {
    return await run({ id: orderId, version: currentVersion });
  } catch (err) {
    if (isNoRowMatched(err)) versionConflict("الأوردر", currentVersion);
    throw err;
  }
}

async function casItemUpdate<T>(
  itemId: string,
  currentVersion: number,
  run: (where: { id: string; version: number }) => Promise<T>
): Promise<T> {
  try {
    return await run({ id: itemId, version: currentVersion });
  } catch (err) {
    if (isNoRowMatched(err)) versionConflict("الصنف", currentVersion);
    throw err;
  }
}

/** The UI only ever offers "set prepared qty" while the order is in "preparing"
 * (same for "load" / "loading") — but that's just a client-side gate. Enforce the
 * same rule server-side so a stray/buggy/direct API call can't record a prepared
 * or loaded quantity against an order that hasn't reached (or has already left)
 * that stage — e.g. "loading" an item on an order still sitting at "new". */
function assertOrderStatusForItemAction(status: string | undefined, expected: OrderStatus, what: string) {
  if (!status) throw new ApiError(404, "الأوردر مش موجود");
  if (status !== expected) {
    throw new ApiError(
      409,
      `${what} — الأوردر مش في مرحلة "${STATUS_LABEL[expected]}" دلوقتي (الحالة الحالية: ${
        STATUS_LABEL[status as OrderStatus] ?? status
      })`
    );
  }
}

/**
 * Loads an order line together with the status of the order it belongs to.
 *
 * These were two separate round trips — fetch the item, then fetch the order purely to
 * read one status column. Over a remote database that is a wasted ~130ms on the single
 * most frequent write in the system (a preparer confirming a line).
 */
async function loadItemWithOrderStatus(orderId: string, itemId: string) {
  const item = await prisma.orderItem.findUnique({
    where: { id: itemId },
    include: { order: { select: { status: true } } },
  });
  if (!item || item.orderId !== orderId) throw new ApiError(404, "الصنف مش موجود");
  return item;
}

export async function moveOrderStatus(
  orderId: string,
  to: OrderStatus,
  actor: Actor,
  opts: {
    reason?: string;
    expectedVersion?: number;
    vehicle?: string;
    driverName?: string;
    crateCount?: number;
    /** Set only by the trip service: the order leaves as part of its trip. */
    viaTrip?: boolean;
  } = {}
) {
  if (!ORDER_STATUSES.includes(to)) throw new ApiError(400, "حالة غير معروفة");

  const order = await getOrder(orderId);
  // An order on a trip leaves with its trip — vehicle, driver and crates come from it.
  if (to === "dispatched" && !opts.viaTrip && (await liveTripStop(orderId))) {
    throw new ApiError(409, "الأوردر ده على رحلة — الخروج بيتم من شاشة الرحلة");
  }
  assertVersion(order.version, opts.expectedVersion, "الأوردر");
  if (to === order.status) {
    throw new ApiError(400, "الأوردر في الحالة دي بالفعل");
  }

  const role = actor.role as Role;
  const standard = isStandardTransition(order.status as OrderStatus, to);
  // orders.edit is what "may force the workflow" means: forcing a non-standard move
  // is editing the order's history, not operating it. Supervisors and super admins
  // hold it; preparers and loaders never do, so their path is unchanged.
  const canForceWorkflow = actorCan(actor, "orders.edit");
  const isOverride = canForceWorkflow && !standard;

  // Two independent gates. First: you must hold the permission for the stage you are
  // moving the order INTO — a preparer cannot start loading even by calling the API
  // directly. Second: unless you may force the workflow, the move must be a legal
  // step for your role in the state machine.
  const stagePermission = STATUS_PERMISSION[to];
  if (stagePermission && !actorCan(actor, stagePermission)) {
    throw new ApiError(403, "مش مسموح تنقل الأوردر للحالة دي");
  }
  if (!canForceWorkflow && !canTransition(order.status as OrderStatus, to, role)) {
    throw new ApiError(403, "مش مسموح تنقل الأوردر للحالة دي");
  }
  if (order.status === "cancelled") throw new ApiError(400, "الأوردر ملغي بالفعل");
  if (isOverride && !asText(opts.reason, "reason")?.trim()) {
    throw new ApiError(400, "التغيير ده يدوي (override)، لازم تكتب السبب");
  }

  if ((to === "ready_for_loading" || to === "loaded") && (order.needsReview || order.shortage) && !actorCan(actor, "orders.approve")) {
    throw new ApiError(409, "الأوردر محتاج مراجعة واعتماد المشرف الأول");
  }

  // Normal (non-override) forward steps must have every item actually finished —
  // otherwise a client bug or a raw API call could push an order forward with
  // items still untouched. A supervisor override intentionally bypasses this.
  if (!isOverride) {
    if (to === "ready_for_loading" && order.items.some((i) => i.preparationStatus !== "done")) {
      throw new ApiError(409, "لسه فيه أصناف متجهزتش");
    }
    if (to === "loaded" && order.items.some((i) => i.loadingStatus !== "done")) {
      throw new ApiError(409, "لسه فيه أصناف متحملتش");
    }
  }

  const vehicle = asText(opts.vehicle, "vehicle")?.trim();
  const driverName = asText(opts.driverName, "driverName")?.trim();
  const crateCount = opts.crateCount;

  // Dispatch is the point where the order physically leaves — require the driver,
  // the vehicle, and the crate count so the manifest is never blank. Enforced here
  // server-side (not just disabling a button) so a raw API call can't skip it either.
  // Unlike the item-completion checks below, this one applies even to a supervisor
  // override — "override" means skipping workflow steps, not skipping the physical
  // fact of which driver/vehicle/crates actually left with the order.
  if (to === "dispatched") {
    if (!vehicle) throw new ApiError(400, "لازم تدخل رقم/اسم العربية قبل ما تأكد الأوردر");
    if (!driverName) throw new ApiError(400, "لازم تدخل اسم السواق قبل ما تأكد الأوردر");
    if (crateCount === undefined || !Number.isFinite(crateCount) || crateCount <= 0) {
      throw new ApiError(400, "لازم تدخل عدد البرنيكة قبل ما تأكد الأوردر");
    }
  }

  const dispatchFieldChanges: [string, string | null, string][] = [];
  if (vehicle && vehicle !== order.vehicle) dispatchFieldChanges.push(["vehicle", order.vehicle, vehicle]);
  if (driverName && driverName !== order.driverName)
    dispatchFieldChanges.push(["driverName", order.driverName, driverName]);
  if (crateCount !== undefined && crateCount !== order.crateCount)
    dispatchFieldChanges.push(["crateCount", order.crateCount?.toString() ?? null, String(crateCount)]);

  // Credit control gates the first step of work (leaving "new"). The evaluation is
  // committed on its own — a refused move must still leave its approval request
  // behind for finance — and only then may the move proceed.
  if (order.status === "new" && to !== "cancelled") {
    const creditMode = await getSetting("sales.credit_check_mode");
    if (creditMode !== "off") {
      const credit = await inTx((tx) => evaluateOrderCredit(tx, orderId, creditMode, actor));
      if (creditMode === "block" && credit === "pending_approval") throw new ApiError(409, "الأوردر مستني موافقة الحسابات على الائتمان قبل التجهيز");
      if (creditMode === "block" && credit === "rejected") throw new ApiError(409, "الحسابات رفضت ائتمان الأوردر ده");
    }
  }

  // Read before the transaction opens (see shortageTolerance below).
  const touchesStock = to === "dispatched" || order.status === "dispatched";
  const dispatchPolicy = touchesStock ? await getSetting("inventory.dispatch_issue_policy") : "lenient";

  return inTx(async (tx) => {
    const updated = await casOrderUpdate(orderId, order.version, (where) =>
      tx.order.update({
        where,
        data: {
          status: to,
          version: { increment: 1 },
          // Whoever starts preparing an unassigned order owns it.
          ...(to === "preparing" && !order.assignedToId && actor.id ? { assignedToId: actor.id, assignedToName: actor.name } : {}),
          ...(vehicle ? { vehicle } : {}),
          ...(driverName ? { driverName } : {}),
          ...(crateCount !== undefined ? { crateCount } : {}),
        },
        include: ORDER_INCLUDE,
      })
    );

    // The status row and the dispatch manifest rows go in one insert — dispatch is
    // the action with the most audit rows and the least patience behind it.
    await writeAuditMany(
      [
        {
          userId: actor.id,
          userName: actor.name,
          role: actor.role,
          action: isOverride ? "status_override" : "status_changed",
          entityType: "order" as const,
          entityId: orderId,
          orderId,
          fieldChanged: "status",
          oldValue: order.status,
          newValue: to,
          reason: opts.reason,
          source: actor.source,
          deviceId: actor.deviceId,
        },
        ...dispatchFieldChanges.map(([fieldChanged, oldValue, newValue]) => ({
          userId: actor.id,
          userName: actor.name,
          role: actor.role,
          action: "order_edited",
          entityType: "order" as const,
          entityId: orderId,
          orderId,
          fieldChanged,
          oldValue,
          newValue,
          source: actor.source,
          deviceId: actor.deviceId,
        })),
      ],
      tx
    );

    // The truck leaving is the stock leaving: same transaction, so an order can never
    // be dispatched without its issue (or an exception explaining what was not), and a
    // strict-policy refusal rolls the status change back. Taking an order back out of
    // "dispatched" reverses that issue.
    if (to === "dispatched") {
      await issueForDispatch(tx, orderId, dispatchPolicy, stockActor(actor));
    } else if (order.status === "dispatched") {
      await releaseOrderInvoiceForReopen(tx, orderId, asText(opts.reason, "reason")?.trim() || "تعديل حالة", stockActor(actor));
      await reverseDispatchIssue(tx, orderId, asText(opts.reason, "reason")?.trim() || "تعديل حالة", stockActor(actor));
    }

    return updated;
  });
}

/** The tolerance is read before the caller opens its transaction and passed in, so a
 * transaction never waits on a second pool connection for a (usually cached) read. */
function shortageTolerance() {
  return getSetting("orders.shortage_review_threshold_pct");
}

/**
 * Recomputes shortage / needs-review from the lines and keeps the approval engine in
 * step: an order that newly needs review gets a pending "orders.shortage" request
 * (idempotent — one per order), and one whose variance was corrected has its pending
 * request cancelled. The engine is only consulted when review is or was required, so
 * the common case — a line within tolerance — costs nothing extra.
 */
async function recomputeOrderFlags(tx: Tx, orderId: string, thresholdPct: number, actor: Actor) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_INCLUDE,
  });
  let shortage = false;
  let needsReview = false;
  for (const item of order.items) {
    // While loading, an item not yet loaded falls back to its prepared quantity so
    // a shortage flagged during prep doesn't briefly vanish the moment loading starts
    // on some OTHER item — it only really clears once that item is actually loaded.
    const actual =
      order.status === "loading" || order.status === "loaded"
        ? item.loadedQuantity ?? item.preparedQuantity
        : item.preparedQuantity;
    if (isShortage(item.requiredQuantity, actual)) shortage = true;
    if (needsSupervisorReview(item.requiredQuantity, actual, thresholdPct)) needsReview = true;
  }
  // Flags are ALWAYS derived from the current actual quantities (the designed
  // contract, asserted by tests/orders.test.ts): an approval clears them at the
  // moment it lands, and the NEXT quantity write — e.g. a load while still short —
  // re-derives them. However, if the variance is unchanged since the last time it
  // was approved (F-17), we skip a duplicate approval — the same shortfall at a
  // later stage (preparation → loading) does not need a second sign-off.
  await tx.order.update({
    where: { id: orderId },
    data: { shortage, needsReview },
  });

  const requester = { id: actor.id, name: actor.name, role: actor.role, deviceId: actor.deviceId };
  if (needsReview) {
    // Dedup: same shortage already approved? Compare current line quantities
    // with the last approved request's payload. If they match, skip.
    const lastApproved = await tx.approvalRequest.findFirst({
      where: { type: "orders.shortage", entityId: orderId, status: "approved" },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    const sameShortfall =
      lastApproved?.payload != null &&
      typeof lastApproved.payload === "object" &&
      !Array.isArray(lastApproved.payload) &&
      order.items.every((item) => {
        const lines = (lastApproved.payload as Record<string, unknown>).lines as Array<Record<string, unknown>> | undefined;
        if (!lines) return false;
        const l = lines.find((x) => x.id === item.id);
        if (!l) return false;
        return l.required === item.requiredQuantity && l.prepared === item.preparedQuantity && l.loaded === item.loadedQuantity;
      });
    if (sameShortfall) {
      await tx.order.update({ where: { id: orderId }, data: { needsReview: false } });
      return { shortage, needsReview: false };
    }
    const worst = order.items
      .map((i) => {
        const actual = order.status === "loading" || order.status === "loaded" ? i.loadedQuantity ?? i.preparedQuantity : i.preparedQuantity;
        return { i, actual, pct: actual == null || i.requiredQuantity === 0 ? 0 : (Math.abs(i.requiredQuantity - actual) / i.requiredQuantity) * 100 };
      })
      .sort((a, b) => b.pct - a.pct)[0];
    await requestApproval(tx, {
      type: "orders.shortage",
      entityId: orderId,
      title: `${order.orderNumber} · ${order.customerName}`,
      summary: worst
        ? `${worst.i.productName}: مطلوب ${worst.i.requiredQuantity} ${worst.i.unit}، الفعلي ${worst.actual} (فرق ${Math.round(worst.pct * 10) / 10}%)`
        : undefined,
      payload: { thresholdPct, lines: order.items.map((i) => ({ id: i.id, product: i.productName, required: i.requiredQuantity, prepared: i.preparedQuantity, loaded: i.loadedQuantity, unit: i.unit })) },
      requester,
    });
  } else if (order.needsReview) {
    await cancelPendingApproval(tx, {
      type: "orders.shortage",
      entityId: orderId,
      reason: "الفرق اتصلح — الكميات بقت في حدود المسموح",
      actor: requester,
    });
  }
  return { shortage, needsReview };
}

export async function setPreparedQuantity(
  orderId: string,
  itemId: string,
  quantity: number,
  actor: Actor,
  opts: { expectedVersion?: number; note?: string } = {}
) {
  assertPermission(actor, "orders.prepare", "بس التجهيز أو المشرف يقدروا يدخلوا الكمية اللي اتجهزت");
  const item = await loadItemWithOrderStatus(orderId, itemId);
  assertOrderStatusForItemAction(item.order?.status, "preparing", "مينفعش تسجّل كمية تجهيز");
  assertVersion(item.version, opts.expectedVersion, "الصنف");
  assertValidQuantity(quantity, "الكمية");

  const thresholdPct = await shortageTolerance();
  return inTx(async (tx) => {
    const updated = await casItemUpdate(itemId, item.version, (where) =>
      tx.orderItem.update({
        where,
        data: {
          preparedQuantity: quantity,
          notes: opts.note ?? item.notes,
          version: { increment: 1 },
        },
      })
    );

    await writeAudit({
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "prepared_quantity_set",
      entityType: "order_item",
      entityId: itemId,
      orderId,
      fieldChanged: "preparedQuantity",
      oldValue: item.preparedQuantity,
      newValue: quantity,
      reason: opts.note,
      source: actor.source,
      deviceId: actor.deviceId,
    }, tx);

    const flags = await recomputeOrderFlags(tx, orderId, thresholdPct, actor);
    return { item: updated, flags };
  });
}

export async function markItemPrepared(
  orderId: string,
  itemId: string,
  actor: Actor,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.prepare", "بس التجهيز أو المشرف يقدروا يعلّموا الصنف اتجهز");
  const item = await loadItemWithOrderStatus(orderId, itemId);
  assertOrderStatusForItemAction(item.order?.status, "preparing", "مينفعش تعلّم صنف اتجهز");
  assertVersion(item.version, expectedVersion, "الصنف");
  if (item.preparedQuantity == null) {
    throw new ApiError(400, "دخّل الكمية اللي اتجهزت الأول");
  }

  return inTx(async (tx) => {
    const updated = await casItemUpdate(itemId, item.version, (where) =>
      tx.orderItem.update({
        where,
        data: { preparationStatus: "done", version: { increment: 1 } },
      })
    );

    await writeAudit({
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "item_marked_prepared",
      entityType: "order_item",
      entityId: itemId,
      orderId,
      source: actor.source,
      deviceId: actor.deviceId,
    }, tx);

    return updated;
  });
}

export async function setLoadedQuantity(
  orderId: string,
  itemId: string,
  quantity: number,
  actor: Actor,
  opts: { expectedVersion?: number; note?: string } = {}
) {
  assertPermission(actor, "orders.load", "بس التحميل أو المشرف يقدروا يدخلوا الكمية اللي اتحملت");
  const item = await loadItemWithOrderStatus(orderId, itemId);
  assertOrderStatusForItemAction(item.order?.status, "loading", "مينفعش تسجّل كمية تحميل");
  assertVersion(item.version, opts.expectedVersion, "الصنف");
  assertValidQuantity(quantity, "الكمية");

  const thresholdPct = await shortageTolerance();
  return inTx(async (tx) => {
    const updated = await casItemUpdate(itemId, item.version, (where) =>
      tx.orderItem.update({
        where,
        data: {
          loadedQuantity: quantity,
          notes: opts.note ?? item.notes,
          version: { increment: 1 },
        },
      })
    );

    await writeAudit({
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "loaded_quantity_set",
      entityType: "order_item",
      entityId: itemId,
      orderId,
      fieldChanged: "loadedQuantity",
      oldValue: item.loadedQuantity,
      newValue: quantity,
      reason: opts.note,
      source: actor.source,
      deviceId: actor.deviceId,
    }, tx);

    const flags = await recomputeOrderFlags(tx, orderId, thresholdPct, actor);
    return { item: updated, flags };
  });
}

export async function markItemLoaded(
  orderId: string,
  itemId: string,
  actor: Actor,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.load", "بس التحميل أو المشرف يقدروا يعلّموا الصنف اتحمل");
  const item = await loadItemWithOrderStatus(orderId, itemId);
  assertOrderStatusForItemAction(item.order?.status, "loading", "مينفعش تعلّم صنف اتحمل");
  assertVersion(item.version, expectedVersion, "الصنف");
  if (item.loadedQuantity == null) {
    throw new ApiError(400, "دخّل الكمية اللي اتحملت الأول");
  }

  return inTx(async (tx) => {
    const updated = await casItemUpdate(itemId, item.version, (where) =>
      tx.orderItem.update({
        where,
        data: { loadingStatus: "done", version: { increment: 1 } },
      })
    );

    await writeAudit({
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "item_marked_loaded",
      entityType: "order_item",
      entityId: itemId,
      orderId,
      source: actor.source,
      deviceId: actor.deviceId,
    }, tx);

    return updated;
  });
}

export async function editOrder(
  orderId: string,
  fields: Partial<{
    customerName: string;
    customerAccountId: string;
    deliveryDate: string;
    deliveryTime: string | null;
    notes: string;
    vehicle: string;
  }>,
  actor: Actor,
  reason: string,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.edit", "بس المشرف يقدر يعدّل بيانات الأوردر");
  if (!asText(reason, "reason")?.trim()) throw new ApiError(400, "لازم تكتب سبب التعديل");
  if (fields.customerName !== undefined && !asText(fields.customerName, "customerName")?.trim()) {
    throw new ApiError(400, "اسم العميل مطلوب");
  }
  if (fields.deliveryDate !== undefined && !isValidISODate(fields.deliveryDate)) {
    throw new ApiError(400, "تاريخ التسليم لازم يكون تاريخ حقيقي بصيغة YYYY-MM-DD");
  }
  if (fields.deliveryTime !== undefined) {
    // Clearing the time stores NULL — the DB CHECK admits NULL or HH:mm, never "".
    fields = { ...fields, deliveryTime: asText(fields.deliveryTime, "deliveryTime")?.trim() || null };
    if (fields.deliveryTime && !isValidTimeOfDay(fields.deliveryTime)) {
      throw new ApiError(400, "ميعاد التسليم لازم يكون بصيغة HH:mm (24 ساعة)");
    }
  }
  const order = await getOrder(orderId);
  assertVersion(order.version, expectedVersion, "الأوردر");

  const customerIdentityChanged = fields.customerName !== undefined || fields.customerAccountId !== undefined;
  if (customerIdentityChanged) {
    if (order.status !== "new") throw new ApiError(409, "مينفعش تغيّر العميل بعد ما التشغيل يبدأ");
    if (await prisma.salesInvoice.count({ where: { orderId, status: { in: ["draft", "issued"] } } })) {
      throw new ApiError(409, "مينفعش تغيّر العميل بعد إنشاء الفاتورة");
    }
    const resolution = await resolveCustomer(prisma, {
      accountId: fields.customerAccountId ?? order.customerAccountId,
      name: fields.customerName ?? order.customerName,
    });
    if (resolution.status !== "matched") throw new ApiError(400, "اختار عميلًا نشطًا من دليل العملاء");
    const customerCard = await prisma.customer.findUnique({ where: { id: resolution.customerId }, select: { name: true, nameAr: true } });
    if (!customerCard) throw new ApiError(400, "حساب العميل مش موجود");
    fields = { ...fields, customerAccountId: resolution.customerId, customerName: customerCard.nameAr ?? customerCard.name };
  }

  const changes: [string, unknown, unknown][] = [];
  (Object.keys(fields) as (keyof typeof fields)[]).forEach((key) => {
    const val = fields[key];
    const prev = (order as Record<string, unknown>)[key];
    // Treat empty string and null/undefined as equivalent "blank" so clearing an
    // already-blank field (e.g. notes) doesn't create a no-op audit entry.
    if (val !== undefined && (val || "") !== (prev || "")) {
      changes.push([key, prev, val]);
    }
  });

  return inTx(async (tx) => {
    const updated = await casOrderUpdate(orderId, order.version, (where) =>
      tx.order.update({
        where,
        data: { ...fields, version: { increment: 1 } },
        include: ORDER_INCLUDE,
      })
    );

    await writeAuditMany(
      changes.map(([field, oldVal, newVal]) => ({
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "order_edited",
        entityType: "order" as const,
        entityId: orderId,
        orderId,
        fieldChanged: field,
        oldValue: oldVal as string,
        newValue: newVal as string,
        reason,
        source: actor.source,
        deviceId: actor.deviceId,
      })),
      tx
    );

    if (customerIdentityChanged) {
      await applyListPrices(tx, orderId, actor, { refresh: true });
      await evaluateOrderCredit(tx, orderId, await getSetting("sales.credit_check_mode"), actor);
    }

    return updated;
  });
}

export async function editRequiredQuantity(
  orderId: string,
  itemId: string,
  quantity: number,
  actor: Actor,
  reason: string,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.edit", "بس المشرف يقدر يعدّل الكمية المطلوبة");
  if (!asText(reason, "reason")?.trim()) throw new ApiError(400, "لازم تكتب سبب التعديل");
  // 0 is a legitimate correction — e.g. "turns out this product doesn't exist" —
  // so only negative/non-numeric values are rejected here, unlike a brand-new order line.
  assertValidQuantity(quantity, "الكمية المطلوبة");
  const item = await prisma.orderItem.findUnique({ where: { id: itemId } });
  if (!item || item.orderId !== orderId) throw new ApiError(404, "الصنف مش موجود");
  assertVersion(item.version, expectedVersion, "الصنف");

  const thresholdPct = await shortageTolerance();
  const autoReserve = await getSetting("sales.auto_reserve");
  return inTx(async (tx) => {
    const updated = await casItemUpdate(itemId, item.version, (where) =>
      tx.orderItem.update({
        where,
        data: { requiredQuantity: quantity, version: { increment: 1 } },
      })
    );
    if (autoReserve) await syncOrderReservations(tx, orderId, stockActor(actor));

    await writeAudit({
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "required_quantity_edited",
      entityType: "order_item",
      entityId: itemId,
      orderId,
      fieldChanged: "requiredQuantity",
      oldValue: item.requiredQuantity,
      newValue: quantity,
      reason,
      source: actor.source,
      deviceId: actor.deviceId,
    }, tx);

    await recomputeOrderFlags(tx, orderId, thresholdPct, actor);
    return updated;
  });
}

export async function approveShortage(
  orderId: string,
  actor: Actor,
  reason: string,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.approve", "بس المشرف يقدر يعتمد الفرق");
  if (!asText(reason, "reason")?.trim()) throw new ApiError(400, "لازم تكتب سبب الاعتماد");
  const order = await getOrder(orderId);
  assertVersion(order.version, expectedVersion, "الأوردر");
  // Keeps the approval history (and the "needs your action now" count) meaningful —
  // an "approval" of an order that was never actually flagged would be audit noise,
  // not a real decision.
  if (!order.needsReview && !order.shortage) {
    throw new ApiError(400, "الأوردر مش محتاج اعتماد دلوقتي");
  }
  const requireDifferentApprover = await getSetting("approvals.require_different_approver");

  // Approving from the order screen and approving from the approvals inbox are the
  // same decision: both record it on the order's "orders.shortage" request.
  return inTx(async (tx) => {
    let pending = await findPending(tx, "orders.shortage", orderId);
    if (!pending) {
      // Flagged before the approval engine existed: open the request now so the
      // decision still has one record.
      pending = (
        await requestApproval(tx, {
          type: "orders.shortage",
          entityId: orderId,
          title: `${order.orderNumber} · ${order.customerName}`,
          requester: { id: null, name: "النظام", role: "SYSTEM" },
          silent: true,
        })
      ).request;
    }
    await recordDecision(tx, pending, "approve", actor, { comment: reason, requireDifferentApprover });
    return applyShortageApproval(tx, orderId, actor, reason, order.version);
  });
}

/**
 * The effect of an approved "orders.shortage" request: the order is released. Runs
 * in the deciding transaction (from approveShortage, or from the approvals inbox via
 * lib/core/approval-handlers.ts). Keeps the original shortage_approved audit row, so
 * the order's timeline reads exactly as it always has.
 */
export async function applyShortageApproval(
  tx: Tx,
  orderId: string,
  actor: Actor | { id: string | null; name: string; role: string; source?: Actor["source"]; deviceId?: string },
  reason: string | undefined,
  expectedVersion?: number
) {
  const current = await tx.order.findUnique({ where: { id: orderId } });
  if (!current) throw new ApiError(404, "الأوردر مش موجود");
  if (!current.needsReview && !current.shortage) throw new ApiError(409, "الأوردر مبقاش محتاج اعتماد");
  const version = expectedVersion ?? current.version;
  const updated = await casOrderUpdate(orderId, version, (where) =>
    tx.order.update({
      where,
      data: { needsReview: false, shortage: false, version: { increment: 1 } },
      include: ORDER_INCLUDE,
    })
  );
  await writeAudit(
    {
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "shortage_approved",
      entityType: "order",
      entityId: orderId,
      orderId,
      reason,
      source: actor.source ?? "user",
      deviceId: actor.deviceId,
    },
    tx
  );
  return updated;
}

export async function cancelOrder(
  orderId: string,
  actor: Actor,
  reason: string,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.edit", "بس المشرف يقدر يلغي الأوردر");
  if (!asText(reason, "reason")?.trim()) throw new ApiError(400, "لازم تكتب سبب الإلغاء");
  const order = await getOrder(orderId);
  assertVersion(order.version, expectedVersion, "الأوردر");
  if (order.status === "cancelled") throw new ApiError(400, "الأوردر ملغي بالفعل");
  // Once the truck has actually left, "cancel" no longer describes reality — the
  // correction path for a mistaken dispatch is reopen (إعادة فتح), which is audited
  // and puts the order back into an active, workable state instead of quietly
  // reclassifying real freight-in-transit as never-happened.
  if (order.status === "dispatched") {
    throw new ApiError(400, "الأوردر اتحرك بالفعل — استخدم إعادة الفتح لو محتاج تصحيح");
  }
  if (await liveTripStop(orderId)) throw new ApiError(409, "الأوردر على رحلة — شيله من الرحلة الأول");

  return inTx(async (tx) => {
    const updated = await casOrderUpdate(orderId, order.version, (where) =>
      tx.order.update({
        where,
        data: { status: "cancelled", version: { increment: 1 } },
        include: ORDER_INCLUDE,
      })
    );

    await writeAudit({
      userId: actor.id,
      userName: actor.name,
      role: actor.role,
      action: "order_cancelled",
      entityType: "order",
      entityId: orderId,
      orderId,
      oldValue: order.status,
      newValue: "cancelled",
      reason,
      source: actor.source,
      deviceId: actor.deviceId,
    }, tx);

    // Stock promised to a cancelled order is free again, and nobody needs to decide
    // its credit any more.
    await releaseAllForSource(tx, "order", orderId, `إلغاء الأوردر: ${reason}`, stockActor(actor));
    await cancelPendingApproval(tx, { type: "sales.credit", entityId: orderId, reason: `الأوردر اتلغى: ${reason}`, actor });

    return updated;
  });
}

export async function reopenOrder(
  orderId: string,
  to: OrderStatus,
  actor: Actor,
  reason: string,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.edit", "بس المشرف يقدر يفتح الأوردر تاني");
  if (!asText(reason, "reason")?.trim()) throw new ApiError(400, "لازم تكتب سبب إعادة الفتح");
  // Reopen only ever sends a closed/stuck order BACK into active work — never
  // straight to "dispatched" (which has its own mandatory driver/vehicle/crate
  // capture in moveOrderStatus) or "cancelled" (its own reasoned endpoint) or "new"
  // (nothing to reopen into). Without this, reopen was a second, unguarded path to
  // "dispatched" that skipped the manifest requirement entirely.
  const REOPEN_TARGETS: OrderStatus[] = ["preparing", "ready_for_loading", "loading"];
  if (!REOPEN_TARGETS.includes(to)) {
    throw new ApiError(400, "إعادة الفتح تقدر ترجع الأوردر بس لمرحلة التجهيز أو التحميل");
  }
  const order = await getOrder(orderId);
  assertVersion(order.version, expectedVersion, "الأوردر");
  if (order.status === to) throw new ApiError(400, "الأوردر في الحالة دي بالفعل");
  const stop = await liveTripStop(orderId);
  if (stop && ["dispatched", "in_transit", "completed"].includes(stop.trip.status)) {
    throw new ApiError(409, `الأوردر خرج على الرحلة ${stop.trip.number} — التصحيح بنتيجة التسليم (مرتجع/عجز)`);
  }

  // Status, line resets, flags and the audit row are one change: a reopened order
  // whose lines were not reset would be stuck with nothing left to tap.
  const thresholdPct = await shortageTolerance();
  const autoReserve = await getSetting("sales.auto_reserve");
  await inTx(async (tx) => {
    await casOrderUpdate(orderId, order.version, (where) =>
      tx.order.update({
        where,
        data: { status: to, version: { increment: 1 } },
      })
    );

    // Reset completion on whichever stage(s) are being redone — the last known
    // quantities stay as a starting point (ItemRow already falls back to them), but
    // each item needs re-confirming.
    if (to === "preparing") {
      await tx.orderItem.updateMany({
        where: { orderId },
        data: { preparationStatus: "pending", loadingStatus: "pending", version: { increment: 1 } },
      });
    } else if (to === "ready_for_loading" || to === "loading") {
      await tx.orderItem.updateMany({
        where: { orderId },
        data: { loadingStatus: "pending", version: { increment: 1 } },
      });
    }

    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "order_reopened",
        entityType: "order",
        entityId: orderId,
        orderId,
        oldValue: order.status,
        newValue: to,
        reason,
        source: actor.source,
        deviceId: actor.deviceId,
      },
      tx
    );

    if (order.status === "dispatched") {
      // An invoiced order cannot quietly become un-shipped: a draft is voided, an
      // issued invoice needs a credit note first.
      await releaseOrderInvoiceForReopen(tx, orderId, reason, stockActor(actor));
      await reverseDispatchIssue(tx, orderId, reason, stockActor(actor));
      // The stock is back on the shelf and the order is live again: hold it again.
      if (autoReserve) await syncOrderReservations(tx, orderId, stockActor(actor));
    }

    await recomputeOrderFlags(tx, orderId, thresholdPct, actor);
  });
  return getOrder(orderId);
}

/**
 * Duplicate an order as a brand-new one — same customer/items, but a fresh id,
 * order number, and version, starting clean at "new" with no inherited audit
 * history or progress. Goes through the same createOrder() path as every other
 * order (n8n included), so numbering/idempotency/validation all stay consistent —
 * this is not a parallel creation path. The clone never carries an external_id,
 * so it can never collide with (or be deduped against) the source order or any
 * future n8n retry of it.
 */
export async function cloneOrder(
  orderId: string,
  actor: Actor,
  overrides: { delivery_date?: string; delivery_time?: string } = {}
) {
  assertPermission(actor, "orders.create", "بس المشرف يقدر ينسخ الأوردر");
  const source = await getOrder(orderId);

  const clone = await createOrder(
    {
      customer_id: source.customerId ?? undefined,
      customer_account_id: source.customerAccountId ?? undefined,
      customer_name: source.customerName,
      delivery_date: asText(overrides.delivery_date, "delivery_date")?.trim() || source.deliveryDate,
      delivery_time: asText(overrides.delivery_time, "delivery_time")?.trim() || source.deliveryTime || undefined,
      notes: source.notes ?? undefined,
      items: source.items.map((i) => ({
        product_id: i.productId ?? undefined,
        stock_product_id: i.stockProductId ?? undefined,
        product_name: i.productName,
        quantity: i.requiredQuantity,
        unit: i.unit,
      })),
    },
    { ...actor, source: "manual" },
    {
      afterCreate: (tx, created) =>
        writeAudit(
          {
            userId: actor.id,
            userName: actor.name,
            role: actor.role,
            action: "order_cloned",
            entityType: "order",
            entityId: created.id,
            orderId: created.id,
            fieldChanged: "clonedFrom",
            oldValue: source.orderNumber,
            newValue: created.orderNumber,
            reason: `اتنسخ من ${source.orderNumber}`,
            source: actor.source,
            deviceId: actor.deviceId,
          },
          tx
        ).then(() => undefined),
    }
  );

  return clone;
}

/**
 * Aggregates required/prepared/loaded quantities over today's production (productionScope):
 * a running total that is not scoped to a delivery date for open work — a freshly-arrived
 * order counts immediately even if its delivery date is days away — and keeps an order
 * dispatched today as the record of what was actually produced. Orders closed on earlier
 * days no longer count (they used to, so the totals grew with every day of history).
 */
export async function dailyProduction() {
  const orders = await prisma.order.findMany({
    where: productionScope(),
    include: ORDER_INCLUDE,
  });

  const byProduct = new Map<
    string,
    { productName: string; productId: string | null; unit: string; required: number; prepared: number; orders: Set<string> }
  >();

  for (const order of orders) {
    for (const item of order.items) {
      const key = `${item.productName}__${item.unit}`;
      if (!byProduct.has(key)) {
        byProduct.set(key, {
          productName: item.productName,
          productId: item.stockProductId ?? null,
          unit: item.unit,
          required: 0,
          prepared: 0,
          orders: new Set(),
        });
      }
      const agg = byProduct.get(key)!;
      agg.productId ??= item.stockProductId ?? null; // any linked line names the product
      agg.required += item.requiredQuantity;
      agg.prepared += item.preparedQuantity ?? 0;
      agg.orders.add(order.id);
    }
  }

  // The catalogue names, so the board can show each product in the UI language
  // (`productName` stays the name as ordered — it is also the drill-down key).
  const ids = [...new Set([...byProduct.values()].map((v) => v.productId).filter((x): x is string => !!x))];
  const names = new Map((ids.length ? await prisma.stockProduct.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, nameAr: true } }) : []).map((p) => [p.id, p]));
  return Array.from(byProduct.values())
    .map((v) => ({
      productName: v.productName,
      productNameEn: (v.productId && names.get(v.productId)?.name) || null,
      productNameAr: (v.productId && names.get(v.productId)?.nameAr) || null,
      unit: v.unit,
      required: v.required,
      prepared: v.prepared,
      orderCount: v.orders.size,
    }))
    .sort((a, b) => b.required - a.required);
}

// ---------------------------------------------------------------------------
// Operational Intelligence — turns raw order/item/audit rows into "what needs
// me right now and why", computed server-side from real data only. No
// fabricated metrics, no client-only guesses: every reason below is derived
// from an actual stored field (needsReview, updatedAt, deliveryDate/Time) or
// the actual audit trail (when an order really entered its current status).
// ---------------------------------------------------------------------------

export type PriorityReason =
  | "blocked_approval"
  | "stalled"
  | "delivery_risk"
  | "waiting_to_start"
  | "ready_for_loading"
  | "loading"
  | "on_track";

// Lower rank = surfaced first. Matches the operator's actual triage order:
// nothing can move until an approval is unblocked, then whatever's gone quiet,
// then whatever's actually at risk of being late, then whatever hasn't started.
const REASON_RANK: Record<PriorityReason, number> = {
  blocked_approval: 0,
  stalled: 1,
  delivery_risk: 2,
  waiting_to_start: 3,
  ready_for_loading: 4,
  loading: 5,
  on_track: 6,
};

const REASON_LABEL: Record<PriorityReason, string> = {
  blocked_approval: "محتاج اعتماد المشرف",
  stalled: "متوقف من فترة",
  delivery_risk: "قريب أو متأخر عن ميعاد التسليم",
  waiting_to_start: "مستنٍ حد يبدأ فيه",
  ready_for_loading: "جاهز للتحميل",
  loading: "بيتحمّل دلوقتي",
  on_track: "ماشي عادي",
};

const WHY_IT_MATTERS: Record<PriorityReason, string> = {
  blocked_approval: "الأوردر واقف تمامًا لحد ما تعتمد الفرق — مفيش حد تاني يقدر يكمله.",
  stalled: "مفيش حد لمس الأوردر ده من فترة طويلة رغم إنه لسه مخلصش.",
  delivery_risk: "ميعاد التسليم قرّب أو فات فعلاً.",
  waiting_to_start: "الأوردر وصل من فترة ولسه محدش بدأ يجهزه.",
  ready_for_loading: "الأصناف جاهزة، محتاج حد يبدأ التحميل.",
  loading: "بيتحمّل دلوقتي على العربية.",
  on_track: "ماشي في معاده الطبيعي، مفيش حاجة تستنى تدخلك.",
};

const RECOMMENDED_ACTION: Record<PriorityReason, string> = {
  blocked_approval: "افتح الأوردر واعتمد الفرق",
  stalled: "كلّم المسؤول عن الأوردر يكمله",
  delivery_risk: "تابع الأوردر ده الأول",
  waiting_to_start: "حد يبدأ يجهز الأوردر ده",
  ready_for_loading: "ابدأ تحميله",
  loading: "تابع التحميل لحد ما يخلص",
  on_track: "مفيش إجراء مطلوب دلوقتي",
};

const ACTIONABLE_REASONS: PriorityReason[] = [
  "blocked_approval",
  "stalled",
  "delivery_risk",
  "waiting_to_start",
];

/** The real moment an order entered its CURRENT status — from the audit trail,
 * not a guess. order_created counts as "entered new". Falls back to createdAt
 * only if no audit row exists yet (shouldn't happen in practice). One batched
 * query for every order passed in, never one query per order. */
async function getStageEntryMap(orderIds: string[]): Promise<Map<string, Date>> {
  if (orderIds.length === 0) return new Map();
  const events = await prisma.auditLog.findMany({
    where: {
      orderId: { in: orderIds },
      action: { in: ["order_created", "status_changed", "status_override"] },
    },
    orderBy: { timestamp: "desc" },
    select: { orderId: true, timestamp: true },
  });
  const map = new Map<string, Date>();
  for (const e of events) {
    if (e.orderId && !map.has(e.orderId)) map.set(e.orderId, e.timestamp);
  }
  return map;
}

type OrderForIntel = {
  id: string;
  orderNumber: string;
  customerName: string;
  status: string;
  needsReview: boolean;
  createdAt: Date;
  updatedAt: Date;
  deliveryDate: string;
  deliveryTime: string | null;
};

function classifyOrder(
  order: OrderForIntel,
  enteredAt: Date,
  ops: OperationalSettings
): { reason: PriorityReason; minutesInStage: number } {
  const status = order.status as OrderStatus;
  const minutesInStage = Math.max(0, Math.round((Date.now() - enteredAt.getTime()) / 60000));

  if (order.needsReview) return { reason: "blocked_approval", minutesInStage };
  if (isStalledInProgress(status, order.updatedAt.toISOString(), ops.stalledMinutes)) {
    return { reason: "stalled", minutesInStage };
  }
  if (orderUrgency(status, order.deliveryDate, order.deliveryTime, ops.deliverySoonMinutes) === "late") {
    return { reason: "delivery_risk", minutesInStage };
  }
  if (status === "new" && isWaitingTooLong(status, order.createdAt.toISOString(), ops.waitingToStartMinutes)) {
    return { reason: "waiting_to_start", minutesInStage };
  }
  if (status === "ready_for_loading") return { reason: "ready_for_loading", minutesInStage };
  if (status === "loading") return { reason: "loading", minutesInStage };
  return { reason: "on_track", minutesInStage };
}

export type ClassifiedOrder = {
  id: string;
  orderNumber: string;
  customerName: string;
  status: OrderStatus;
  reason: PriorityReason;
  reasonLabel: string;
  whyItMatters: string;
  recommendedAction: string;
  minutesInStage: number;
  enteredCurrentStatusAt: string;
};

/**
 * The core of "operational intelligence": classify every currently-open order
 * by real priority reason, roll that up into a per-stage bottleneck view, and
 * derive an explainable (rule-based, not scored) health level. Takes an
 * already-fetched order list so callers that already loaded orders (the daily
 * report) don't pay for a second orders query — only the audit lookup is extra,
 * and that's a single batched query regardless of how many orders there are.
 */
export async function getOperationalIntelligence(allOrders: OrderForIntel[]) {
  const openOrders = allOrders.filter((o) => isOrderOpen(o.status as OrderStatus));
  const [enteredMap, ops] = await Promise.all([
    getStageEntryMap(openOrders.map((o) => o.id)),
    getOperationalSettings(),
  ]);

  const classified: ClassifiedOrder[] = openOrders.map((o) => {
    const enteredAt = enteredMap.get(o.id) ?? o.createdAt;
    const { reason, minutesInStage } = classifyOrder(o, enteredAt, ops);
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      status: o.status as OrderStatus,
      reason,
      reasonLabel: REASON_LABEL[reason],
      whyItMatters: WHY_IT_MATTERS[reason],
      recommendedAction: RECOMMENDED_ACTION[reason],
      minutesInStage,
      enteredCurrentStatusAt: enteredAt.toISOString(),
    };
  });

  classified.sort((a, b) => {
    const r = REASON_RANK[a.reason] - REASON_RANK[b.reason];
    if (r !== 0) return r;
    return b.minutesInStage - a.minutesInStage;
  });

  const needsAttention = classified.filter((c) => ACTIONABLE_REASONS.includes(c.reason));

  const byStageMap = new Map<OrderStatus, { count: number; totalMinutes: number; maxMinutes: number }>();
  for (const c of classified) {
    const bucket = byStageMap.get(c.status) ?? { count: 0, totalMinutes: 0, maxMinutes: 0 };
    bucket.count++;
    bucket.totalMinutes += c.minutesInStage;
    bucket.maxMinutes = Math.max(bucket.maxMinutes, c.minutesInStage);
    byStageMap.set(c.status, bucket);
  }
  const byStage = Array.from(byStageMap.entries())
    .map(([status, b]) => ({
      status,
      count: b.count,
      avgMinutes: Math.round(b.totalMinutes / b.count),
      maxMinutes: b.maxMinutes,
    }))
    .sort((a, b) => b.avgMinutes - a.avgMinutes);

  const currentBottleneckStage = byStage.length > 0 ? byStage[0].status : null;

  let mostStalledOrder: ClassifiedOrder | null = null;
  for (const c of classified) {
    if (!mostStalledOrder || c.minutesInStage > mostStalledOrder.minutesInStage) mostStalledOrder = c;
  }

  const stalledCount = classified.filter((c) => c.reason === "stalled").length;
  const blockedApprovals = classified.filter((c) => c.reason === "blocked_approval").length;
  const deliveryRiskCount = classified.filter((c) => c.reason === "delivery_risk").length;
  const readyLoadingBacklog = classified.filter(
    (c) => c.status === "ready_for_loading" || c.status === "loading"
  ).length;

  // Explainable, rule-based health — never a decorative score. "Critical" only
  // when something is truly blocked (nobody else can move it forward without the
  // supervisor); "attention" when nothing is blocked but something needs eyes on
  // it; "healthy" only when neither is true.
  let level: "healthy" | "attention" | "critical";
  const reasons: string[] = [];
  // The same reasons as dictionary keys + counts, so a screen can show them in the
  // user's language; `reasons` keeps its Arabic text for existing consumers.
  const reasonKeys: { key: string; count: number }[] = [];
  if (blockedApprovals > 0) {
    level = "critical";
    reasons.push(`${blockedApprovals} أوردر محتاج اعتمادك`);
    reasonKeys.push({ key: "health.reason.blocked", count: blockedApprovals });
  } else if (stalledCount > 0 || deliveryRiskCount > 0) {
    level = "attention";
    if (stalledCount > 0) { reasons.push(`${stalledCount} أوردر متوقف من فترة`); reasonKeys.push({ key: "health.reason.stalled", count: stalledCount }); }
    if (deliveryRiskCount > 0) { reasons.push(`${deliveryRiskCount} أوردر قريب/متأخر عن الميعاد`); reasonKeys.push({ key: "health.reason.delivery-risk", count: deliveryRiskCount }); }
  } else {
    level = "healthy";
  }

  return {
    generatedAt: new Date().toISOString(),
    orders: classified,
    needsAttention,
    bottleneck: { byStage, currentBottleneckStage, mostStalledOrder },
    health: {
      level,
      reasons,
      reasonKeys,
      counts: {
        activeOrders: openOrders.length,
        stalledOrders: stalledCount,
        blockedApprovals,
        deliveryRisk: deliveryRiskCount,
        readyLoadingBacklog,
      },
    },
  };
}

/**
 * Real end-of-shift / start-of-day snapshot for a supervisor — built entirely
 * from current order/item rows, no synthetic metrics. "Today" is orders whose
 * createdAt falls within the server's local calendar day; the pipeline snapshot
 * and exception counts are as-of-now regardless of when each order arrived,
 * since a shift needs to know the whole current picture, not just today's slice.
 */
export async function dailyOperationsSummary() {
  const now = new Date();
  const startOfDay = startOfBusinessDay(now);
  const endOfDay = endOfBusinessDay(now);
  const dateLabel = todayLocalISO(now);

  const [todayOrders, allOpenOrCancelledOrders] = await Promise.all([
    prisma.order.findMany({
      where: { createdAt: { gte: startOfDay, lt: endOfDay } },
      include: ORDER_INCLUDE,
    }),
    // Pipeline, exception counts and intelligence all read open orders only.
    prisma.order.findMany({ where: { status: { in: OPEN_STATUSES } }, include: ORDER_INCLUDE }),
  ]);

  const byStatusToday: Record<string, number> = {};
  for (const o of todayOrders) byStatusToday[o.status] = (byStatusToday[o.status] ?? 0) + 1;

  const pipelineNow: Record<string, number> = {};
  for (const o of allOpenOrCancelledOrders) {
    if (!isOrderOpen(o.status as OrderStatus)) continue;
    pipelineNow[o.status] = (pipelineNow[o.status] ?? 0) + 1;
  }

  let required = 0;
  let prepared = 0;
  let loaded = 0;
  for (const o of todayOrders) {
    if (o.status === "cancelled") continue;
    for (const item of o.items) {
      required += item.requiredQuantity;
      prepared += item.preparedQuantity ?? 0;
      loaded += item.loadedQuantity ?? 0;
    }
  }

  let exceptionsActive = 0;
  let exceptionsInformational = 0;
  for (const o of allOpenOrCancelledOrders) {
    const cat = exceptionCategory({ ...o, status: o.status as OrderStatus });
    if (cat === "active") exceptionsActive++;
    else if (cat === "informational") exceptionsInformational++;
  }

  // Reuse the same operational-intelligence classification the Command Center
  // uses, instead of a second, parallel notion of "stalled" — one source of
  // truth for bottleneck/health data, fed from the orders already fetched above.
  const intel = await getOperationalIntelligence(allOpenOrCancelledOrders);

  const todayNonCancelled = todayOrders.filter((o) => o.status !== "cancelled");
  const dispatchedToday = todayOrders.filter((o) => o.status === "dispatched").length;
  const completionPct =
    todayNonCancelled.length > 0 ? Math.round((dispatchedToday / todayNonCancelled.length) * 100) : null;

  return {
    date: dateLabel,
    ordersReceivedToday: todayOrders.length,
    byStatusToday,
    pipelineNow,
    quantitiesToday: { required, prepared, loaded },
    exceptionsActive,
    exceptionsInformational,
    stalledCount: intel.health.counts.stalledOrders,
    dispatchedToday,
    completionPct,
    bottleneck: intel.bottleneck,
    health: intel.health,
    needsAttention: intel.needsAttention.slice(0, 8),
    needsAttentionTotal: intel.needsAttention.length,
  };
}
