/* Settings read inside a transaction (Nov 2026): once the shared cache had expired, every
   getSetting in a long posting transaction was one more query (the lock date twice per posting
   call). A transaction now keeps what it read for its own rest — and drops it on a write, so it
   still sees its own uncommitted change. */
import { countQueries } from "./_query-count";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, inTx, actor } from "./_db";
import { getSetting, invalidateSettingsCache, updateSetting } from "@/lib/core/settings-service";

const KEY = "orders.stalled_minutes" as const;
const admin = actor("مدير النظام", ["settings.manage"], null, "ADMIN");
after(async () => { await prisma.$disconnect(); });

class Rollback extends Error {}

test("a transaction reads the settings once, then again only after a write", async () => {
  invalidateSettingsCache();
  const original = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  await assert.rejects(inTx(async (tx) => {
    invalidateSettingsCache();
    const first = await countQueries(async () => [await getSetting(KEY), await getSetting("accounting.lock_date"), await getSetting(KEY)]);
    assert.equal(first.queries, 1, "one read for the whole transaction");
    const again = await countQueries(() => getSetting(KEY));
    assert.equal(again.queries, 0);
    // A write in this transaction (a script or test writing the table) followed by the documented invalidation.
    const changed = (Number(first.result[0]) || 0) + 7;
    await tx.systemSetting.upsert({ where: { key: KEY }, update: { value: changed, version: { increment: 1 }, updatedBy: "test" }, create: { key: KEY, value: changed, updatedBy: "test" } });
    invalidateSettingsCache();
    assert.equal(await getSetting(KEY), changed, "the transaction sees its own write");
    throw new Rollback();
  }), Rollback);
  invalidateSettingsCache();
  assert.deepEqual((await prisma.systemSetting.findUnique({ where: { key: KEY } }))?.value ?? null, original?.value ?? null, "rolled back");
});

test("outside a transaction the shared cache still applies, and updateSetting clears it", async () => {
  invalidateSettingsCache();
  const before = await getSetting(KEY);
  const hadRow = !!(await prisma.systemSetting.findUnique({ where: { key: KEY } }));
  const cached = await countQueries(() => getSetting(KEY));
  assert.equal(cached.queries, 0);
  const next = Number(before) + 1;
  try {
    await updateSetting(KEY, next, admin as never, { reason: "اختبار" });
    assert.equal(await getSetting(KEY), next);
    // A transaction opened after the change reads the new value too.
    invalidateSettingsCache();
    assert.equal(await inTx(() => getSetting(KEY)), next);
  } finally {
    await updateSetting(KEY, hadRow ? before : null, admin as never, { reason: "اختبار — رجوع" });
  }
  assert.equal(await getSetting(KEY), before);
});
