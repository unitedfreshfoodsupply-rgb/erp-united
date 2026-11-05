/* Posting many entries at once (Nov 2026): approving a large opening batch posted its open items
   one by one, ~16 round trips each, and ran past the 20 s transaction limit on production
   latency. The batched paths must write exactly what the one-by-one paths write — numbers in
   order and gapless, the same lines and audit rows, the same refusals — in a fixed number of
   statements. Every scenario runs in a transaction that is rolled back at the end, after the
   deferred constraints (entry balance) have been checked, so it leaves nothing behind. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor, withSetting } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber, nextDocumentNumbers } from "@/lib/core/sequences";
import { newId } from "@/lib/core/ids";
import { postJournal, postJournals } from "@/lib/accounting/ledger";
import { postPartyOpeningInTx, postPartyOpeningsInTx } from "@/lib/accounting/integrity";
import { createCustomer } from "@/lib/sales/customers";
import { createSupplierFull } from "@/lib/purchasing/suppliers";

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const DAY = "2032-04-10"; // a year no fixture uses, so counters start clean
const today = todayLocalISO();
const acc = actor("محاسب", ["accounting.manage"], null, "ACCOUNTANT");
const run = (n: string) => Number(n.split("-").pop());
const TAG = `ZZBULK${Date.now()}`;
const master = actor("بيانات أساسية", ["sales.customers.view", "sales.customers.manage", "purchasing.suppliers.view", "purchasing.suppliers.manage"], "bulk-master");
const customer = (n: number) => createCustomer({ name: `${TAG} عميل ${n}` }, master as never);
const supplier = (n: number) => createSupplierFull({ name: `${TAG} مورد ${n}`, category: "vegetable" }, master as never);

after(async () => {
  await prisma.$executeRaw`DELETE FROM "NumberSequenceCounter" WHERE "period" = '2032'`;
  await prisma.$disconnect();
});

class Rollback extends Error {}
/** Runs `fn` in an inTx transaction, checks the deferred constraints, then rolls everything back. */
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  await assert.rejects(inTx(async (tx) => { await fn(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; throw new Rollback(); }), (e) => { if (e instanceof Rollback) return true; throw e; });
}

test("ids made in the application: cuid-shaped, distinct", () => {
  const ids = Array.from({ length: 5000 }, newId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids.slice(0, 50)) assert.match(id, /^c[0-9a-z]{24}$/);
});

test("a block of numbers: consecutive, in order, continues the sequence, never overlaps a concurrent allocation", async () => {
  const first = await inTx((tx) => nextDocumentNumber(tx, "accounting.journal", DAY));
  const block = await inTx((tx) => nextDocumentNumbers(tx, "accounting.journal", DAY, 5));
  assert.deepEqual(block.map(run), [1, 2, 3, 4, 5].map((i) => run(first) + i));
  assert.match(block[0], /^JE-2032-\d{5}$/);
  const all = await Promise.all([
    ...Array.from({ length: 8 }, () => inTx((tx) => nextDocumentNumbers(tx, "accounting.journal", DAY, 5))),
    ...Array.from({ length: 8 }, () => inTx(async (tx) => [await nextDocumentNumber(tx, "accounting.journal", DAY)])),
  ]);
  for (const b of all) for (let i = 1; i < b.length; i++) assert.equal(run(b[i]), run(b[i - 1]) + 1, "a block is contiguous");
  const runs = all.flat().map(run).sort((a, b) => a - b);
  assert.deepEqual(runs, Array.from({ length: 48 }, (_, i) => run(block[4]) + 1 + i), "48 distinct numbers, no gaps");
  // A rolled-back block burns nothing.
  const before = await inTx((tx) => nextDocumentNumber(tx, "accounting.journal", DAY));
  await assert.rejects(inTx(async (tx) => { await nextDocumentNumbers(tx, "accounting.journal", DAY, 10); throw new Error("save failed"); }));
  assert.equal(run(await inTx((tx) => nextDocumentNumber(tx, "accounting.journal", DAY))), run(before) + 1);
  await assert.rejects(inTx((tx) => nextDocumentNumbers(tx, "accounting.journal", DAY, 0)), /positive integer/);
});

test("postJournals writes what postJournal writes, numbered in input order, and refuses what it refuses", async () => {
  const c = await customer(0);
  const entry = (i: number, amount: string) => ({
    date: today, description: `bulk ${i}`, sourceType: "opening_balance" as const, sourceId: `bulk-test-${i}-${Date.now()}`,
    lines: [{ key: "ar" as const, amount: D(amount), party: { type: "customer" as const, id: c.id } }, { key: "opening_equity" as const, amount: D(amount).negated() }],
  });
  await rolledBack(async (tx) => {
    const one = await postJournal(tx, entry(0, "10.005"), acc);
    const inputs = [entry(1, "100.10"), entry(2, "0.001"), entry(3, "-250.00"), entry(4, "7")];
    const many = await postJournals(tx, inputs, acc);
    assert.equal(many[1], null, "an entry whose lines round to zero posts nothing, like postJournal");
    const posted = many.filter((e): e is NonNullable<typeof e> => !!e);
    assert.deepEqual(posted.map((e) => run(e.number)), [1, 2, 3].map((i) => run(one!.number) + i), "numbers follow on, in input order");
    const rows = await tx.journalEntry.findMany({ where: { id: { in: [one!.id, ...posted.map((e) => e.id)] } }, include: { lines: { orderBy: { debit: "desc" } } }, orderBy: { number: "asc" } });
    const shape = (e: (typeof rows)[number]) => ({ lines: e.lines.map((l) => [l.accountId, l.debit.toFixed(2), l.credit.toFixed(2), l.partyType, l.partyId, l.description]) });
    for (const r of rows) assert.deepEqual([r.sourceType, r.date, r.createdBy, r.requestHash, r.reversalOfId], ["opening_balance", today, acc.name, null, null]);
    assert.deepEqual(rows.map((e) => e.description), ["bulk 0", "bulk 1", "bulk 3", "bulk 4"]);
    assert.deepEqual(shape(rows[0]).lines.map((l) => l.slice(1)), [["10.01", "0.00", "customer", c.id, null], ["0.00", "10.01", null, null, null]], "rounded to cents like before");
    assert.deepEqual(shape(rows[2]).lines.map((l) => l.slice(1, 3)), [["250.00", "0.00"], ["0.00", "250.00"]], "a negative amount reverses the sides");
    const audits = await tx.auditLog.findMany({ where: { action: "journal_posted", entityId: { in: rows.map((r) => r.id) } } });
    assert.equal(audits.length, 4, "one journal_posted row per entry");
    for (const r of rows) assert.equal(audits.find((a) => a.entityId === r.id)?.newValue, `opening_balance · ${r.total.toFixed(2)} · ${r.description}`);
    assert.deepEqual(await postJournals(tx, [], acc), []);
    await assert.rejects(postJournals(tx, [entry(5, "1"), { ...entry(6, "1"), lines: [{ key: "ar", amount: D(1), party: { type: "customer", id: c.id } }] }], acc), /unbalanced posting/);
  });
  // A lock date refuses the whole call, as postJournal refuses its one entry.
  const restore = await withSetting("accounting.lock_date", today);
  try {
    await assert.rejects(inTx((tx) => postJournals(tx, [entry(7, "1")], acc)), (e: any) => e?.code === "accounting_lock_date");
    await assert.rejects(inTx((tx) => postJournal(tx, entry(8, "1"), acc)), (e: any) => e?.code === "accounting_lock_date");
  } finally { await restore(); }
});

test("postPartyOpeningsInTx writes what postPartyOpeningInTx writes, item by item; a missing party refuses all", async () => {
  const [c1, c2, s1] = [await customer(1), await customer(2), await supplier(1)];
  const item = (partyType: "customer" | "supplier", partyId: string, amount: string, reference: string | null) =>
    ({ partyType, partyId, date: today, dueDate: today, amount: D(amount), reference, counterKey: "opening_equity" as const });
  const effect = async (tx: Tx, rowId: string) => {
    const row = await tx.partyOpeningBalance.findUniqueOrThrow({ where: { id: rowId } });
    const e = await tx.journalEntry.findFirstOrThrow({ where: { sourceType: "opening_balance", sourceId: rowId }, include: { lines: { include: { account: { select: { systemKey: true } } } } } });
    const audit = await tx.auditLog.findFirstOrThrow({ where: { action: "opening_balance_recorded", entityId: rowId } });
    return {
      row: [row.partyType, row.partyId, row.amount.toFixed(2), row.date, row.dueDate, row.reference, row.createdBy, row.openingBatchId],
      entry: [e.description, e.total.toFixed(2), e.lines.map((l) => [l.account.systemKey, l.debit.toFixed(2), l.credit.toFixed(2), l.partyType, l.partyId]).sort()],
      audit: [audit.fieldChanged, audit.newValue, audit.userName],
      journalAudits: await tx.auditLog.count({ where: { action: "journal_posted", entityId: e.id } }),
    };
  };
  await rolledBack(async (tx) => {
    const items = [item("customer", c1.id, "1500.25", null), item("supplier", s1.id, "-80", "دفعة مقدمة"), item("customer", c2.id, "42", "OPN-X#3"), item("customer", c1.id, "1", "تاني")];
    const ids = await postPartyOpeningsInTx(tx, items, acc as never);
    assert.equal(ids.length, 4);
    const single = await postPartyOpeningInTx(tx, item("supplier", s1.id, "-80", "دفعة مقدمة"), acc as never);
    assert.deepEqual(await effect(tx, ids[1]), await effect(tx, single.id), "the batched item and the single one are written alike");
    const first = await effect(tx, ids[0]);
    assert.deepEqual(first.entry, [`رصيد افتتاحي — ${c1.name}`, "1500.25", [["ar", "1500.25", "0.00", "customer", c1.id], ["opening_equity", "0.00", "1500.25", null, null]]]);
    assert.equal(first.journalAudits, 1);
    const numbers = (await tx.journalEntry.findMany({ where: { sourceType: "opening_balance", sourceId: { in: ids } }, select: { sourceId: true, number: true } }));
    const inOrder = ids.map((id) => run(numbers.find((n) => n.sourceId === id)!.number));
    assert.deepEqual(inOrder, inOrder.map((_, i) => inOrder[0] + i), "entries numbered in item order");
    assert.deepEqual(await postPartyOpeningsInTx(tx, [], acc as never), []);
  });
  // One unknown party: nothing at all is written.
  const count = await prisma.partyOpeningBalance.count();
  await assert.rejects(inTx((tx) => postPartyOpeningsInTx(tx, [item("customer", c1.id, "5", null), item("supplier", "no-such-supplier", "5", null)], acc as never)), (e: any) => e?.status === 404 && /المورد مش موجود/.test(e.message));
  assert.equal(await prisma.partyOpeningBalance.count(), count);
});
