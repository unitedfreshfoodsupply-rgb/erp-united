import { Prisma } from "@prisma/client";
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
import { cancelPendingApproval, cancelPendingApprovals, findPending, lockApprovalRequests, recordDecision, requestApproval } from "@/lib/core/approvals";
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
import { applyListPrices, setAgreedLinePricesInTx } from "@/lib/sales/pricing";
import { evaluateOrderCredit } from "@/lib/sales/credit";
import { assertQuantitiesFitUnits, assertQuantityFitsUnit, commitOrderStock } from "@/lib/sales/stock-commitment";
import { holdable, holdOrderForStockInTx } from "@/lib/sales/stock-hold";
import { settleOrderSuggestions, syncOrderSuggestions } from "@/lib/purchasing/requests";
import { assertPricingCleared, evaluateOrderPricing } from "@/lib/sales/price-exceptions";
import { releaseOrderInvoiceForReopen } from "@/lib/sales/invoicing";
import { ORDER_REFUSAL } from "@/lib/orderActions";
import { searchWhere } from "@/lib/core/search";
import { storedOrderCustomerName } from "@/lib/locale/names";
import { fitsDecimals } from "@/lib/quantity";
import { aggregateProduction, type ProductionItemInput } from "@/lib/production";

function assertValidQuantity(quantity: unknown, label: string): asserts quantity is number {
  // At most three decimals as typed (LOG-2): 16.1 is valid, though 16.1 × 1000 is not an integer in floating point.
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0 || quantity > 999_999_999_999 || !fitsDecimals(quantity, 3)) {
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
const ORDER_INCLUDE = {
  items: { include: { stockProduct: { select: { name: true, nameAr: true } } } },
  customerAccount: { select: { name: true, nameAr: true, code: true } },
} as const;

// The polled lists (boards, command center): the same order and line rows without the catalogue
// names, which only the order detail reads (ItemRow) — one query fewer on every poll (PS-4).
const ORDER_LIST_INCLUDE = {
  items: true,
  customerAccount: { select: { name: true, nameAr: true, code: true } },
} as const;

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
    // An order waiting for stock is not production until it is released (Nov 2026).
    stockStatus: "ok",
    OR: [{ status: { in: OPEN_STATUSES } }, { deliveryDate: todayLocalISO(now) }, { updatedAt: { gte: startOfBusinessDay(now) } }],
  };
}

export type OrderListFilters = {
  status?: OrderStatus | OrderStatus[];
  date?: string;
  assignedToId?: string;
  /** board (default when nothing else narrows the list) | production */
  scope?: "board" | "production";
  /** Search: order number, external id, customer name / code / phone (maturity 2026-11). A
   * search looks across every order, not only today's board. */
  q?: string;
  /** ok (the floor boards: orders that may be worked) | awaiting_stock (Nov 2026). */
  stockStatus?: "ok" | "awaiting_stock";
};

const isUnfiltered = (f: OrderListFilters) => !f.status && !f.date && !f.assignedToId && !f.q && !f.stockStatus;

export async function listOrders(filters: OrderListFilters) {
  const unfiltered = isUnfiltered(filters);
  const scope = filters.scope === "production" ? productionScope() : unfiltered || filters.scope === "board" ? boardScope() : {};
  return prisma.order.findMany({
    where: {
      // The scope is its own AND term: merged as keys, an absent status filter would
      // overwrite the scope's own status condition.
      AND: [
        scope,
        await searchWhere("order", filters.q),
        {
          ...(filters.assignedToId ? { assignedToId: filters.assignedToId } : {}),
          ...(filters.stockStatus ? { stockStatus: filters.stockStatus } : {}),
          status: filters.status
            ? Array.isArray(filters.status)
              ? { in: filters.status }
              : filters.status
            : undefined,
          deliveryDate: filters.date,
        },
      ],
    },
    include: ORDER_LIST_INCLUDE,
    orderBy: [{ deliveryDate: "asc" }, { deliveryTime: "asc" }, { createdAt: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Polled lists: run the full list only when something in it changed (PM-6)
// ---------------------------------------------------------------------------

/**
 * listOrders' WHERE as SQL, for the change stamp below. It must select exactly the orders
 * listOrders selects (boardScope / productionScope / the filters above) — keep the two in step;
 * tests/integration/order-list-stamp.test.ts compares them filter by filter. A search (q) has no
 * SQL form here: the polled lists never search, and a search is always run in full.
 */
export function orderListWhereSql(filters: OrderListFilters, now: Date): Prisma.Sql {
  // timestamp(3) columns hold UTC wall time; a JS Date bound in raw SQL arrives as timestamptz and
  // would be shifted by the session time zone, so the instant is passed as UTC text.
  const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;
  const open = Prisma.join(OPEN_STATUSES);
  const parts: Prisma.Sql[] = [];
  if (filters.scope === "production") {
    parts.push(Prisma.sql`o."status" <> 'cancelled' AND o."stockStatus" = 'ok' AND (o."status" IN (${open}) OR o."deliveryDate" = ${todayLocalISO(now)} OR o."updatedAt" >= ${ts(startOfBusinessDay(now))})`);
  } else if (isUnfiltered(filters) || filters.scope === "board") {
    const since = new Date(now.getTime() - BOARD_HISTORY_DAYS * 86_400_000);
    parts.push(Prisma.sql`(o."status" IN (${open}) OR o."updatedAt" >= ${ts(since)} OR o."deliveryDate" >= ${todayLocalISO(since)})`);
  }
  if (filters.assignedToId) parts.push(Prisma.sql`o."assignedToId" = ${filters.assignedToId}`);
  if (filters.stockStatus) parts.push(Prisma.sql`o."stockStatus" = ${filters.stockStatus}`);
  if (filters.status) {
    const list = Array.isArray(filters.status) ? filters.status : [filters.status];
    parts.push(list.length ? Prisma.sql`o."status" IN (${Prisma.join(list)})` : Prisma.sql`FALSE`);
  }
  if (filters.date !== undefined) parts.push(Prisma.sql`o."deliveryDate" = ${filters.date}`);
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

/**
 * A fingerprint of everything a polled list's payload is read from, in one statement: every
 * column of every order the list selects, every column of their lines, the names and code of
 * their customer cards and — with `stages` — when each open order entered its current status
 * (the audit rows getStageEntryMap reads). Equal stamps mean an identical list; anything that
 * changes a row, adds or removes one, or moves an order in or out of the window changes it.
 */
export async function orderListStamp(filters: OrderListFilters, opts: { stages?: boolean } = {}, now = new Date()): Promise<string> {
  const where = orderListWhereSql(filters, now);
  const stages = opts.stages
    ? Prisma.sql`UNION ALL SELECT 'a' || a."orderId" || '|' || max(a."timestamp")::text FROM "AuditLog" a
        WHERE a."orderId" IN (SELECT "id" FROM o WHERE "status" IN (${Prisma.join(OPEN_STATUSES)}))
          AND a."action" IN ('order_created', 'status_changed', 'status_override')
        GROUP BY a."orderId"`
    : Prisma.empty;
  const [row] = await prisma.$queryRaw<{ stamp: string }[]>`
    WITH o AS (SELECT * FROM "Order" o WHERE ${where})
    SELECT md5(coalesce(string_agg(x, E'\n' ORDER BY x), '')) AS stamp FROM (
      SELECT 'o' || o::text AS x FROM o
      UNION ALL SELECT 'i' || i::text FROM "OrderItem" i WHERE i."orderId" IN (SELECT "id" FROM o)
      UNION ALL SELECT 'c' || ROW(c."id", c."name", c."nameAr", c."code")::text FROM "Customer" c WHERE c."id" IN (SELECT "customerAccountId" FROM o)
      ${stages}
    ) t`;
  return row.stamp;
}

/** The last result of each polled list, keyed by its filters, with the stamp it was read under.
 * Per process; the payload is the same for every caller (no prices, no per-user fields). */
const polled = new Map<string, { stamp: string; value: unknown }>();
const POLLED_MAX = 64;

async function whenChanged<T>(key: string, stamp: string, load: () => Promise<T>): Promise<T> {
  const hit = polled.get(key);
  if (hit && hit.stamp === stamp) {
    polled.delete(key);
    polled.set(key, hit); // most recently used last
    return hit.value as T;
  }
  // The stamp was read before the data, so a change in between only makes the next poll reload.
  const value = await load();
  polled.delete(key);
  polled.set(key, { stamp, value });
  while (polled.size > POLLED_MAX) polled.delete(polled.keys().next().value as string);
  return value;
}

/**
 * listOrders for the polled boards: one stamp statement, and the full list only when the stamp
 * changed since the last poll of the same filters. The response is built from the same rows, so
 * the payload ETag (lib/http-response.ts) turns an unchanged poll into a body-less 304. A search
 * always runs in full.
 */
export async function listOrdersPolled(filters: OrderListFilters) {
  if (filters.q) return listOrders(filters);
  const stamp = await orderListStamp(filters);
  return whenChanged(`orders:${JSON.stringify(filters)}`, stamp, () => listOrders(filters));
}

/**
 * The command center's board and its operational intelligence (GET /api/supervisor/intelligence).
 * The orders and their stage entry times are re-read only when the stamp changed; the
 * classification is computed on every call, because it moves with the clock (minutes in stage,
 * stalled, late) and with the operational settings.
 */
export async function boardWithIntelligence() {
  const stamp = await orderListStamp({}, { stages: true });
  const { orders, entered } = await whenChanged("intelligence", stamp, async () => {
    const orders = await listOrders({});
    return { orders, entered: await getStageEntryMap(orders.filter((o) => isOrderOpen(o.status as OrderStatus)).map((o) => o.id)) };
  });
  return { orders, intelligence: intelligenceFrom(orders, entered, await getOperationalSettings()) };
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
    /** The customer's own PO reference (e.g. the hotel's PO number). */
    customer_po_ref?: string;
    /** Save a short order as "awaiting stock" instead of refusing it (Nov 2026). Without it
     * — the default, and the integration's default — a shortfall still refuses the order. */
    allow_shortage?: boolean;
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
  const customerPoRef = parseCustomerPoRef(input.customer_po_ref);
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

  // Typed prices (remediation 2026-11): parsed up front; who may set them is a permission.
  const typedPrices = input.items.map((i, idx) => {
    if (i.unit_price === undefined || i.unit_price === null || i.unit_price === "") return null;
    const raw = String(i.unit_price).trim().replace(/,/g, "");
    if (!/^\d{1,12}(\.\d{1,4})?$/.test(raw)) throw new ApiError(400, `سعر الصنف رقم ${idx + 1} لازم يكون رقم موجب بحد أقصى 4 خانات عشرية`);
    const disc = i.discount_pct === undefined || i.discount_pct === null || i.discount_pct === "" ? "0" : String(i.discount_pct).trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(disc) || Number(disc) > 100) throw new ApiError(400, `خصم الصنف رقم ${idx + 1} لازم يكون بين 0 و 100`);
    return { unitPrice: new Prisma.Decimal(raw), discountPct: new Prisma.Decimal(disc), reason: asText(i.price_reason, "price_reason")?.trim() || null };
  });
  if (typedPrices.some(Boolean) && !actor.permissions.includes("sales.price_override")) {
    throw new ApiError(403, "مالكش صلاحية تحدد سعر السطر — السعر بيتاخد من قائمة الأسعار");
  }
  const validatedItems = await validateProducts(input.items);
  await assertQuantitiesFitUnits(prisma, validatedItems.map((i, idx) => ({ unit: i.unit, qty: i.quantity, label: `الصنف رقم ${idx + 1} (${i.productName})` })));
  // Sales policies, read before the transaction opens.
  const creditMode = await getSetting("sales.credit_check_mode");
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
      // Through inTx (PM-3, Nov 2026): settings read inside the transaction (price exceptions,
      // the default warehouse) go through it on a cache miss instead of waiting on a second pool
      // connection, and the end-of-transaction steps run. Same 15 s / 20 s limits.
      order = await inTx(async (tx) => {
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
            customerPoRef,
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
          // Only the lines' ids are needed here (typed prices); the order is re-read in full at the end.
          include: { items: true },
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
        // Priced in the same transaction: an order is never visible half-priced. List
        // prices first; a price typed on the line is the agreed price (manual snapshot).
        await applyListPrices(tx, created.id, actor);
        if (typedPrices.some(Boolean)) {
          // Lines were created in input order; identical lines are interchangeable.
          const pool = [...created.items];
          const agreed: Parameters<typeof setAgreedLinePricesInTx>[1] = [];
          for (const [idx, vi] of validatedItems.entries()) {
            const at = pool.findIndex((it) => it.stockProductId === vi.stockProductId && it.unit === vi.unit && it.requiredQuantity === vi.quantity);
            const item = pool.splice(at, 1)[0];
            const tp = typedPrices[idx];
            if (item && tp) agreed.push({ itemId: item.id, input: tp });
          }
          // Every typed line in one pass (PW-2): same checks, rows and audit rows as line by line.
          await setAgreedLinePricesInTx(tx, agreed, actor);
        }
        await evaluateOrderPricing(tx, created.id, actor);
        if (opts.afterCreate) await opts.afterCreate(tx, created);
        // Every line is reserved in full or the order is not created (WF-01): a confirmed
        // order never promises stock that is not sellable now. Asked to (allow_shortage), a
        // plain shortage saves the order "awaiting stock" instead — nothing reserved, held in
        // "new", one procurement suggestion per short line (lib/sales/stock-hold.ts).
        try {
          await commitOrderStock(tx, created.id, stockActor(actor));
        } catch (err) {
          // commitOrderStock refuses before it writes anything, so the transaction is clean.
          if (input.allow_shortage !== true || !holdable(err)) throw err;
          await holdOrderForStockInTx(tx, created.id, err.shortfalls, actor);
        }
        // Credit is judged on the priced order (quotation prices included).
        await evaluateOrderCredit(tx, created.id, creditMode, actor);
        // Re-read: the steps above set fields (credit status) on the row created above.
        return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: ORDER_INCLUDE });
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

/** The customer's PO reference: trimmed, blank = none, at most 100 characters. */
function parseCustomerPoRef(raw: unknown): string | null {
  const v = asText(raw, "customer_po_ref")?.trim();
  if (!v) return null;
  if (v.length > 100) throw new ApiError(400, "مرجع أمر الشراء بتاع العميل لازم يكون 100 حرف بالكتير");
  return v;
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
  // Cancelling releases the order's reservations and is reasoned: it has its own path.
  if (to === "cancelled") throw new ApiError(400, "الإلغاء من زرار إلغاء الأوردر (بسبب) — مش من تغيير الحالة");

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
  // A price exception holds the order before preparation (remediation 2026-11).
  if (order.status === "new") assertPricingCleared(order, "مينفعش يبدأ التجهيز");
  // An order waiting for stock stays in "new" until it is re-checked and released (Nov 2026) —
  // whoever asks, override included: nothing is reserved for it.
  if (order.status === "new" && order.stockStatus === "awaiting_stock") {
    throw new ApiError(409, "مينفعش يبدأ التجهيز: الأوردر مستني بضاعة — اعمل إعادة فحص المخزون والإفراج الأول", "stock_awaiting");
  }
  if (order.status === "new") {
    const creditMode = await getSetting("sales.credit_check_mode");
    if (creditMode !== "off") {
      const credit = await inTx((tx) => evaluateOrderCredit(tx, orderId, creditMode, actor));
      if (creditMode === "block" && credit === "pending_approval") throw new ApiError(409, "الأوردر مستني موافقة الحسابات على الائتمان قبل التجهيز");
      if (creditMode === "block" && credit === "rejected") throw new ApiError(409, "الحسابات رفضت ائتمان الأوردر ده");
    }
  }


  return inTx(async (tx) => {
    // Dispatch freezes the customer's name on the order (Nov 2026): the delivery note and manifest
    // that leave now name the customer card as it is now, and a reprint keeps that name after any
    // later rename. Open orders show the card live; only a mapped order's name is touched.
    const card = to === "dispatched" && order.customerAccountId
      ? await tx.customer.findUnique({ where: { id: order.customerAccountId }, select: { name: true, nameAr: true } })
      : null;
    const frozenName = card ? storedOrderCustomerName(card) : null;
    const nameChanges: [string, string | null, string][] = frozenName && frozenName !== order.customerName ? [["customerName", order.customerName, frozenName]] : [];
    const updated = await casOrderUpdate(orderId, order.version, (where) =>
      tx.order.update({
        where,
        data: {
          status: to,
          version: { increment: 1 },
          ...(nameChanges.length ? { customerName: frozenName! } : {}),
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
        ...[...dispatchFieldChanges, ...nameChanges].map(([fieldChanged, oldValue, newValue]) => ({
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
    // be dispatched without its full issue — any shortfall refuses the dispatch and
    // rolls the status change back (WF-01). Taking an order back out of "dispatched"
    // reverses that issue and holds the stock for the order again.
    if (to === "dispatched") {
      await issueForDispatch(tx, orderId, stockActor(actor));
    } else if (order.status === "dispatched") {
      await releaseOrderInvoiceForReopen(tx, orderId, asText(opts.reason, "reason")?.trim() || "تعديل حالة", stockActor(actor));
      await reverseDispatchIssue(tx, orderId, asText(opts.reason, "reason")?.trim() || "تعديل حالة", stockActor(actor));
      await commitOrderStock(tx, orderId, stockActor(actor));
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
  // The order and its lines only: nothing below reads the catalogue or customer names (PM-8).
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: true },
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

/**
 * One tap on the floor (PM-8): the quantity and "done" in a single request used to run
 * setPreparedQuantity and then markItemPrepared — two transactions, about 20 round trips, and a
 * line left with its quantity saved but not marked done when the second one failed. These run
 * the same checks in the same order, then one transaction: one compare-and-swap update of the
 * line (quantity, note, done; version + 1), both audit rows (quantity set, marked done), and the
 * order's shortage / review flags. Returns the line, as the route returned it before.
 */
export async function recordPrepared(
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
  return recordItemStage(orderId, itemId, item, actor, opts.note, {
    data: { preparedQuantity: quantity, preparationStatus: "done" },
    audit: [
      { action: "prepared_quantity_set", fieldChanged: "preparedQuantity", oldValue: item.preparedQuantity, newValue: quantity, reason: opts.note },
      { action: "item_marked_prepared" },
    ],
  });
}

/** recordPrepared for loading: the loaded quantity and "loaded" in one transaction (PM-8). */
export async function recordLoaded(
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
  return recordItemStage(orderId, itemId, item, actor, opts.note, {
    data: { loadedQuantity: quantity, loadingStatus: "done" },
    audit: [
      { action: "loaded_quantity_set", fieldChanged: "loadedQuantity", oldValue: item.loadedQuantity, newValue: quantity, reason: opts.note },
      { action: "item_marked_loaded" },
    ],
  });
}

async function recordItemStage(
  orderId: string,
  itemId: string,
  item: { version: number; notes: string | null },
  actor: Actor,
  note: string | undefined,
  change: {
    data: Prisma.OrderItemUpdateInput;
    audit: Pick<Parameters<typeof writeAudit>[0], "action" | "fieldChanged" | "oldValue" | "newValue" | "reason">[];
  }
) {
  const thresholdPct = await shortageTolerance();
  return inTx(async (tx) => {
    const updated = await casItemUpdate(itemId, item.version, (where) =>
      tx.orderItem.update({ where, data: { ...change.data, notes: note ?? item.notes, version: { increment: 1 } } })
    );
    // One insert, one millisecond apart: the trail is sorted by timestamp, so the tap's rows
    // keep their order (quantity, then done) as when they were two separate actions.
    const at = Date.now();
    await writeAuditMany(
      change.audit.map((a, i) => ({ ...a, userId: actor.id, userName: actor.name, role: actor.role, entityType: "order_item" as const, entityId: itemId, orderId, source: actor.source, deviceId: actor.deviceId, timestamp: new Date(at + i) })),
      tx
    );
    await recomputeOrderFlags(tx, orderId, thresholdPct, actor);
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
    customerPoRef: string | null;
  }>,
  actor: Actor,
  reason: string,
  expectedVersion?: number
) {
  assertPermission(actor, "orders.edit", "بس المشرف يقدر يعدّل بيانات الأوردر");
  if (fields.customerPoRef !== undefined) fields = { ...fields, customerPoRef: parseCustomerPoRef(fields.customerPoRef) };
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
    fields = { ...fields, customerAccountId: resolution.customerId, customerName: storedOrderCustomerName(customerCard) };
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
    if (customerIdentityChanged) {
      // Lock order: the request locks before the order row, as cancel and the paths that raise
      // these requests take them; the customer's credit lock first, as evaluateOrderCredit takes
      // it before the credit request's own lock. The edit used to update the row first and take
      // both locks afterwards, so a cancel beside it could deadlock.
      await advisoryXactLock(tx, `sales:credit:${fields.customerAccountId}`);
      await lockApprovalRequests(tx, [{ type: "sales.credit", entityId: orderId }, { type: "sales.price_exception", entityId: orderId }]);
    }
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
      await evaluateOrderPricing(tx, orderId, actor);
      await evaluateOrderCredit(tx, orderId, await getSetting("sales.credit_check_mode"), actor);
    }
    // An awaiting-stock order's suggestions follow its delivery date and PO reference.
    if (updated.stockStatus === "awaiting_stock" && (fields.deliveryDate !== undefined || fields.customerPoRef !== undefined)) {
      await syncOrderSuggestions(tx, orderId, actor);
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

  await assertQuantityFitsUnit(prisma, item.unit, quantity, `"${item.productName}"`);

  const thresholdPct = await shortageTolerance();
  return inTx(async (tx) => {
    // Serialised with "re-check and release": the line and the order's stock state are read
    // together (lib/sales/stock-hold.ts takes the same lock).
    await advisoryXactLock(tx, `order-stock:${orderId}`);
    const updated = await casItemUpdate(itemId, item.version, (where) =>
      tx.orderItem.update({
        where,
        data: { requiredQuantity: quantity, version: { increment: 1 } },
      })
    );
    const { stockStatus } = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { stockStatus: true } });
    if (stockStatus === "awaiting_stock") {
      // An order waiting for stock reserves nothing: the line's suggestion is resized to the
      // new shortage instead (a line set to 0 closes it).
      await syncOrderSuggestions(tx, orderId, actor);
    } else {
      // A larger quantity must be reservable now, or the edit is refused (WF-01). Only this line
      // is re-committed (PW-2): the order's other lines already hold their stock in full and are
      // left exactly as they are — re-reading and re-locking every line made a one-line
      // correction cost ~10 round trips per line of the order.
      await commitOrderStock(tx, orderId, stockActor(actor), { lines: [itemId] });
    }

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
  // A cancelled order has nothing left to release (LOG-10). Its request can still be rejected.
  if (current.status === "cancelled") throw new ApiError(409, "الأوردر ملغي");
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
    throw new ApiError(400, ORDER_REFUSAL.cancelDispatched);
  }
  if (await liveTripStop(orderId)) throw new ApiError(409, ORDER_REFUSAL.cancelOnTrip);

  return inTx(async (tx) => {
    // Lock order with the paths that raise these requests: the credit and price-exception checks
    // take the request's lock before they update the order row, so cancel takes those two first;
    // the shortage check updates the order row first, so its lock comes after (in the withdrawal
    // below). Otherwise a cancel beside a price change or a credit check could deadlock.
    await lockApprovalRequests(tx, [{ type: "sales.credit", entityId: orderId }, { type: "sales.price_exception", entityId: orderId }]);
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
    // anything about it any more: its credit, a quantity variance or its prices (LOG-10 — the
    // shortage and price-exception requests used to stay in the inbox, on an order that is gone).
    await releaseAllForSource(tx, "order", orderId, `إلغاء الأوردر: ${reason}`, stockActor(actor));
    await cancelPendingApprovals(tx, (["sales.credit", "orders.shortage", "sales.price_exception"] as const).map((type) => ({ type, entityId: orderId, reason: `الأوردر اتلغى: ${reason}`, actor })));
    // Its procurement suggestions are no longer needed (one already on a supplier PO stays
    // with purchasing, noted on its history).
    await settleOrderSuggestions(tx, orderId, "cancelled", reason, actor);

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
  // Reopen sends a closed or advanced order back; a new order has not started (LOG-10). Moving it
  // on is the ordinary status change, with its credit, pricing and stock gates.
  if (order.status === "new") throw new ApiError(409, "الأوردر لسه جديد — مفيش حاجة تتفتح تاني، ابدأ التجهيز من تغيير الحالة العادي");
  // A cancelled order goes straight back to work, past the gates of leaving "new" — and the cancel
  // withdrew whatever its prices or credit were waiting for, so nobody could decide them any more
  // (LOG-10). With prices or credit not cleared it is not reopened: a copy goes through both again.
  if (order.status === "cancelled") {
    if (order.pricingStatus !== "ok") {
      throw new ApiError(409, "مينفعش يتفتح تاني: أسعار الأوردر كانت مستنية موافقة أو اترفضت قبل الإلغاء — اعمل نسخة من الأوردر، النسخة بتعدي على مراجعة الأسعار والائتمان من الأول", "reopen_needs_clone");
    }
    // Pending in any mode: the cancel withdrew the request, so nobody could ever decide it (the mode
    // may have left "block" since). A rejection is a decision that stands; only block mode stops on it.
    if (order.creditStatus === "pending_approval" || (order.creditStatus === "rejected" && (await getSetting("sales.credit_check_mode")) === "block")) {
      throw new ApiError(409, "مينفعش يتفتح تاني: ائتمان الأوردر كان مستني موافقة الحسابات أو اترفض قبل الإلغاء — اعمل نسخة من الأوردر، النسخة بتعدي على مراجعة الأسعار والائتمان من الأول", "reopen_needs_clone");
    }
  }
  const stop = await liveTripStop(orderId);
  if (stop && ["dispatched", "in_transit", "completed"].includes(stop.trip.status)) {
    throw new ApiError(409, ORDER_REFUSAL.reopenTripLeft(stop.trip.number));
  }

  // Status, line resets, flags and the audit row are one change: a reopened order
  // whose lines were not reset would be stuck with nothing left to tap.
  const thresholdPct = await shortageTolerance();
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
    }
    // The order is live again (from cancelled or dispatched): it must hold its stock
    // in full, or it cannot be reopened (WF-01).
    await commitOrderStock(tx, orderId, stockActor(actor));
    // A cancelled order that had been waiting for stock is now reserved in full and goes
    // back to work: it is no longer waiting (Nov 2026).
    if (order.stockStatus === "awaiting_stock") {
      await tx.order.update({ where: { id: orderId }, data: { stockStatus: "ok" } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "order_stock_released", entityType: "order", entityId: orderId, orderId, fieldChanged: "stockStatus", oldValue: "awaiting_stock", newValue: "ok", reason, source: actor.source, deviceId: actor.deviceId }, tx);
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
  // The lines of the production scope with only what the totals read, and the catalogue names
  // of their products, so the board can show each product in the UI language (`productName`
  // stays the name as ordered — it is also the drill-down key). Two queries (PS-4).
  const items = await prisma.orderItem.findMany({
    where: { order: productionScope() },
    select: { orderId: true, productName: true, unit: true, stockProductId: true, requiredQuantity: true, preparedQuantity: true, stockProduct: { select: { name: true, nameAr: true } } },
  });
  // The board computes the same totals from /api/orders?scope=production with the same helper
  // (PC-5), so the two cannot drift.
  const byOrder = new Map<string, ProductionItemInput[]>();
  for (const item of items) {
    const list = byOrder.get(item.orderId);
    if (list) list.push(item);
    else byOrder.set(item.orderId, [item]);
  }
  return aggregateProduction([...byOrder].map(([id, list]) => ({ id, items: list })));
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
  /** The linked customer card, when the caller loaded it (names in both languages for the UI). */
  customerAccount?: { name: string; nameAr: string | null } | null;
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
  customerAccount: { name: string; nameAr: string | null } | null;
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
  return intelligenceFrom(allOrders, enteredMap, ops);
}

/** getOperationalIntelligence from rows already read: no database access, the clock and the
 * settings applied now. */
function intelligenceFrom(allOrders: OrderForIntel[], enteredMap: Map<string, Date>, ops: OperationalSettings) {
  const openOrders = allOrders.filter((o) => isOrderOpen(o.status as OrderStatus));

  const classified: ClassifiedOrder[] = openOrders.map((o) => {
    const enteredAt = enteredMap.get(o.id) ?? o.createdAt;
    const { reason, minutesInStage } = classifyOrder(o, enteredAt, ops);
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      customerAccount: o.customerAccount ? { name: o.customerAccount.name, nameAr: o.customerAccount.nameAr } : null,
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

  // Only the columns the summary reads (PS-4): today's orders for their status and quantities,
  // the open orders for the pipeline, the exception flags and the intelligence.
  const [todayOrders, allOpenOrCancelledOrders] = await Promise.all([
    prisma.order.findMany({
      where: { createdAt: { gte: startOfDay, lt: endOfDay } },
      select: { status: true, items: { select: { requiredQuantity: true, preparedQuantity: true, loadedQuantity: true } } },
    }),
    // Pipeline, exception counts and intelligence all read open orders only.
    prisma.order.findMany({
      where: { status: { in: OPEN_STATUSES } },
      select: { id: true, orderNumber: true, customerName: true, status: true, needsReview: true, shortage: true, createdAt: true, updatedAt: true, deliveryDate: true, deliveryTime: true, customerAccount: { select: { name: true, nameAr: true } } },
    }),
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
