/* One floor tap, one transaction (PM-8, Nov 2026). A preparer's or loader's tap sends the quantity
   and "done" together; it used to run two transactions (~20 round trips). recordPrepared /
   recordLoaded must leave exactly what the two-step path leaves — the line, both audit rows, the
   order's shortage / review flags and the shortage approval — with one version step instead of two,
   refuse exactly what it refused, and cost the same at 5 lines as at 50. Synthetic orders. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { ApiError } from "@/lib/rbac";
import { markItemLoaded, markItemPrepared, recordLoaded, recordPrepared, setLoadedQuantity, setPreparedQuantity } from "@/lib/orders-service";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZTAP${Date.now()}`;
const ids: Record<string, string> = {};
let n = 0;
let preparer: ReturnType<typeof as>, loader: ReturnType<typeof as>;
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role] as string[], ids[username], role), source: "user" as const });

async function order(status: string, lines: number) {
  n++;
  return prisma.order.create({
    data: {
      orderNumber: `${TAG}-${n}`, customerName: `${TAG} عميل`, deliveryDate: todayLocalISO(), status,
      items: { create: Array.from({ length: lines }, (_, i) => ({ productName: `${TAG} صنف ${i + 1}`, unit: "KG", requiredQuantity: 10, preparedQuantity: status === "loading" ? 10 : null, preparationStatus: status === "loading" ? "done" : "pending" })) },
    },
    include: { items: { orderBy: { productName: "asc" } } },
  });
}
/** What a tap leaves behind, comparable between two orders. */
async function outcome(orderId: string, itemId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { shortage: true, needsReview: true, version: true } });
  const i = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
  const audit = await prisma.auditLog.findMany({ where: { orderId }, orderBy: [{ timestamp: "asc" }, { id: "asc" }], select: { action: true, entityType: true, entityId: true, fieldChanged: true, oldValue: true, newValue: true, reason: true, userId: true, userName: true, role: true, source: true } });
  const approvals = await prisma.approvalRequest.findMany({ where: { type: "orders.shortage", entityId: orderId }, select: { status: true, summary: true, payload: true } });
  const lines = (approvals[0]?.payload as { lines?: { id: string }[] } | undefined)?.lines?.map(({ id: _id, ...l }) => l);
  return {
    order: o,
    item: { preparedQuantity: i.preparedQuantity, preparationStatus: i.preparationStatus, loadedQuantity: i.loadedQuantity, loadingStatus: i.loadingStatus, notes: i.notes },
    // The same rows; their order within the tap is not compared: the line's two rows are written
    // together now, so a shortage approval raised by the tap follows both instead of sitting
    // between them. Document numbers and the approval's own id differ between the two orders.
    audit: audit
      .map((a) => ({ ...a, entityId: a.entityId === itemId ? "<item>" : a.entityType === "approval_request" ? "<approval>" : a.entityId, newValue: a.newValue?.replace(/APR-\d{4}-\d+ · [^·]+ · /, "<approval> · ") ?? null }))
      .sort((x, y) => x.action.localeCompare(y.action)),
    approvals: approvals.map((a) => ({ status: a.status, summary: a.summary, lines })),
  };
}
async function rejects(p: Promise<unknown>, status: number, message?: RegExp) {
  await assert.rejects(p, (err: unknown) => err instanceof ApiError && err.status === status && (!message || message.test(err.message)));
}

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  preparer = as("ahmed", "PREPARER", "أحمد تجهيز");
  loader = as("mostafa", "LOADER", "مصطفى تحميل");
});
after(async () => {
  await prisma.$disconnect();
});

for (const [label, qty] of [["within tolerance", 10], ["a shortage that needs the supervisor", 4]] as const) {
  test(`prepare tap, ${label}: the same result as quantity-then-done, one version step`, async () => {
    const a = await order("preparing", 3), b = await order("preparing", 3);
    const ia = a.items[0], ib = b.items[0];
    const item = await recordPrepared(a.id, ia.id, qty, preparer, { expectedVersion: ia.version, note: `${TAG} ملاحظة` });
    await setPreparedQuantity(b.id, ib.id, qty, preparer, { expectedVersion: ib.version, note: `${TAG} ملاحظة` });
    await markItemPrepared(b.id, ib.id, preparer);
    assert.deepEqual(await outcome(a.id, ia.id), await outcome(b.id, ib.id));
    assert.equal(item.version, ia.version + 1, "one compare-and-swap step");
    assert.deepEqual([item.preparedQuantity, item.preparationStatus, item.notes], [qty, "done", `${TAG} ملاحظة`], "the route returns the updated line");
    const rows = await prisma.auditLog.findMany({ where: { orderId: a.id, entityType: "order_item" }, orderBy: { id: "asc" }, select: { action: true, timestamp: true } });
    assert.deepEqual(rows.map((x) => x.action), ["prepared_quantity_set", "item_marked_prepared"], "both rows, in the tap's order");
  });

  test(`load tap, ${label}: the same result as quantity-then-done`, async () => {
    const a = await order("loading", 3), b = await order("loading", 3);
    const ia = a.items[0], ib = b.items[0];
    const item = await recordLoaded(a.id, ia.id, qty, loader, { expectedVersion: ia.version });
    await setLoadedQuantity(b.id, ib.id, qty, loader, { expectedVersion: ib.version });
    await markItemLoaded(b.id, ib.id, loader);
    assert.deepEqual(await outcome(a.id, ia.id), await outcome(b.id, ib.id));
    assert.deepEqual([item.loadedQuantity, item.loadingStatus, item.version], [qty, "done", ia.version + 1]);
  });
}

test("a tap is refused exactly as before, and a refused tap writes nothing", async () => {
  const o = await order("new", 2);
  const i = o.items[0];
  await rejects(recordPrepared(o.id, i.id, 5, preparer), 409, /مينفعش تسجّل كمية تجهيز/);
  await rejects(recordLoaded(o.id, i.id, 5, loader), 409, /مينفعش تسجّل كمية تحميل/);
  await prisma.order.update({ where: { id: o.id }, data: { status: "preparing" } });
  await rejects(recordPrepared(o.id, i.id, 5, preparer, { expectedVersion: i.version + 3 }), 409, /اتغيّر من واحد تاني/);
  await rejects(recordPrepared(o.id, i.id, -1, preparer), 400);
  await rejects(recordPrepared(o.id, i.id, 1.23456, preparer), 400);
  await rejects(recordPrepared(o.id, i.id, 5, loader), 403);
  await rejects(recordPrepared(o.id, "nope", 5, preparer), 404);
  await rejects(recordPrepared(o.id, (await order("preparing", 1)).items[0].id, 5, preparer), 404, /الصنف مش موجود/);
  const after = await prisma.orderItem.findUniqueOrThrow({ where: { id: i.id } });
  assert.deepEqual([after.preparedQuantity, after.preparationStatus, after.version], [null, "pending", i.version]);
  assert.equal(await prisma.auditLog.count({ where: { orderId: o.id } }), 0);
});

test("a tap costs the same at 5 lines as at 50, and fewer statements than the two-step path", async () => {
  const warm = await order("preparing", 1);
  await recordPrepared(warm.id, warm.items[0].id, 10, preparer); // settings cache
  const cost = async (lines: number) => {
    const o = await order("preparing", lines);
    return (await countQueries(() => recordPrepared(o.id, o.items[0].id, 10, preparer, { expectedVersion: o.items[0].version }))).queries;
  };
  const five = await cost(5), fifty = await cost(50);
  assert.equal(five, fifty, "constant in the number of lines");
  const o = await order("preparing", 5);
  const twoStep = (await countQueries(async () => {
    await setPreparedQuantity(o.id, o.items[0].id, 10, preparer);
    await markItemPrepared(o.id, o.items[0].id, preparer);
  })).queries;
  assert.ok(five <= 11 && five < twoStep, `one tap: ${five} statements (two-step path: ${twoStep})`);
});
