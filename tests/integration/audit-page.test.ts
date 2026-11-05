/* The audit log page (PC-9, Nov 2026): the total is the same as a full count, but a page that is
   not full — a search with few hits, an order's timeline — no longer repeats the search to count
   it. Statement counts are asserted with the shared counter. */
import { countQueries } from "./_query-count";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./_db";
import { auditPage } from "@/app/api/audit/query";

after(() => prisma.$disconnect());

const TAG = `ZZAUDITPAGE-${Date.now()}`;
const where = { reason: { contains: TAG, mode: "insensitive" as const } };

test("the same total as a count, and the count is run only for a full page or one past the end", async () => {
  await prisma.auditLog.createMany({
    data: Array.from({ length: 3 }, (_, i) => ({ userName: "audit-page-test", role: "ADMIN", action: "test_recorded", entityType: "settings", entityId: `${TAG}-${i}`, reason: `${TAG} row ${i}`, source: "system", timestamp: new Date(Date.now() - i * 1000) })),
  });
  try {
    const counted = await prisma.auditLog.count({ where });
    assert.equal(counted, 3);

    // A search with fewer hits than a page: the rows only (no count).
    const short = await countQueries(() => auditPage(where, 50, 0));
    assert.equal(short.result.total, 3);
    assert.equal(short.result.rows.length, 3);
    assert.equal(short.queries, 1, "the page alone — the search is not run a second time to count it");

    // The last, partly filled page of several: still no count.
    const last = await countQueries(() => auditPage(where, 2, 2));
    assert.equal(last.result.total, 3);
    assert.deepEqual(last.result.rows.map((r) => r.entityId), [`${TAG}-2`]);
    assert.equal(last.queries, 1);

    // A full page cannot tell what follows it: the count runs, as before.
    const full = await countQueries(() => auditPage(where, 2, 0));
    assert.equal(full.result.total, 3);
    assert.deepEqual(full.result.rows.map((r) => r.entityId), [`${TAG}-0`, `${TAG}-1`], "newest first");
    assert.equal(full.queries, 2);

    // Past the end: no rows, and the total is still the real one.
    const past = await countQueries(() => auditPage(where, 2, 10));
    assert.equal(past.result.total, 3);
    assert.equal(past.result.rows.length, 0);
    assert.equal(past.queries, 2);

    // Nothing matches: total 0 without a count.
    const none = await countQueries(() => auditPage({ reason: { contains: `${TAG}-nothing` } }, 50, 0));
    assert.equal(none.result.total, 0);
    assert.equal(none.queries, 1);
  } finally {
    await prisma.auditLog.deleteMany({ where: { reason: { contains: TAG } } });
  }
});

test("a page expected to be full counts alongside it, with the same rows and total", async () => {
  await prisma.auditLog.createMany({
    data: Array.from({ length: 3 }, (_, i) => ({ userName: "audit-page-test", role: "ADMIN", action: "test_recorded", entityType: "settings", entityId: `${TAG}-p${i}`, reason: `${TAG} parallel ${i}`, source: "system", timestamp: new Date(Date.now() - i * 1000) })),
  });
  const pw = { reason: { contains: `${TAG} parallel`, mode: "insensitive" as const } };
  try {
    for (const [limit, offset] of [[50, 0], [2, 0], [2, 2], [2, 10]] as const) {
      const pageFirst = await auditPage(pw, limit, offset);
      const together = await countQueries(() => auditPage(pw, limit, offset, { likelyShort: false }));
      assert.equal(together.result.total, 3);
      assert.equal(together.result.total, pageFirst.total, `same total (limit ${limit}, offset ${offset})`);
      assert.deepEqual(together.result.rows.map((r) => r.id), pageFirst.rows.map((r) => r.id), "same rows, same order");
      assert.equal(together.queries, 2, "the count always runs, sent with the page");
    }
  } finally {
    await prisma.auditLog.deleteMany({ where: { reason: { contains: `${TAG} parallel` } } });
  }
});

test("rows linked to an order carry its number and customer, as before", async () => {
  const order = await prisma.order.findFirst({ select: { id: true, orderNumber: true, customerName: true } });
  assert.ok(order, "the seed (prisma/seed.ts) has orders");
  await prisma.auditLog.create({ data: { userName: "audit-page-test", role: "ADMIN", action: "test_recorded", entityType: "order", entityId: order.id, orderId: order.id, reason: `${TAG} linked`, source: "system" } });
  try {
    const { result, queries } = await countQueries(() => auditPage({ reason: { contains: `${TAG} linked` } }, 50, 0));
    assert.equal(result.total, 1);
    assert.deepEqual(result.rows[0].order, { orderNumber: order.orderNumber, customerName: order.customerName });
    assert.equal(queries, 2, "the page and its orders — no count");
  } finally {
    await prisma.auditLog.deleteMany({ where: { reason: { contains: `${TAG} linked` } } });
  }
});
