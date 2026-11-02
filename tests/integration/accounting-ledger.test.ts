/* The ledger against PostgreSQL: the database itself refuses an unbalanced entry, an
   edited or deleted line, a posting into a closed period or to a header account; and
   concurrent receipts can never settle one invoice beyond what it has open. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, inTx, taxNo } from "./_db";
import { createCustomer } from "@/lib/sales/customers";
import { issueInvoice } from "@/lib/sales/invoicing";
import { createReceipt, openInvoices } from "@/lib/accounting/cash";
import { closePeriod, createManualJournal, ensureOpenPeriod, postJournal } from "@/lib/accounting/ledger";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZLGR${Date.now()}`;
const acct = actor("محاسب", ["sales.invoices.manage", "sales.invoices.view", "sales.customers.manage", "accounting.view", "accounting.manage", "accounting.receipts.manage"]);
const today = todayLocalISO();
let customerId = "";
let invoiceId = "";

before(async () => {
  customerId = (await createCustomer({ name: `${TAG} Customer`, tax_registration_no: taxNo() }, acct)).id;
  const inv = await prisma.salesInvoice.create({
    data: {
      customerId, gross: new Prisma.Decimal(100), discountTotal: new Prisma.Decimal(0), net: new Prisma.Decimal(100), taxTotal: new Prisma.Decimal(0), total: new Prisma.Decimal(100), createdBy: "test",
      lines: { create: { lineNo: 1, description: "Okra", uomCode: "KG", quantity: new Prisma.Decimal(10), unitPrice: new Prisma.Decimal(10), taxCode: "EXEMPT", taxRate: new Prisma.Decimal(0), gross: new Prisma.Decimal(100), discount: new Prisma.Decimal(0), net: new Prisma.Decimal(100), tax: new Prisma.Decimal(0), total: new Prisma.Decimal(100) } },
    },
  });
  invoiceId = inv.id;
  await issueInvoice(invoiceId, {}, acct);
});
after(() => prisma.$disconnect());

test("issuing the invoice posted its entry in the same transaction", async () => {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: "sales_invoice", sourceId: invoiceId }, include: { lines: true } });
  assert.equal(je.total.toString(), "100");
  assert.equal(je.lines.length, 2);
});

test("an unbalanced entry is refused — and the refusal reaches the caller", async () => {
  // Through the application's transaction helper: Prisma would otherwise report a
  // COMMIT-time failure as success (see lib/tx.ts).
  await assert.rejects(
    inTx(async (tx) => {
      const e = await tx.journalEntry.create({ data: { number: `JE-2026-9${String(Date.now()).slice(-6)}`, date: today, description: "x", sourceType: "manual", sourceId: `${TAG}-x`, total: 10, createdBy: "x" } });
      await tx.journalLine.create({ data: { entryId: e.id, accountId: "acc_6100", debit: 10 } });
      await tx.journalLine.create({ data: { entryId: e.id, accountId: "acc_1100", credit: 9 } });
    }),
    /does not balance/
  );
  // And by any writer at all: plain SQL in its own transaction.
  await assert.rejects(
    prisma.$executeRawUnsafe(`DO $$ DECLARE eid text := '${TAG}-raw'; BEGIN
      INSERT INTO "JournalEntry" ("id", "number", "date", "description", "sourceType", "sourceId", "total", "createdBy") VALUES (eid, 'JE-2026-9${String(Date.now()).slice(-6)}', '${today}', 'x', 'manual', eid, 10, 'x');
      INSERT INTO "JournalLine" ("id", "entryId", "accountId", "debit", "credit") VALUES (eid || 'a', eid, 'acc_6100', 10, 0), (eid || 'b', eid, 'acc_1100', 0, 9);
      SET CONSTRAINTS ALL IMMEDIATE;
    END $$`),
    /does not balance/
  );
});

test("journal lines cannot be edited or deleted; entries cannot be deleted", async () => {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: "sales_invoice", sourceId: invoiceId }, include: { lines: true } });
  await assert.rejects(prisma.$executeRaw`UPDATE "JournalLine" SET "debit" = 1 WHERE "id" = ${je.lines[0].id}`, /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "id" = ${je.lines[0].id}`, /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "id" = ${je.id}`, /append-only/);
  // The reconciliation mark is the one thing that may change.
  await prisma.$executeRaw`UPDATE "JournalLine" SET "reconciliationId" = NULL WHERE "id" = ${je.lines[0].id}`;
});

test("header accounts and closed periods take no postings, even by raw SQL", async () => {
  await assert.rejects(createManualJournal({ date: today, description: "x", lines: [{ account_id: "acc_6000", debit: 1 }, { account_id: "acc_1100", credit: 1 }] }, acct), /حساب رئيسي/);
  await prisma.accountingPeriod.upsert({ where: { code: "2019-06" }, update: { status: "closed", closedAt: new Date() }, create: { code: "2019-06", startDate: "2019-06-01", endDate: "2019-06-30", status: "closed", closedAt: new Date() } });
  await assert.rejects(
    prisma.journalEntry.create({ data: { number: `JE-2019-9${String(Date.now()).slice(-6)}`, date: "2019-06-15", description: "x", sourceType: "manual", sourceId: `${TAG}-p`, total: 1, createdBy: "x" } }),
    /period of 2019-06-15 is closed/
  );
});

test("a period close waits for a posting already inside that period", async () => {
  const code = "2001-01";
  const date = `${code}-15`;
  const periodActor = actor("محاسب الفترات", ["accounting.manage", "accounting.periods.close"]);
  await prisma.accountingPeriod.upsert({
    where: { code },
    update: { status: "open", closedBy: null, closedAt: null },
    create: { code, startDate: "2001-01-01", endDate: "2001-01-31" },
  });
  let markReady!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const posting = inTx(async (tx) => {
    await ensureOpenPeriod(tx, date);
    markReady();
    await gate;
    return postJournal(tx, {
      date,
      description: "قيد قبل إغلاق الفترة",
      sourceType: "manual",
      sourceId: `${TAG}-period-race`,
      lines: [{ key: "cash", amount: new Prisma.Decimal(1) }, { key: "general_expenses", amount: new Prisma.Decimal(-1) }],
    }, periodActor);
  });
  await ready;
  const closing = closePeriod(code, periodActor);
  await new Promise((resolve) => setTimeout(resolve, 40));
  release();
  const [entry] = await Promise.all([posting, closing]);
  assert.ok(entry, "the transaction that acquired the period lock first may finish posting");
  assert.equal((await prisma.accountingPeriod.findUniqueOrThrow({ where: { code } })).status, "closed");
  await assert.rejects(createManualJournal({ date, description: "بعد الإغلاق", lines: [{ account_id: "acc_1100", debit: 1 }, { account_id: "acc_6100", credit: 1 }] }, periodActor), /الفترة المحاسبية/);
  // Restore the shared integration-test fixture so the suite is repeatable.
  await prisma.accountingPeriod.update({ where: { code }, data: { status: "open", closedBy: null, closedAt: null } });
});

test("concurrent receipts never settle an invoice beyond what it has open", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, () => createReceipt({ party_id: customerId, cash_account_id: "cash_main", amount: 40, method: "cash", allocations: [{ document_id: invoiceId, amount: 40 }] }, acct).then(() => "ok", () => "refused"))
  );
  assert.equal(results.filter((x) => x === "ok").length, 2, "2 × 40 fit in 100");
  const alloc = await prisma.receiptAllocation.aggregate({ where: { invoiceId }, _sum: { amount: true } });
  assert.equal(alloc._sum.amount?.toString(), "80");
  assert.equal((await openInvoices(prisma, customerId))[0].open.toString(), "20");
});

test("a receipt cannot be allocated beyond its amount (DB check at commit)", async () => {
  const r = await createReceipt({ party_id: customerId, cash_account_id: "cash_main", amount: 5, method: "cash" }, acct);
  await assert.rejects(prisma.receiptAllocation.create({ data: { receiptId: r.id, invoiceId, amount: 6 } }), /allocated/);
});
