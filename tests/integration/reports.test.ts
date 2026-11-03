/* The report engine (maturity 2026-11): every report runs against PostgreSQL, the key
   figures reconcile to their authoritative source (ledger / documents / stock layers),
   permissions are enforced per report, and exports are bilingual. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor } from "./_db";
import { REPORTS } from "@/lib/reports/definitions";
import { reportCatalogue, reportCsv, reportParams, reportXls, runReport } from "@/lib/reports/engine";
import { ALL_PERMISSIONS } from "@/lib/permissions";
import { todayLocalISO } from "@/lib/localDate";
import { createIntake } from "@/lib/stock-service";

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

const allLayers = async () => D((await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT sum("value") v FROM "StockValuationLayer"`)[0].v);
/** One product in its own category with a single layer worth 0.0050 (a row that shows 0.01). */
async function halfCentProduct(category: string, i: number) {
  const supplier = await prisma.supplier.create({ data: { code: `SUP-8${String(Date.now()).slice(-6)}${i}`, name: `${category} supplier ${i}` } });
  const product = await prisma.stockProduct.create({ data: { name: `${category} P${i}`, unit: "KG", category } });
  await createIntake({ supplier_id: supplier.id, product_id: product.id, received_kg: 1, received_date: today, unit_cost: "0.005" } as never, actor("أمين مخزن", ["stock.view", "stock.receive"]) as never);
  assert.equal(D((await prisma.stockValuationLayer.aggregate({ where: { productId: product.id }, _sum: { value: true } }))._sum.value).toFixed(4), "0.0050");
  return product;
}

test("stock by product: the total is the exact layer sum rounded once (rows of 0.0050 each show 0.01; two total 0.01, not 0.02)", async () => {
  const cat = `ZZHALF${Date.now()}`;
  await halfCentProduct(cat, 1);
  await halfCentProduct(cat, 2);
  const r = await runReport("stock-by-product", wide({ category: cat }), all);
  assert.deepEqual(r.rows.map((x) => x.value), ["0.01", "0.01"]);
  assert.equal(r.totals.value, "0.01");
});

test("stock by product and by category: the total equals every valuation layer (the inventory value), even for a product deactivated while holding stock", async () => {
  const cat = `ZZOFF${Date.now()}`;
  const p = await halfCentProduct(cat, 3);
  await prisma.stockProduct.update({ where: { id: p.id }, data: { active: false, stockTracked: false } });
  const byProduct = await runReport("stock-by-product", wide(), all);
  assert.ok(byProduct.rows.some((x) => String(x._href).endsWith(p.id)), "the deactivated product holding stock is listed");
  assert.equal(byProduct.totals.value, (await allLayers()).toFixed(2));
  assert.equal((await runReport("stock-by-category", wide(), all)).totals.value, (await allLayers()).toFixed(2));
  const drill = await runReport("stock-by-product", wide({ category: cat }), all);
  const row = (await runReport("stock-by-category", wide(), all)).rows.find((x) => x.category === cat);
  assert.equal(drill.totals.value, row?.value, "a category row equals the total of the products it drills to");
});

test("stock by category: four rows of 0.0050 total the exact sum, not the sum of the rounded rows", async () => {
  const base = `ZZQ${Date.now()}`;
  for (let i = 0; i < 4; i++) await halfCentProduct(`${base}-${i}`, 10 + i);
  const r = await runReport("stock-by-category", wide(), all);
  const shown = r.rows.reduce((t, x) => t.plus(D(x.value as string)), D(0)).toFixed(2);
  assert.notEqual(shown, (await allLayers()).toFixed(2), "precondition: the rounded rows do not add up to the exact sum");
  assert.equal(r.totals.value, (await allLayers()).toFixed(2));
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

test("drill-down: summary rows lead to their source (a screen or the next, narrower report)", async () => {
  // A graded receipt of its own, so the stock, receiving and supplier reports have rows to check.
  const tag = `ZZREP${Date.now()}`;
  const supplier = await prisma.supplier.create({ data: { code: `SUP-6${String(Date.now()).slice(-7)}`, name: `${tag} supplier` } });
  const product = await prisma.stockProduct.create({ data: { name: `${tag} Lemon`, nameAr: `${tag} ليمون`, unit: "KG", category: `${tag}-cat` } });
  await createIntake({ supplier_id: supplier.id, product_id: product.id, received_kg: 20, received_date: today, unit_cost: "6" } as never, actor("أمين مخزن", ["stock.view", "stock.receive"]) as never);
  const linked = ["sales-by-period", "sales-by-product", "sales-by-category", "purchases-by-product", "po-outstanding", "supplier-performance", "adjustments", "stock-by-category", "waste-trend", "dispatch-activity", "general-ledger", "cogs-by-product", "stock-by-product", "outstanding-invoices"];
  let checked = 0;
  for (const key of linked) {
    const r = await runReport(key, wide({ group_by: "month" }), all);
    for (const row of r.rows.filter((x) => !(key === "general-ledger" && x.number === "") && !(key === "stock-by-category" && x.category === "—"))) {
      assert.ok(typeof row._href === "string" && row._href.startsWith("/"), `${key} row links to its source`);
      checked++;
    }
  }
  assert.ok(checked > 0, "some rows were checked");
  const byPeriod = await runReport("sales-by-period", wide({ group_by: "month" }), all);
  for (const row of byPeriod.rows) assert.match(String(row._href), /^\/reports\/sales-by-customer\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
});

test("fixed report text is stored once and read in the export's language", async () => {
  const acct = await prisma.account.findFirstOrThrow({ where: { systemKey: "inventory" } });
  const r = await runReport("general-ledger", wide({ account_id: acct.id }), all);
  const en = reportCsv(r, "en"), ar = reportCsv(r, "ar");
  assert.ok(en.includes("Opening balance") && !en.includes("رصيد أول المدة"));
  assert.ok(ar.includes("رصيد أول المدة") && !ar.includes("Opening balance"));
});
