/* The phased opening migration (Nov 2026), service level, on the test database.
   Suppliers first, then customers, then the rest: each phase batch is approved by a second
   person and posts against the provisional clearing account 3900; the parties' balances are in
   their sub-ledgers at once; nothing balances a batch with an invented figure; a source row
   posts once; unmatched rows wait in the exception register; the migration closes only when
   every check passes and someone other than the requester approves. Synthetic data only.
   A migration is permanent and closes the direct opening forms, so this file runs last
   ("zz-") and, on a database where the opening is already done, only checks that it stays closed.
   When this run started the migration, it removes what it wrote, by id, at the end (see cleanUp),
   so the suites can run again without a test:reset. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, withSetting } from "./_db";
import { todayLocalISO } from "@/lib/localDate";
import { createSupplierFull } from "@/lib/purchasing/suppliers";
import { createCustomer } from "@/lib/sales/customers";
import { createBatch, addLines, submitBatch, validateBatch } from "@/lib/accounting/opening-batches";
import { attest, importPartyRows, listExceptions, migrationOverview, openingPosition, requestClosure, resolveException, startMigration, ATTESTATIONS } from "@/lib/accounting/opening-migration";
import { createManualJournal } from "@/lib/accounting/ledger";
import { createOpeningBalance } from "@/lib/accounting/integrity";
import { decideApproval } from "@/lib/core/approval-handlers";

const TAG = `ZZOPM${Date.now()}`;
const FILE = `${TAG} مراجعه موردين.xlsx`;
const SHA = "cfcbf0731e598e94549e876d4328a57c2a8246f8fc1a275e1539451657769ca0";
// Real users of the test database (approvals notify their requester), with exactly these permissions.
let prep = actor("محاسب التجهيز", ["accounting.view", "accounting.manage", "accounting.opening.approve"], null, "ACCOUNTANT");
let checker = actor("المراجع", ["accounting.view", "accounting.opening.approve"], null, "ACCOUNTANT");
const buyer = actor("مشتريات", ["purchasing.suppliers.view", "purchasing.suppliers.manage"], "opm-buyer");
const sales = actor("مبيعات", ["sales.customers.view", "sales.customers.manage"], "opm-sales");
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const status = (s: number) => (e: any) => e?.status === s;

// What this run wrote, by id (filled as the run creates it). The clean-up deletes only these rows
// and what hangs off them, never "everything since a time": the test database can be shared with
// a dev server or another suite, and their rows are not this file's to delete.
const mine = { migrationId: null as string | null, batches: new Set<string>(), suppliers: new Set<string>(), customers: new Set<string>(), products: new Set<string>() };
let orphansBefore: Map<string, number> | null = null;

/** Rows whose single-column foreign key points at nothing, per constraint (public schema). */
async function fkOrphans(db: Pick<typeof prisma, "$queryRawUnsafe"> = prisma) {
  const fks = await db.$queryRawUnsafe<{ conname: string; child: string; col: string; parent: string; pcol: string }[]>(`
    SELECT c.conname, cl.relname AS child, a.attname AS col, pcl.relname AS parent, pa.attname AS pcol
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_class pcl ON pcl.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND ns.nspname = 'public' AND array_length(c.conkey, 1) = 1`);
  const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
  const out = new Map<string, number>();
  for (const f of fks) {
    const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${q(f.child)} x WHERE x.${q(f.col)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(f.parent)} p WHERE p.${q(f.pcol)} = x.${q(f.col)})`);
    if (Number(r.n)) out.set(f.conname, Number(r.n));
  }
  return out;
}

// The append-only and frozen-record guards this run's rows sit behind (user triggers only).
const GUARDED = ["JournalEntry", "JournalLine", "PartyOpeningBalance", "OpeningMigration", "OpeningBatch", "OpeningBatchLine", "OpeningException", "StockMovement", "StockValuationLayer", "StockValuationPosting"];

/**
 * Test hygiene: the database refuses to delete a migration, its posted entries, stock movements
 * and so on (append-only triggers), as it must. On the test database those user triggers are
 * disabled on the guarded tables for one transaction (and enabled again before it commits); the
 * foreign keys stay on, so a child this list misses fails the clean-up loudly instead of being
 * orphaned. Deleted by id: the migration, its batches, lines, exceptions, opening balances,
 * journal entries, stock, approvals, notifications, audit rows, and the parties and product the
 * run created. Number sequences keep their advanced counters.
 */
async function cleanUp() {
  await prisma.$transaction(async (tx) => {
    for (const t of GUARDED) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    const batches = (await tx.openingBatch.findMany({ where: { OR: [{ id: { in: [...mine.batches] } }, ...(mine.migrationId ? [{ migrationId: mine.migrationId }] : [])] }, select: { id: true, entryIds: true } }));
    const batchIds = batches.map((b) => b.id);
    const lineIds = (await tx.openingBatchLine.findMany({ where: { batchId: { in: batchIds } }, select: { id: true } })).map((l) => l.id);
    const openingIds = (await tx.partyOpeningBalance.findMany({ where: { openingBatchId: { in: batchIds } }, select: { id: true } })).map((o) => o.id);
    const exceptionIds = mine.migrationId ? (await tx.openingException.findMany({ where: { migrationId: mine.migrationId }, select: { id: true } })).map((e) => e.id) : [];
    const productIds = [...mine.products];
    const docIds = (await tx.inventoryDocument.findMany({ where: { OR: [{ sourceId: { in: batchIds.map((b) => `${b}:stock`) } }, { movements: { some: { productId: { in: productIds } } } }] }, select: { id: true } })).map((d) => d.id);
    const movementIds = (await tx.stockMovement.findMany({ where: { OR: [{ productId: { in: productIds } }, { documentId: { in: docIds } }] }, select: { id: true } })).map((m) => m.id);
    const valuationEntries = (await tx.stockValuationPosting.findMany({ where: { movementId: { in: movementIds } }, select: { entryId: true } })).flatMap((p) => (p.entryId ? [p.entryId] : []));
    const entryIds = (await tx.journalEntry.findMany({
      where: { OR: [
        { id: { in: [...batches.flatMap((b) => (Array.isArray(b.entryIds) ? (b.entryIds as string[]) : [])), ...valuationEntries] } },
        { sourceType: "opening_balance", sourceId: { in: openingIds } },
        ...batchIds.map((b) => ({ sourceType: "opening_batch", sourceId: { startsWith: `${b}:` } })),
      ] },
      select: { id: true },
    })).map((e) => e.id);
    const entityIds = [...(mine.migrationId ? [mine.migrationId] : []), ...batchIds, ...lineIds, ...openingIds, ...exceptionIds, ...docIds, ...entryIds, ...productIds, ...mine.suppliers, ...mine.customers];
    const requestIds = (await tx.approvalRequest.findMany({ where: { entityId: { in: entityIds } }, select: { id: true } })).map((r) => r.id);
    const aliasIds = (await tx.customerAlias.findMany({ where: { customerId: { in: [...mine.customers] } }, select: { id: true } })).map((a) => a.id);
    const everything = [...entityIds, ...requestIds, ...aliasIds];

    await tx.approvalDecision.deleteMany({ where: { requestId: { in: requestIds } } });
    await tx.approvalRequest.deleteMany({ where: { id: { in: requestIds } } });
    await tx.notification.deleteMany({ where: { entityId: { in: everything } } });
    await tx.auditLog.deleteMany({ where: { entityId: { in: everything } } });
    await tx.stockValuationPosting.deleteMany({ where: { movementId: { in: movementIds } } });
    await tx.stockValuationLayer.deleteMany({ where: { movementId: { in: movementIds } } });
    await tx.stockMovement.deleteMany({ where: { id: { in: movementIds } } });
    await tx.stockLot.deleteMany({ where: { productId: { in: productIds } } });
    await tx.inventoryDocument.deleteMany({ where: { id: { in: docIds } } });
    await tx.journalLine.deleteMany({ where: { entryId: { in: entryIds } } });
    await tx.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
    await tx.partyOpeningBalance.deleteMany({ where: { id: { in: openingIds } } });
    await tx.openingBatchLine.deleteMany({ where: { id: { in: lineIds } } });
    await tx.openingException.deleteMany({ where: { id: { in: exceptionIds } } });
    await tx.openingBatch.deleteMany({ where: { id: { in: batchIds } } });
    if (mine.migrationId) await tx.openingMigration.delete({ where: { id: mine.migrationId } });
    await tx.stockProduct.deleteMany({ where: { id: { in: productIds } } });
    await tx.customerAlias.deleteMany({ where: { id: { in: aliasIds } } });
    await tx.customer.deleteMany({ where: { id: { in: [...mine.customers] } } });
    await tx.supplier.deleteMany({ where: { id: { in: [...mine.suppliers] } } });
    for (const t of GUARDED) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
  }, { timeout: 60_000 });
}

after(async () => {
  try {
    if (mine.migrationId || mine.batches.size || mine.suppliers.size || mine.customers.size || mine.products.size) {
      await cleanUp();
      assert.equal(await prisma.openingMigration.count(), 0, "the run's migration is gone, so the next run starts from the same state");
      const now = await fkOrphans();
      const added = [...now].filter(([k, n]) => n > (orphansBefore?.get(k) ?? 0));
      assert.deepEqual(added, [], "the clean-up leaves no row pointing at a deleted one");
    }
  } finally {
    await prisma.$disconnect();
  }
});

const balance = async (systemKey: string) => {
  const [r] = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") AS v FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${systemKey}`;
  return D(r?.v);
};
const pendingRequest = (entityId: string) => prisma.approvalRequest.findFirstOrThrow({ where: { entityId, status: "pending" } });
const approve = async (entityId: string, who: typeof checker = checker) => { const r = await pendingRequest(entityId); return decideApproval(r.id, "approve", who as never, { expectedVersion: r.version }); };

test("phased opening migration: suppliers, customers, the rest, then a second person closes it", async (t) => {
  const already = await prisma.openingMigration.findUnique({ where: { key: "opening" } });
  const initial = await prisma.openingBatch.findFirst({ where: { kind: "initial", status: { not: "cancelled" } } });
  if (already || initial) {
    // The opening is already done on this database (a re-run): it must stay closed to phase batches.
    if (already?.status === "closed") await assert.rejects(createBatch({ kind: "phase", segment: "suppliers" }, prep), status(409));
    t.skip("the opening migration needs a database where the opening has not started (fresh test database)");
    return;
  }
  orphansBefore = await fkOrphans();
  const [u1, u2] = await prisma.user.findMany({ where: { active: true }, orderBy: { username: "asc" }, take: 2, select: { id: true } });
  prep = { ...prep, id: u1.id };
  checker = { ...checker, id: u2.id };
  const today = todayLocalISO();
  const veg1 = await createSupplierFull({ name: `${TAG} عبد العال`, category: "vegetable" }, buyer);
  const veg2 = await createSupplierFull({ name: `${TAG} سعيد نور`, category: "vegetable" }, buyer);
  const veg3 = await createSupplierFull({ name: `${TAG} سيد ليمون`, category: "vegetable" }, buyer);
  const fruit = await createSupplierFull({ name: `${TAG} مزرعة فاكهة`, category: "fruit" }, buyer);
  const customer = await createCustomer({ name: `${TAG} فندق` }, sales);
  for (const s of [veg1, veg2, veg3, fruit]) mine.suppliers.add(s.id);
  mine.customers.add(customer.id);
  const clearing0 = await balance("opening_clearing");
  assert.ok(clearing0.isZero(), "nothing is on the clearing account before the migration");

  // 1. Start: once; the one-batch opening and the direct forms are closed from then on.
  const m = await startMigration({ cutover_date: today, notes: "go-live in phases" }, prep);
  mine.migrationId = m.id;
  assert.equal((await startMigration({ cutover_date: today }, prep)).id, m.id, "a repeat returns the same migration");
  await assert.rejects(startMigration({ cutover_date: "2020-01-31" }, prep), status(409));
  await assert.rejects(createBatch({ kind: "initial", cutover_date: today }, prep), status(409));
  const restore = await withSetting("accounting.direct_opening_entries", true);
  try { await assert.rejects(createOpeningBalance({ party_type: "supplier", party_id: veg1.id, date: today, amount: "10" }, prep), status(409)); } finally { await restore(); }
  await assert.rejects(createBatch({ kind: "phase" }, prep), status(400), "a phase batch names its segment");
  assert.equal((await migrationOverview()).status, "in_progress");

  // 2. Suppliers: a sheet imported by ERP code only; names are evidence, never identity.
  const sb = await createBatch({ kind: "phase", segment: "suppliers", source_file: FILE, source_sha256: SHA, idempotency_key: `${TAG}-sup` }, prep);
  assert.equal((await createBatch({ kind: "phase", segment: "suppliers", source_file: FILE, source_sha256: SHA, idempotency_key: `${TAG}-sup` }, prep)).id, sb.id, "idempotent");
  const rows = [
    { source_row: "3", source_name: "عبد العال", party_code: veg1.code, amount: "265165" },
    { source_row: "4", source_name: "سعيد نور", party_code: veg2.code, amount: "160020" },
    { source_row: "21", source_name: "سيد ليمون", party_code: veg3.code, amount: "0" },
    { source_row: "13", source_name: "اسم بدون كود", amount: "1000" },
    { source_row: "50", source_name: "مورد فاكهة في شيت الخضار", party_code: fruit.code, amount: "500" },
  ];
  const preview = await importPartyRows({ segment: "suppliers", mode: "preview", batch_id: sb.id, source_file: FILE, category: "vegetable", rows }, prep);
  assert.deepEqual([preview.summary.matched, preview.summary.matchedAmount, preview.summary.zero, preview.summary.exceptions, preview.summary.exceptionAmount], [2, "425185.00", 1, 2, "1500.00"]);
  assert.deepEqual(preview.rows.filter((r) => r.outcome === "exception").map((r) => r.reason).sort(), ["category_mismatch", "no_match"], "a fruit supplier is never matched from a vegetable sheet");
  assert.equal(await prisma.openingBatchLine.count({ where: { batchId: sb.id } }), 0, "a preview writes nothing");
  await assert.rejects(importPartyRows({ segment: "suppliers", mode: "preview", source_file: FILE, rows: [rows[0], rows[0]] }, prep), status(400), "a row twice in one sheet");
  const commit = await importPartyRows({ segment: "suppliers", mode: "commit", batch_id: sb.id, source_file: FILE, category: "vegetable", rows }, prep);
  assert.deepEqual([commit.summary.matched, commit.summary.newExceptions], [2, 2]);
  const again = await importPartyRows({ segment: "suppliers", mode: "commit", batch_id: sb.id, source_file: FILE, category: "vegetable", rows }, prep);
  assert.deepEqual([again.summary.matched, again.summary.alreadyInMigration, again.summary.newExceptions], [0, 2, 0], "the same sheet again changes nothing");
  assert.equal(await prisma.openingBatchLine.count({ where: { batchId: sb.id } }), 2);
  const line = await prisma.openingBatchLine.findFirstOrThrow({ where: { batchId: sb.id, lineNo: 1 } });
  assert.deepEqual([(line.data as any).source_file, (line.data as any).source_row, (line.data as any).source_name, (line.data as any).source_amount], [FILE, "3", "عبد العال", "265165"], "the line keeps its source evidence");
  await assert.rejects(addLines(sb.id, { lines: [{ kind: "customer", party_id: customer.id, amount: "10" }] }, prep), status(400), "a supplier batch holds supplier lines only");

  // Validated: balanced by the clearing account, not by an invented figure.
  const v = await validateBatch(sb.id);
  assert.deepEqual(v.problems, []);
  assert.equal(v.clearing, "425185.00");
  assert.equal(v.totals.debit, v.totals.credit);
  assert.ok(v.trialBalance.some((r) => r.provisional && r.account.code === "3900" && r.debit === "425185.00"));

  // 3. Maker-checker: the preparer cannot approve it; a second person posts it once.
  await submitBatch(sb.id, prep);
  await assert.rejects(approve(sb.id, prep), status(403));
  await approve(sb.id);
  assert.equal((await prisma.openingBatch.findUniqueOrThrow({ where: { id: sb.id } })).status, "posted");
  const openings = await prisma.partyOpeningBalance.findMany({ where: { openingBatchId: sb.id }, orderBy: { amount: "desc" } });
  assert.deepEqual(openings.map((o) => [o.partyId, o.amount.toFixed(2), o.date]), [[veg1.id, "265165.00", today], [veg2.id, "160020.00", today]]);
  for (const o of openings) {
    const gl = await prisma.journalLine.aggregate({ where: { partyType: "supplier", partyId: o.partyId }, _sum: { debit: true, credit: true } });
    assert.equal(D(gl._sum.credit).minus(D(gl._sum.debit)).toFixed(2), o.amount.toFixed(2), "the supplier's GL balance equals its opening (statement and aging read it)");
  }
  // Posted together: one entry per line, numbered in line order, each with its audit rows.
  const lineEntries = await prisma.journalEntry.findMany({ where: { sourceType: "opening_balance", sourceId: { in: openings.map((x) => x.id) } }, select: { id: true, number: true, sourceId: true } });
  const numberOf = (partyId: string) => Number(lineEntries.find((e) => e.sourceId === openings.find((x) => x.partyId === partyId)!.id)!.number.split("-").pop());
  assert.equal(numberOf(veg2.id), numberOf(veg1.id) + 1, "line 2's entry follows line 1's");
  assert.equal(await prisma.auditLog.count({ where: { action: "journal_posted", entityId: { in: lineEntries.map((e) => e.id) } } }), 2);
  assert.equal(await prisma.auditLog.count({ where: { action: "opening_balance_recorded", entityId: { in: openings.map((x) => x.id) } } }), 2);
  assert.equal((await balance("opening_clearing")).toFixed(2), "425185.00", "the other side sits on the clearing account, traced below");
  let o = await migrationOverview();
  assert.equal(o.status, "reconciliation_required");
  assert.equal(o.segments!.suppliers.posted.amount, "425185.00");
  assert.deepEqual(o.clearing!.byBatch.map((b) => [b.id, b.movement]), [[sb.id, "425185.00"]]);
  assert.equal(o.clearing!.untraced, "0.00");
  assert.equal((await openingPosition()).final, false, "reports say the opening is provisional");

  // Only migration batches move the clearing account: not a manual journal, not raw SQL.
  await assert.rejects(createManualJournal({ date: today, description: "x", lines: [{ account_id: "acc_3900", debit: "1", credit: "0" }, { account_id: "acc_1100", debit: "0", credit: "1" }] }, prep), status(400));
  await assert.rejects(prisma.journalEntry.create({ data: { number: `JE-2026-9${String(Date.now()).slice(-6)}`, date: today, description: "raw", sourceType: "manual", sourceId: `${TAG}-raw`, total: 1, createdBy: "raw", lines: { createMany: { data: [{ accountId: "acc_3900", debit: 1, credit: 0 }, { accountId: "acc_1100", debit: 0, credit: 1 }] } } } }), /opening clearing account/);

  // A source row is posted once across the migration.
  const sb2 = await createBatch({ kind: "phase", segment: "suppliers", source_file: FILE }, prep);
  await assert.rejects(addLines(sb2.id, { lines: [{ kind: "supplier", party_id: veg3.id, amount: "5", source_file: FILE, source_row: "3" }] }, prep), status(409));

  // 4. The exception register: each row decided with its reason.
  const exceptions = await listExceptions({ status: "open", segment: "suppliers" });
  assert.equal(exceptions.length, 2);
  for (const e of exceptions) await resolveException(e.id, { status: "excluded", resolution: "اختبار: الصف مش من موردين الخضار", expected_version: e.version }, prep);
  await assert.rejects(resolveException(exceptions[0].id, { status: "resolved", resolution: "تاني", expected_version: exceptions[0].version + 1 }, prep), status(409), "decided once");

  // 5. Customers, later, in their own batch.
  const { cancelBatch } = await import("@/lib/accounting/opening-batches");
  await cancelBatch(sb2.id, { reason: "مش محتاجينها" }, prep);
  const cb = await createBatch({ kind: "phase", segment: "customers", source_file: `${TAG} عملاء.xlsx` }, prep);
  await addLines(cb.id, { lines: [{ kind: "customer", party_code: customer.code, amount: "12000", source_row: "2", source_name: "فندق" }] }, prep);
  await submitBatch(cb.id, prep);
  await approve(cb.id);
  assert.equal((await balance("opening_clearing")).toFixed(2), "413185.00");

  // 6. The rest: opening equity moved into the clearing account, then the legacy figures that close it.
  const ob = await createBatch({ kind: "phase", segment: "other" }, prep);
  const equity = await balance("opening_equity");
  if (!equity.isZero()) {
    await assert.rejects(addLines(ob.id, { lines: [{ kind: "equity_transfer", amount: equity.toFixed(2) }] }, prep), status(400), "the transfer must zero 3300, not double it");
    await addLines(ob.id, { lines: [{ kind: "equity_transfer", description: "مخزون افتتاحي مرحّل مباشرة" }] }, prep);
  }
  // Stock at cost through the stock ledger: valued against 3300 by the ledger, then moved to the clearing account.
  const potato = await prisma.stockProduct.create({ data: { name: `${TAG} Potato`, unit: "KG" } });
  mine.products.add(potato.id);
  await addLines(ob.id, { lines: [{ kind: "stock", product_id: potato.id, quantity: "100", unit_cost: "12.5" }] }, prep);
  // Where opening stock was already posted directly (as in production), stock lines are refused —
  // the same stock would count twice; the batch then carries everything else.
  const direct = await prisma.inventoryDocument.count({ where: { type: "adjustment", sourceType: "opening_balance", status: "posted", reversalOfId: null, sourceId: null } });
  let stockValue = 1250;
  if (direct) {
    assert.ok((await validateBatch(ob.id)).problems.some((p) => p.code === "direct_opening_stock_exists"));
    const { removeLine } = await import("@/lib/accounting/opening-batches");
    const stockLine = await prisma.openingBatchLine.findFirstOrThrow({ where: { batchId: ob.id, kind: "stock" } });
    await removeLine(ob.id, stockLine.id, prep);
    stockValue = 0;
  }
  const after3300 = equity.negated(); // what the transfer moves onto the clearing account (debit positive on 3300)
  const remaining = (await balance("opening_clearing")).minus(after3300).minus(stockValue);
  // Synthetic legacy figures: the cash (or capital) that makes the opening position balance.
  if (remaining.gt(0)) await addLines(ob.id, { lines: [{ kind: "gl", account_code: "1100", debit: remaining.toFixed(2), description: "الخزينة في تاريخ القطع" }] }, prep);
  else if (remaining.lt(0)) await addLines(ob.id, { lines: [{ kind: "gl", account_code: "3100", credit: remaining.negated().toFixed(2), description: "رأس المال" }] }, prep);
  const ov = await validateBatch(ob.id);
  assert.deepEqual(ov.problems, []);
  await submitBatch(ob.id, prep);
  await approve(ob.id);
  assert.equal((await balance("opening_clearing")).toFixed(2), "0.00", "the clearing account is back to zero");
  assert.equal((await balance("opening_equity")).toFixed(2), "0.00");
  const layers = await prisma.stockValuationLayer.aggregate({ where: { productId: potato.id }, _sum: { value: true } });
  assert.equal(D(layers._sum.value).toFixed(2), stockValue ? "1250.00" : "0.00", "the stock ledger carries the opening stock at its cost");

  // 7. Closure: refused until people confirm what the data cannot show; then approved by someone else.
  o = await migrationOverview();
  await assert.rejects(requestClosure({ expected_version: o.migration!.version }, prep), (e: any) => e.status === 409 && /تأكيد/.test(e.message));
  let version = o.migration!.version;
  for (const key of ATTESTATIONS) version = (await attest({ key, confirmed: true, note: "اختبار: متطابق", expected_version: version }, prep)).version;
  o = await migrationOverview();
  const failing = o.checks!.filter((c) => !c.ok).map((c) => c.key);
  if (failing.length) {
    // The shared test database may carry other suites' imbalances (integrity checks); the refusal must name them.
    await assert.rejects(requestClosure({ expected_version: version }, prep), status(409));
    t.diagnostic(`closure not reachable on this database: ${failing.join(", ")}`);
    return;
  }
  assert.equal(o.status, "ready_for_closure");
  await requestClosure({ expected_version: version }, prep);
  assert.equal((await migrationOverview()).status, "awaiting_approval");
  await assert.rejects(createBatch({ kind: "phase", segment: "other" }, prep), status(409), "no new phase while closure waits");
  const migration = await prisma.openingMigration.findUniqueOrThrow({ where: { key: "opening" } });
  await assert.rejects(approve(migration.id, prep), status(403), "the requester cannot approve the closure");
  await approve(migration.id);
  const closed = await prisma.openingMigration.findUniqueOrThrow({ where: { key: "opening" } });
  assert.equal(closed.status, "closed");
  assert.ok((closed.closeEvidence as any)?.checks?.every((c: any) => c.ok));
  assert.deepEqual(await openingPosition(), { final: true, state: "closed", cutoverDate: today, clearing: "0.00" });
  await assert.rejects(createBatch({ kind: "phase", segment: "suppliers" }, prep), status(409));
  await assert.rejects(prisma.openingMigration.update({ where: { id: closed.id }, data: { status: "open" } }), /does not change/);
  const correction = await createBatch({ kind: "correction" }, prep);
  mine.batches.add(correction.id);
  assert.equal(correction.cutoverDate, today, "after closure, opening figures change by an approved correction batch");
});
