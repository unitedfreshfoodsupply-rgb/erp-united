/* The report engine (maturity 2026-11): every report runs against PostgreSQL, the key
   figures reconcile to their authoritative source (ledger / documents / stock layers),
   permissions are enforced per report, and exports are bilingual. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "./_db";
import { REPORTS } from "@/lib/reports/definitions";
import { reportCatalogue, reportCsv, reportParams, reportXls, runReport } from "@/lib/reports/engine";
import { ALL_PERMISSIONS } from "@/lib/permissions";
import { todayLocalISO } from "@/lib/localDate";

after(() => prisma.$disconnect());
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const all = { can: () => true };
const today = todayLocalISO();
const wide = (extra: Record<string, string> = {}) => reportParams(new URLSearchParams({ from: "2000-01-01", to: today, ...extra }));

test("every report in the catalogue runs (valid SQL) with its default filters, and over a wide period", async () => {
  assert.ok(REPORTS.length >= 40, `${REPORTS.length} reports`);
  for (const r of REPORTS.filter((x) => x.run)) {
    await runReport(r.key, reportParams(new URLSearchParams()), all);
    const res = await runReport(r.key, wide({ group_by: "week", days: "30" }), all);
    assert.ok(Array.isArray(res.rows), r.key);
  }
  for (const r of REPORTS.filter((x) => !x.run)) assert.ok(r.href?.startsWith("/"), `${r.key} links to its screen`);
});

test("sales by period: net sales = issued invoices − credit notes (before tax) over the period", async () => {
  const r = await runReport("sales-by-period", wide({ group_by: "year" }), all);
  const [inv] = await prisma.$queryRaw<{ n: Prisma.Decimal | null }[]>`SELECT sum("net") n FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" <= ${today}`;
  const [cn] = await prisma.$queryRaw<{ n: Prisma.Decimal | null }[]>`SELECT sum("net") n FROM "CreditNote" WHERE "issueDate" <= ${today}`;
  assert.equal(r.totals.net, D(inv.n).minus(D(cn.n)).toFixed(2));
});

test("general ledger: the closing balance equals the account's balance in the ledger", async () => {
  const acct = await prisma.account.findFirstOrThrow({ where: { systemKey: "inventory" } });
  const r = await runReport("general-ledger", wide({ account_id: acct.id }), all);
  const [gl] = await prisma.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE l."accountId" = ${acct.id} AND e."date" <= ${today}`;
  assert.equal(r.totals.balance, D(gl.b).toFixed(2));
});

test("COGS by product = the COGS account's movement in the ledger over the same period", async () => {
  const r = await runReport("cogs-by-product", wide(), all);
  const [gl] = await prisma.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = 'cogs' AND e."date" BETWEEN '2000-01-01' AND ${today}`;
  assert.equal(r.totals.cogs, D(gl.b).toFixed(2));
});

test("stock by product: the total value equals the valuation layers of the products it lists", async () => {
  const r = await runReport("stock-by-product", wide(), all);
  const [v] = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT sum(v."value") v FROM "StockValuationLayer" v JOIN "StockProduct" p ON p."id" = v."productId" WHERE p."active" AND p."stockTracked"`;
  assert.equal(r.totals.value, D(v.v).toFixed(2));
});

test("cash movements: the closing balance equals the cash account in the ledger", async () => {
  const cash = await prisma.cashAccount.findFirstOrThrow({ where: { type: "cash", active: true } });
  const r = await runReport("cash-movements", wide({ cash_account_id: cash.id }), all);
  const [gl] = await prisma.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE l."accountId" = ${cash.accountId} AND e."date" <= ${today}`;
  assert.equal(r.totals.balance, D(gl.b).toFixed(2));
});

test("permissions: a viewer without the report's permission is refused (403) and does not see it in the catalogue", async () => {
  const preparer = { can: (p: string) => p === "orders.prepare" };
  await assert.rejects(runReport("sales-by-customer", wide(), preparer), (e: { status?: number }) => e.status === 403);
  assert.equal(reportCatalogue(preparer).some((r) => r.key === "sales-by-customer"), false);
  assert.ok(reportCatalogue({ can: (p: string) => (ALL_PERMISSIONS as readonly string[]).includes(p) }).length === REPORTS.length);
});

test("exports: CSV carries a BOM and the chosen language's headers; Excel is right-to-left in Arabic", async () => {
  const r = await runReport("stock-by-category", wide(), all);
  const ar = reportCsv(r, "ar"), en = reportCsv(r, "en");
  assert.ok(ar.startsWith("﻿") && ar.includes("الفئة") && en.includes("Category") && !en.includes("الفئة"));
  assert.ok(reportXls(r, "ar").includes('ss:RightToLeft="1"') && !reportXls(r, "en").includes("RightToLeft"));
  assert.ok(reportCsv(r, "en").includes("Total"));
});

test("filters are validated: a bad date is a 400, an inverted range is a 400", async () => {
  assert.throws(() => reportParams(new URLSearchParams({ from: "2026-13-01" })), (e: { status?: number }) => e.status === 400);
  assert.throws(() => reportParams(new URLSearchParams({ from: "2026-05-02", to: "2026-05-01" })), (e: { status?: number }) => e.status === 400);
});
