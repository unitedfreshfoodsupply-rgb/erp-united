/* The management command center (maturity 2026-11): profit comes from the general ledger
   (revenue − cost of sales − operating expenses), a posting moves it by exactly its amount,
   and a viewer only receives the sections their permissions cover. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import { commandCenter } from "@/lib/management/command-center";
import { postJournal } from "@/lib/accounting/ledger";
import { todayLocalISO } from "@/lib/localDate";

after(() => prisma.$disconnect());
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const all = { can: () => true };
const today = todayLocalISO();
const from = `${today.slice(0, 7)}-01`;
type Profit = { revenue: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string };
const profitOf = async () => ((await commandCenter(all, { from, to: today })).profit as { current: Profit }).current;

test("profit reconciles to the ledger: net profit = revenue − every expense account over the period", async () => {
  const p = await profitOf();
  const [gl] = await prisma.$queryRaw<{ rev: Prisma.Decimal | null; exp: Prisma.Decimal | null }[]>`
    SELECT sum(CASE WHEN a."type" = 'revenue' THEN l."credit" - l."debit" END) rev, sum(CASE WHEN a."type" = 'expense' THEN l."debit" - l."credit" END) exp
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE e."date" BETWEEN ${from} AND ${today} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')`;
  assert.equal(p.revenue, D(gl.rev).toFixed(2));
  assert.equal(p.netProfit, D(gl.rev).minus(D(gl.exp)).toFixed(2));
  assert.equal(D(p.grossProfit).minus(D(p.operatingExpenses)).toFixed(2), p.netProfit);
});

test("a posting moves revenue, operating expenses and net profit by exactly its amounts", async () => {
  const before = await profitOf();
  const who = actor("command-center-test", ["accounting.journals.post"]);
  await inTx((tx) => postJournal(tx, {
    date: today, description: "اختبار مركز القيادة", sourceType: "manual", sourceId: `cc-${Date.now()}`,
    lines: [{ key: "cash", amount: D(70) }, { key: "general_expenses", amount: D(30) }, { key: "sales", amount: D(-100) }],
  }, who));
  const after_ = await profitOf();
  assert.equal(D(after_.revenue).minus(D(before.revenue)).toFixed(2), "100.00");
  assert.equal(D(after_.operatingExpenses).minus(D(before.operatingExpenses)).toFixed(2), "30.00");
  assert.equal(D(after_.costOfSales).minus(D(before.costOfSales)).toFixed(2), "0.00");
  assert.equal(D(after_.netProfit).minus(D(before.netProfit)).toFixed(2), "70.00");
});

test("permissions: sections the viewer may not see are not computed or returned", async () => {
  const ops = await commandCenter({ can: (p: string) => p === "orders.view" }, {});
  assert.ok(ops.orders, "an order viewer sees the order pipeline");
  for (const k of ["profit", "purchases", "receivables", "payables", "cash", "upcomingPayments", "inventory", "produce"]) assert.equal(k in ops, false, `${k} hidden`);
  const stock = await commandCenter({ can: (p: string) => p === "stock.view" }, {});
  assert.ok(stock.inventory && stock.produce);
  assert.equal((stock.inventory as { value: unknown }).value, null, "stock value needs stock.valuation.view");
  assert.equal("profit" in stock, false);
});

test("the period is validated, and the comparison period has the same length", async () => {
  await assert.rejects(commandCenter(all, { from: "2026-05-02", to: "2026-05-01" }), (e: { status?: number }) => e.status === 400);
  const r = await commandCenter(all, { from: "2026-03-01", to: "2026-03-31" });
  assert.deepEqual(r.period, { from: "2026-03-01", to: "2026-03-31", prevFrom: "2026-01-29", prevTo: "2026-02-28" });
});
