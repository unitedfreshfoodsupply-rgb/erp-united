/* The management command center (maturity 2026-11): profit comes from the general ledger
   (revenue − cost of sales − operating expenses), a posting moves it by exactly its amount,
   and a viewer only receives the sections their permissions cover. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import { commandCenter } from "@/lib/management/command-center";
import { postJournal } from "@/lib/accounting/ledger";
import { createBill, createDebitNote, postBill } from "@/lib/purchasing/bills";
import { createIntake } from "@/lib/stock-service";
import { todayLocalISO } from "@/lib/localDate";

after(() => prisma.$disconnect());
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const all = { can: () => true };
const today = todayLocalISO();
const from = `${today.slice(0, 7)}-01`;
type Profit = { revenue: string; costOfSales: string; grossProfit: string; operatingExpenses: string; otherIncome: string; netProfit: string };
const profitOf = async () => ((await commandCenter(all, { from, to: today })).profit as { current: Profit }).current;

test("profit reconciles to the ledger: net profit = revenue − every expense account over the period", async () => {
  const p = await profitOf();
  const [gl] = await prisma.$queryRaw<{ rev: Prisma.Decimal | null; exp: Prisma.Decimal | null; sales: Prisma.Decimal | null }[]>`
    SELECT sum(CASE WHEN a."type" = 'revenue' THEN l."credit" - l."debit" END) rev, sum(CASE WHEN a."type" = 'expense' THEN l."debit" - l."credit" END) exp,
      sum(CASE WHEN a."type" = 'revenue' AND a."systemKey" IS DISTINCT FROM 'fa_disposal_gain' THEN l."credit" - l."debit" END) sales
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE e."date" BETWEEN ${from} AND ${today} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')`;
  assert.equal(p.revenue, D(gl.sales).toFixed(2), "revenue = sales accounts (asset disposal gains are other income)");
  assert.equal(p.netProfit, D(gl.rev).minus(D(gl.exp)).toFixed(2), "net = all revenue − all expenses");
  assert.equal(D(p.grossProfit).minus(D(p.operatingExpenses)).plus(D(p.otherIncome)).toFixed(2), p.netProfit);
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

test("a gain on selling a fixed asset is other income: net profit moves, revenue and gross margin do not", async () => {
  const before = await profitOf();
  const who = actor("command-center-test", ["accounting.journals.post"]);
  await inTx((tx) => postJournal(tx, {
    date: today, description: "اختبار ربح بيع أصل", sourceType: "manual", sourceId: `cc-fa-${Date.now()}`,
    lines: [{ key: "cash", amount: D(50) }, { key: "fa_disposal_gain", amount: D(-50) }],
  }, who));
  const after_ = await profitOf();
  assert.equal(D(after_.revenue).minus(D(before.revenue)).toFixed(2), "0.00");
  assert.equal(D(after_.grossProfit).minus(D(before.grossProfit)).toFixed(2), "0.00");
  assert.equal(D(after_.otherIncome).minus(D(before.otherIncome)).toFixed(2), "50.00");
  assert.equal(D(after_.netProfit).minus(D(before.netProfit)).toFixed(2), "50.00");
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

test("upcoming supplier payments = what is still open on posted bills due in the next 7 days (paid and debited parts excluded)", async () => {
  const r = await commandCenter(all, {});
  const up = r.upcomingPayments as { bills: number; total: string; until: string };
  const [x] = await prisma.$queryRaw<{ n: bigint; t: Prisma.Decimal | null }[]>`
    SELECT count(*) FILTER (WHERE o > 0) n, sum(o) FILTER (WHERE o > 0) t FROM (
      SELECT b."total"
        - coalesce((SELECT sum(d."total") FROM "DebitNote" d WHERE d."billId" = b."id"), 0)
        - coalesce((SELECT sum(a."amount") FROM "PaymentAllocation" a JOIN "SupplierPayment" p ON p."id" = a."paymentId"
                    WHERE a."billId" = b."id" AND NOT EXISTS (SELECT 1 FROM "SupplierPaymentReversal" v WHERE v."paymentId" = p."id")), 0) o
      FROM "SupplierBill" b WHERE b."status" = 'posted' AND b."dueDate" BETWEEN ${today} AND ${up.until}) q`;
  assert.equal(up.bills, Number(x.n));
  assert.equal(up.total, D(x.t).toFixed(2));
});

test("a bill due within 7 days counts once, at what is still open after a debit note", async () => {
  const tag = `ZZCC${Date.now()}`;
  const boss = actor("أمين مخزن", ["stock.receive", "stock.sort", "stock.view", "stock.valuation.view"]);
  const acct = actor("محاسب", ["purchasing.bills.manage", "purchasing.bills.view"]);
  const supplier = await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${tag} مورد`, paymentTermsDays: 7 } });
  const product = await prisma.stockProduct.create({ data: { name: `${tag} Pepper`, unit: "KG" } });
  const intake = await createIntake({ supplier_id: supplier.id, product_id: product.id, received_kg: 10, received_date: today, unit_cost: "10" } as never, boss);
  const before = (await commandCenter(all, {})).upcomingPayments as { bills: number; total: string };
  const bill = await postBill((await createBill({ supplier_id: supplier.id, supplier_invoice_no: `${tag}-1`, bill_date: today, lines: [{ intake_id: intake.id, unit_price: "10" }] }, acct)).id, acct);
  const line = await prisma.supplierBillLine.findFirstOrThrow({ where: { billId: bill.id } });
  await createDebitNote(bill.id, { reason: "مرتجع", lines: [{ bill_line_id: line.id, quantity: 3 }] }, acct);
  const after_ = (await commandCenter(all, {})).upcomingPayments as { bills: number; total: string };
  const billed = await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
  const debited = await prisma.debitNote.aggregate({ where: { billId: bill.id }, _sum: { total: true } });
  assert.equal(after_.bills - before.bills, 1, "the new bill is due within 7 days");
  assert.equal(D(after_.total).minus(D(before.total)).toFixed(2), billed.total.minus(D(debited._sum.total)).toFixed(2), "counted at its open amount, not its total");
});
