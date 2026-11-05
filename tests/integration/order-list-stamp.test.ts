/* Polled order lists (PS-4, PM-6, Nov 2026). The boards poll /api/orders and the command center
   every 3-5 s; an unchanged poll now costs one stamp statement instead of the full list. The stamp
   must select exactly the orders listOrders selects and change with everything the payload is read
   from (order and line columns, customer card names, stage entry times), the polled result must be
   the list itself, and the lighter list rows must keep every order and line column. Synthetic rows
   on the test database. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { writeAudit } from "@/lib/audit";
import {
  BOARD_HISTORY_DAYS, boardWithIntelligence, dailyOperationsSummary, dailyProduction, getOperationalIntelligence, getOrder,
  listOrders, listOrdersPolled, orderListStamp, orderListWhereSql, productionScope, type OrderListFilters,
} from "@/lib/orders-service";
import { startOfBusinessDay, todayLocalISO } from "@/lib/localDate";

const TAG = `ZZSTAMP${Date.now()}`;
const today = todayLocalISO();
let customerId = "";
let n = 0;
const ids: Record<string, string> = {};

async function order(data: Partial<Prisma.OrderUncheckedCreateInput> = {}, lines = 2) {
  n++;
  return prisma.order.create({
    data: {
      orderNumber: `${TAG}-${n}`, customerName: `${TAG} عميل`, customerAccountId: customerId, deliveryDate: today, status: "new", ...data,
      items: { create: Array.from({ length: lines }, (_, i) => ({ productName: `${TAG} صنف ${i + 1}`, unit: "KG", requiredQuantity: 10 + i })) },
    },
  });
}
/** Moves updatedAt without Prisma's @updatedAt (fixtures at the edges of the time windows). */
const setUpdatedAt = (id: string, at: Date) => prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${at.toISOString()}::timestamp WHERE "id" = ${id}`;
const sqlIds = async (f: OrderListFilters) =>
  (await prisma.$queryRaw<{ id: string }[]>`SELECT o."id" FROM "Order" o WHERE ${orderListWhereSql(f, new Date())}`).map((r) => r.id).sort();
const listIds = async (f: OrderListFilters) => (await listOrders(f)).map((o) => o.id).sort();

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  const sales = { ...actor("منى", ROLE_PERMISSIONS.SALES as string[], ids.mona, "SALES"), source: "manual" as const };
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
});
after(async () => {
  await prisma.$disconnect();
});

test("the stamp's SQL selects exactly the orders listOrders selects, filter by filter and at the window edges", async () => {
  const now = Date.now();
  const day = 86_400_000;
  // Closed orders on both sides of the 7-day board window and of today's production window, so a
  // time-zone shift in the SQL (the session is not UTC) moves one of them across.
  const inBoard = await order({ status: "dispatched", deliveryDate: "2020-01-01" });
  const outBoard = await order({ status: "cancelled", deliveryDate: "2020-01-01" });
  await setUpdatedAt(inBoard.id, new Date(now - BOARD_HISTORY_DAYS * day + 3_600_000));
  await setUpdatedAt(outBoard.id, new Date(now - BOARD_HISTORY_DAYS * day - 3_600_000));
  const inProd = await order({ status: "dispatched", deliveryDate: "2020-01-01" });
  const outProd = await order({ status: "dispatched", deliveryDate: "2020-01-01" });
  await setUpdatedAt(inProd.id, new Date(startOfBusinessDay().getTime() + 60_000));
  await setUpdatedAt(outProd.id, new Date(startOfBusinessDay().getTime() - 60_000));
  await order({ status: "preparing", assignedToId: ids.ahmed });
  await order({ status: "new", stockStatus: "awaiting_stock" });

  const filters: OrderListFilters[] = [
    {}, { status: ["new", "preparing"], stockStatus: "ok" }, { status: ["new", "preparing", "ready_for_loading", "loading", "loaded"], stockStatus: "ok" },
    { scope: "production" }, { date: today }, { date: "" }, { date: "2020-01-01" }, { assignedToId: ids.ahmed }, { stockStatus: "awaiting_stock" },
    { status: "dispatched" }, { status: [] }, { scope: "board", status: ["new"] }, { scope: "production", status: ["dispatched"] }, { scope: "board" },
  ];
  for (const f of filters) assert.deepEqual(await sqlIds(f), await listIds(f), `same orders for ${JSON.stringify(f)}`);
  const board = await listIds({});
  assert.ok(board.includes(inBoard.id) && !board.includes(outBoard.id), "the board window edge is where listOrders puts it");
  const prod = await listIds({ scope: "production" });
  assert.ok(prod.includes(inProd.id) && !prod.includes(outProd.id), "the production window edge is where listOrders puts it");
});

test("the stamp changes with every row the payload is read from, and only with those", async () => {
  const o = await order({ status: "preparing" }, 3);
  const prep: OrderListFilters = { status: ["new", "preparing"], stockStatus: "ok" };
  const items = await prisma.orderItem.findMany({ where: { orderId: o.id }, orderBy: { requiredQuantity: "asc" } });
  let last = await orderListStamp(prep);
  const changed = async (what: string, change: () => Promise<unknown>, expect = true) => {
    await change();
    const next = await orderListStamp(prep);
    assert.equal(next !== last, expect, `${what}: ${expect ? "changes" : "keeps"} the stamp`);
    last = next;
  };
  await changed("nothing", async () => {}, false);
  await changed("an order column", () => prisma.order.update({ where: { id: o.id }, data: { notes: `${TAG} ملاحظة` } }));
  await changed("a line quantity", () => prisma.orderItem.update({ where: { id: items[0].id }, data: { preparedQuantity: 9.5 } }));
  await changed("a line written without @updatedAt", () => prisma.$executeRaw`UPDATE "OrderItem" SET "notes" = ${TAG} WHERE "id" = ${items[1].id}`);
  await changed("a new line", () => prisma.orderItem.create({ data: { orderId: o.id, productName: `${TAG} زيادة`, unit: "KG", requiredQuantity: 1 } }));
  await changed("a line removed", () => prisma.orderItem.delete({ where: { id: items[2].id } }));
  await changed("the customer card renamed", () => prisma.customer.update({ where: { id: customerId }, data: { name: `${TAG} Hotel 2` } }));
  await changed("the card's Arabic name", () => prisma.customer.update({ where: { id: customerId }, data: { nameAr: `${TAG} فندق ٢` } }));
  await changed("the order leaves the board", () => prisma.order.update({ where: { id: o.id }, data: { status: "ready_for_loading" } }));
  await changed("an order outside the list", () => prisma.order.update({ where: { id: o.id }, data: { notes: `${TAG} تاني` } }), false);
  await changed("the order comes back", () => prisma.order.update({ where: { id: o.id }, data: { status: "preparing" } }));

  // The command center's stamp also follows when an open order entered its status.
  const before = await orderListStamp({}, { stages: true });
  const plain = await orderListStamp({});
  await writeAudit({ userName: TAG, role: "SUPERVISOR", action: "status_changed", entityType: "order", entityId: o.id, orderId: o.id, fieldChanged: "status", oldValue: "new", newValue: "preparing", source: "system" }, prisma);
  assert.notEqual(await orderListStamp({}, { stages: true }), before, "a stage entry changes the intelligence stamp");
  assert.equal(await orderListStamp({}), plain, "…and not the plain list's");
});

test("listOrdersPolled is listOrders: the full list only when the stamp moved, one statement otherwise", async () => {
  const o = await order({ status: "new" });
  const filters: OrderListFilters[] = [{}, { status: ["new", "preparing"], stockStatus: "ok" }, { scope: "production" }, { date: today }];
  for (const f of filters) {
    assert.deepEqual(await listOrdersPolled(f), await listOrders(f), `same rows for ${JSON.stringify(f)}`);
    const { result, queries } = await countQueries(() => listOrdersPolled(f));
    assert.equal(queries, 1, `an unchanged poll is the stamp alone (${JSON.stringify(f)})`);
    assert.deepEqual(result, await listOrders(f));
  }
  await prisma.order.update({ where: { id: o.id }, data: { notes: `${TAG} اتغير` } });
  const { result, queries } = await countQueries(() => listOrdersPolled({}));
  assert.equal(queries, 4, "a changed poll: the stamp, then the list (orders, lines, customer cards)");
  assert.equal(result.find((x) => x.id === o.id)?.notes, `${TAG} اتغير`, "…with the change");
  // A search is never served from the last poll.
  const q = `${TAG}-${n}`;
  assert.deepEqual(await listOrdersPolled({ q }), await listOrders({ q }));
});

test("the command center: same orders and intelligence as before, the clock applied on every poll", async () => {
  await order({ status: "preparing" });
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    const orders = await listOrders({});
    const reference = { orders, intelligence: { ...(await getOperationalIntelligence(orders)), generatedAt: null } };
    const got = await boardWithIntelligence();
    assert.deepEqual({ orders: got.orders, intelligence: { ...got.intelligence, generatedAt: null } }, reference);
    const { result, queries } = await countQueries(() => boardWithIntelligence());
    assert.ok(queries <= 2, `an unchanged poll is the stamp (+ a settings read at most), got ${queries}`);
    // Minutes in stage move with the clock even when no row changed.
    Date.now = () => frozen + 3 * 3_600_000;
    const later = await boardWithIntelligence();
    const one = later.intelligence.orders[0];
    assert.ok(one, "an open order is classified");
    const earlier = result.intelligence.orders.find((x) => x.id === one.id)!;
    assert.equal(one.minutesInStage, earlier.minutesInStage + 180, "three hours later, three hours more in stage");
  } finally {
    Date.now = realNow;
  }
});

test("lighter list rows (PS-4): every order and line column, no catalogue names; the detail keeps them", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} Mango`, nameAr: `${TAG} مانجو`, unit: "KG" } });
  const o = await order({ status: "new" }, 1);
  await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { stockProductId: p.id } });
  const listed = (await listOrders({})).find((x) => x.id === o.id)!;
  const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { items: true, customerAccount: { select: { name: true, nameAr: true, code: true } } } });
  assert.deepEqual(listed, row, "the list row is the order, its lines and the customer card names");
  assert.equal("stockProduct" in listed.items[0], false);
  const detail = await getOrder(o.id);
  assert.deepEqual(detail.items[0].stockProduct, { name: `${TAG} Mango`, nameAr: `${TAG} مانجو` }, "the order detail still carries them");
});

test("daily production and the daily summary: the same figures from fewer queries", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} Guava`, nameAr: `${TAG} جوافة`, unit: "KG" } });
  const o = await order({ status: "preparing" }, 2);
  await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { stockProductId: p.id, preparedQuantity: 3 } });
  // The production totals as they were computed from the full orders (reference).
  const full = await prisma.order.findMany({ where: productionScope(), include: { items: { include: { stockProduct: { select: { name: true, nameAr: true } } } } } });
  const byKey = new Map<string, { productName: string; productNameEn: string | null; productNameAr: string | null; unit: string; required: number; prepared: number; orders: Set<string> }>();
  for (const ord of full) for (const i of ord.items) {
    const k = `${i.productName}__${i.unit}`;
    const agg = byKey.get(k) ?? { productName: i.productName, productNameEn: null, productNameAr: null, unit: i.unit, required: 0, prepared: 0, orders: new Set<string>() };
    if (!agg.productNameEn && !agg.productNameAr && i.stockProduct) { agg.productNameEn = i.stockProduct.name || null; agg.productNameAr = i.stockProduct.nameAr || null; }
    agg.required += i.requiredQuantity; agg.prepared += i.preparedQuantity ?? 0; agg.orders.add(ord.id); byKey.set(k, agg);
  }
  const key = (r: { productName: string; unit: string }) => `${r.productName}__${r.unit}`;
  // Each row also carries its group key, and sums are rounded to the 3 decimals quantities have
  // (lib/production.ts aggregateProduction, shared with the production board — PC-5/UXO-13).
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const expected = [...byKey.values()].map(({ orders, ...r }) => ({ key: key(r), ...r, required: round3(r.required), prepared: round3(r.prepared), orderCount: orders.size })).sort((a, b) => key(a).localeCompare(key(b)));
  const { result, queries } = await countQueries(() => dailyProduction());
  assert.equal(queries, 2, "lines and their product names");
  assert.deepEqual([...result].sort((a, b) => key(a).localeCompare(key(b))), expected);
  assert.ok(result.every((r, i) => i === 0 || result[i - 1].required >= r.required), "largest first");

  const summary = await countQueries(() => dailyOperationsSummary());
  assert.ok(summary.queries <= 6, `daily summary: today's orders, open orders, stage entries (+ settings), got ${summary.queries}`);
  assert.ok(summary.result.pipelineNow.preparing >= 1);
});
