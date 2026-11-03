/* The report engine (maturity 2026-11): every report runs against PostgreSQL, the key
   figures reconcile to their authoritative source (ledger / documents / stock layers),
   permissions are enforced per report, and exports are bilingual. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, inTx } from "./_db";
import { REPORTS } from "@/lib/reports/definitions";
import { reportCatalogue, reportCsv, reportParams, reportXls, runReport } from "@/lib/reports/engine";
import { mayOpenLink } from "@/lib/reports/page-access";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/permissions";
import { todayLocalISO } from "@/lib/localDate";
import { createIntake } from "@/lib/stock-service";
import { postJournal } from "@/lib/accounting/ledger";
import { commandCenter } from "@/lib/management/command-center";

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

test("cash movements, no account chosen: every active cash and bank account together — the Command Center's figure, named as such; a transfer between them is not money in or out", async (t) => {
  const pool = await runReport("cash-movements", wide(), all);
  assert.equal(pool.totals.balance, ((await commandCenter(all, {})).cash as { total: string }).total, "the closing balance is the Command Center's cash and bank");
  assert.deepEqual(pool.scope, { ar: "كل الخزن والحسابات البنكية النشطة", en: "All active cash and bank accounts" });
  const one = await prisma.cashAccount.findFirstOrThrow({ where: { active: true } });
  assert.equal((await runReport("cash-movements", wide({ cash_account_id: one.id }), all)).scope?.en, `${one.code} · ${one.name}`, "a chosen account is named");
  const held = await prisma.$queryRaw<{ id: string; accountId: string; b: Prisma.Decimal | null }[]>`
    SELECT c."id", c."accountId", (SELECT sum(l."debit" - l."credit") FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE l."accountId" = c."accountId" AND e."date" <= ${today}) b
    FROM "CashAccount" c WHERE c."active" ORDER BY 3 DESC NULLS LAST`;
  if (held.length < 2 || D(held[0].b).lt(1)) return t.skip("needs two active cash accounts, one holding at least 1.00");
  const [src, dst] = held;
  const who = actor("reports-test", ["accounting.journals.post"]);
  const move = (from: string, to: string, tag: string) => inTx((tx) => postJournal(tx, {
    date: today, description: "اختبار تحويل بين الخزن", sourceType: "manual", sourceId: `rep-transfer-${tag}-${Date.now()}`,
    lines: [{ accountId: to, amount: D(1) }, { accountId: from, amount: D(-1) }],
  }, who));
  const before = await runReport("cash-movements", wide(), all);
  const entry = await move(src.accountId, dst.accountId, "out");
  try {
    const after_ = await runReport("cash-movements", wide(), all);
    assert.equal(after_.totals.balance, before.totals.balance, "the balance is unchanged");
    assert.deepEqual([after_.totals.inflow, after_.totals.outflow], [before.totals.inflow, before.totals.outflow], "neither money in nor out");
    assert.equal(after_.rows.some((x) => x.number === entry?.number), false, "the transfer is not a row of the pool");
    const left = await runReport("cash-movements", wide({ cash_account_id: src.id }), all);
    assert.ok(left.rows.some((x) => x.number === entry?.number && x.outflow === "1.00"), "it is a row of the account it left");
  } finally {
    await move(dst.accountId, src.accountId, "back");
  }
});

test("timestamp reports use the Cairo business day: a 01:30 Cairo decision (23:30Z the day before) is dated and filtered on its own day", async () => {
  // March 2001: UTC+2, far from any other test's data; decided, so it is in no approvals inbox.
  await prisma.approvalRequest.create({ data: { number: `APR-ZZCAIRO-${Date.now()}`, type: "orders.shortage", entityType: "order", entityId: "zz-cairo-day", title: "ZZ Cairo day", status: "rejected", decidedAt: new Date("2001-03-05T08:00:00Z"), requestedBy: "reports-test", createdAt: new Date("2001-03-04T23:30:00Z") } });
  const on = (day: string) => runReport("shortages", reportParams(new URLSearchParams({ from: day, to: day })), all);
  const row = (await on("2001-03-05")).rows.find((x) => x.title === "ZZ Cairo day");
  assert.equal(row?.date, "2001-03-05", "dated on its Cairo day");
  assert.equal((await on("2001-03-04")).rows.some((x) => x.title === "ZZ Cairo day"), false, "not on the UTC day before");
});

test("catalogue: a report that opens another screen is listed only to who can open that screen (each role's entries all open)", () => {
  const as = (role: keyof typeof ROLE_PERMISSIONS) => ({ can: (p: string) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p) });
  const keys = (role: keyof typeof ROLE_PERMISSIONS) => reportCatalogue(as(role)).map((r) => r.key);
  const clerk = keys("ACCOUNTING_CLERK");
  assert.ok(!clerk.includes("ap-aging") && !clerk.includes("supplier-statement"), "the clerk cannot open /purchasing (purchasing.orders.view)");
  assert.ok(clerk.includes("ar-aging") && clerk.includes("customer-statement"), "but opens /sales with its invoices");
  assert.ok(!keys("SUPERVISOR").includes("customer-statement"), "the statement needs sales.invoices.view, which the supervisor lacks");
  assert.equal(reportCatalogue(as("ACCOUNTANT")).find((r) => r.key === "balance-sheet")?.href, "/accounting?tab=analysis", "the balance sheet opens the screen that has it");
  for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
    for (const r of reportCatalogue(as(role))) if (r.href) assert.ok(mayOpenLink(r.href, as(role).can), `${role}: ${r.key} → ${r.href} opens`);
  }
});

test("drill-down: a row's link is dropped for a viewer who cannot open its page (the row stays)", async () => {
  const tag = `ZZDRL${Date.now()}`;
  const supplier = await prisma.supplier.create({ data: { code: `SUP-5${String(Date.now()).slice(-7)}`, name: `${tag} supplier` } });
  const product = await prisma.stockProduct.create({ data: { name: `${tag} Mango`, unit: "KG", category: `${tag}-cat` } });
  await createIntake({ supplier_id: supplier.id, product_id: product.id, received_kg: 10, received_date: today, unit_cost: "5" } as never, actor("أمين مخزن", ["stock.view", "stock.receive"]) as never);
  const only = (...perms: string[]) => ({ can: (p: string) => perms.includes(p) });
  const links = async (key: string, viewer: { can: (p: string) => boolean }, extra: Record<string, string> = {}) => (await runReport(key, wide(extra), viewer)).rows.map((x) => x._href ?? null);
  // [report, a viewer who may run it but not open its rows' page, one who may open that page too]
  const cases: [string, string[], string[], Record<string, string>?][] = [
    ["goods-received", ["stock.view"], ["stock.view", "stock.receive"], { supplier_id: supplier.id }],
    ["supplier-performance", ["purchasing.bills.view"], ["purchasing.bills.view", "purchasing.orders.view", "purchasing.suppliers.view"]],
    ["supplier-performance", ["stock.view", "purchasing.orders.view"], ["stock.view", "purchasing.orders.view", "purchasing.suppliers.view"]],
    ["purchases-by-supplier", ["purchasing.bills.view"], ["purchasing.bills.view", "purchasing.orders.view", "purchasing.suppliers.view"]],
    ["sales-by-product", ["sales.invoices.view"], ["sales.invoices.view", "stock.view"]],
    ["price-exceptions", ["sales.invoices.view"], ["sales.invoices.view", "orders.view"]],
    ["reservations", ["stock.view"], ["stock.view", "orders.view"]],
  ];
  for (const [key, without, withIt, extra] of cases) {
    const [denied, allowed, full] = [await links(key, only(...without), extra), await links(key, only(...withIt), extra), await links(key, all, extra)];
    assert.equal(denied.length, full.length, `${key}: the same rows either way`);
    assert.ok(denied.every((h) => h === null), `${key}: no link for ${without.join(" + ")}`);
    assert.deepEqual([...allowed].sort(), [...full].sort(), `${key}: every link kept for ${withIt.join(" + ")}`);
  }
  assert.ok((await links("goods-received", only("stock.view", "stock.receive"), { supplier_id: supplier.id })).some((h) => h !== null), "not vacuous: the receipt links for who can open it");
  const stock = await links("stock-by-product", only("stock.view"), { category: `${tag}-cat` });
  assert.ok(stock.length > 0 && stock.every((h) => h?.startsWith("/stock/inventory?product=")), "a stock viewer keeps the stock link");
  // A link to another report follows that report's permissions too.
  const byPeriod = await links("sales-by-period", only("sales.invoices.view"), { group_by: "month" });
  assert.ok(byPeriod.every((h) => h?.startsWith("/reports/sales-by-customer?")), "sales viewers keep the link to the next sales report");
});

test("cost columns follow stock.valuation.view: stock and sales viewers get the report without costs, in rows, totals and exports", async () => {
  const only = (...perms: string[]) => ({ can: (p: string) => perms.includes(p) });
  const cases: [string, string, string[]][] = [
    ["stock-by-product", "stock.view", ["value"]],
    ["goods-received", "stock.view", ["unit_cost"]],
    ["waste-trend", "stock.view", ["waste_value"]],
    ["sales-by-customer", "sales.invoices.view", ["cost", "margin", "margin_pct"]],
    ["sales-by-product", "sales.invoices.view", ["cost", "margin", "margin_pct"]],
    ["sales-by-category", "sales.invoices.view", ["cost", "margin", "margin_pct"]],
    ["price-exceptions", "sales.invoices.view", ["summary"]],
  ];
  for (const [key, perm, costs] of cases) {
    const without = await runReport(key, wide(), only(perm));
    const withCost = await runReport(key, wide(), only(perm, "stock.valuation.view"));
    for (const c of costs) {
      assert.ok(withCost.columns.some((x) => x.key === c), `${key}: ${c} shown with stock.valuation.view`);
      assert.ok(!without.columns.some((x) => x.key === c), `${key}: ${c} hidden without it`);
      assert.ok(without.rows.every((r) => !(c in r)), `${key}: no row carries ${c}`);
      assert.equal(c in without.totals, false, `${key}: no ${c} total`);
      for (const lang of ["ar", "en"] as const) {
        const label = withCost.columns.find((x) => x.key === c)!.label[lang];
        assert.ok(!reportCsv(without, lang).split("\r\n")[0].includes(label) || without.columns.some((x) => x.label[lang] === label), `${key}: the ${lang} export has no ${c} column`);
      }
    }
    assert.equal(without.rows.length, withCost.rows.length, `${key}: the same rows either way`);
  }
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
    for (const row of r.rows.filter((x) => !(key === "general-ledger" && x.number === "") && !(["stock-by-category", "sales-by-category"].includes(key) && x.category === "—"))) {
      assert.ok(typeof row._href === "string" && row._href.startsWith("/"), `${key} row links to its source`);
      checked++;
    }
  }
  assert.ok(checked > 0, "some rows were checked");
  // A category link opens a report that has rows; the uncategorised row has no link (nothing to filter on).
  for (const [summary, detail] of [["sales-by-category", "sales-by-product"], ["stock-by-category", "stock-by-product"]] as const) {
    for (const row of (await runReport(summary, wide(), all)).rows) {
      if (row.category === "—") { assert.equal(row._href, null, `${summary}: the uncategorised row has no link`); continue; }
      const category = new URL(String(row._href), "http://x").searchParams.get("category") ?? "";
      assert.ok((await runReport(detail, wide({ category }), all)).rows.length > 0, `${summary} → ${detail}?category=${category} has rows`);
    }
  }
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
