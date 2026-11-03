import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { isValidISODate } from "@/lib/dates";
import { todayLocalISO } from "@/lib/localDate";
import { agingReport } from "@/lib/sales/invoicing";
import { apAgingReport } from "@/lib/purchasing/bills";
import { OPEN_STATUSES } from "@/lib/orderPresentation";
import type { Permission } from "@/lib/permissions";

/**
 * The management command center (maturity 2026-11): the whole business on one page, for a
 * period, each figure from its authoritative source, compared with the previous period of
 * the same length, and linked to the report or screen that shows the records behind it.
 * Sections the viewer may not see are not computed at all.
 *
 * Profit mapping (from the general ledger; year-end closing entries excluded):
 *   revenue        = revenue accounts (credit − debit)
 *   cost of sales  = COGS + purchase price variance + inventory adjustments & waste
 *   gross profit   = revenue − cost of sales
 *   operating exp. = every other expense account
 *   net profit     = revenue − all expenses
 */
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const COST_OF_SALES = ["cogs", "ppv", "inventory_adjustment"];
type Viewer = { can: (p: Permission) => boolean };

function periods(fromRaw?: string | null, toRaw?: string | null) {
  const today = todayLocalISO();
  const from = fromRaw || `${today.slice(0, 7)}-01`;
  const to = toRaw || today;
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const back = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  return { from, to, prevFrom: back(from, days), prevTo: back(from, 1), days, today };
}

async function profit(from: string, to: string) {
  const rows = await prisma.$queryRaw<{ type: string; key: string | null; amount: Prisma.Decimal }[]>`
    SELECT a."type", a."systemKey" AS key, sum(l."debit" - l."credit") amount
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."type" IN ('revenue', 'expense') AND e."date" BETWEEN ${from} AND ${to} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
    GROUP BY 1, 2`;
  const revenue = rows.filter((r) => r.type === "revenue").reduce((s, r) => s.minus(r.amount), D(0));
  const costOfSales = rows.filter((r) => r.type === "expense" && COST_OF_SALES.includes(r.key ?? "")).reduce((s, r) => s.plus(r.amount), D(0));
  const opex = rows.filter((r) => r.type === "expense" && !COST_OF_SALES.includes(r.key ?? "")).reduce((s, r) => s.plus(r.amount), D(0));
  const gross = revenue.minus(costOfSales);
  return { revenue: revenue.toFixed(2), costOfSales: costOfSales.toFixed(2), grossProfit: gross.toFixed(2), operatingExpenses: opex.toFixed(2), netProfit: gross.minus(opex).toFixed(2), grossMarginPct: revenue.isZero() ? null : gross.div(revenue).times(100).toFixed(1) };
}

async function purchases(from: string, to: string) {
  const [b] = await prisma.$queryRaw<{ n: Prisma.Decimal | null }[]>`SELECT sum("net") n FROM "SupplierBill" WHERE "status" = 'posted' AND "billDate" BETWEEN ${from} AND ${to}`;
  const [d] = await prisma.$queryRaw<{ n: Prisma.Decimal | null }[]>`SELECT sum("net") n FROM "DebitNote" WHERE "issueDate" BETWEEN ${from} AND ${to}`;
  return D(b.n).minus(D(d.n)).toFixed(2);
}

async function produce(from: string, to: string) {
  const [r] = await prisma.$queryRaw<{ rec: Prisma.Decimal | null; g: Prisma.Decimal | null; b: Prisma.Decimal | null; w: Prisma.Decimal | null; wv: Prisma.Decimal | null }[]>`
    SELECT sum(i."receivedQty") rec, sum(i."goodQty") g, sum(i."gradeBQty") b, sum(i."wasteQty") w, sum(i."wasteQty" * i."unitCost") wv
    FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId" WHERE i."status" = 'posted' AND p."unit" = 'KG' AND i."receivedDate" BETWEEN ${from} AND ${to}`;
  const rec = D(r.rec);
  return { receivedKg: rec.toFixed(1), goodKg: D(r.g).toFixed(1), gradeBKg: D(r.b).toFixed(1), wasteKg: D(r.w).toFixed(1), wastePct: rec.isZero() ? null : D(r.w).div(rec).times(100).toFixed(1), wasteValue: D(r.wv).toFixed(2) };
}

export async function commandCenter(viewer: Viewer, q: { from?: string | null; to?: string | null }) {
  const p = periods(q.from, q.to);
  const fin = viewer.can("reports.finance");
  const stock = viewer.can("stock.view");
  const ops = viewer.can("reports.view") || viewer.can("orders.view");
  const out: Record<string, unknown> = { period: { from: p.from, to: p.to, prevFrom: p.prevFrom, prevTo: p.prevTo } };
  const tasks: Promise<unknown>[] = [];

  if (fin) {
    tasks.push(Promise.all([profit(p.from, p.to), profit(p.prevFrom, p.prevTo)]).then(([cur, prev]) => { out.profit = { current: cur, previous: prev }; }));
    tasks.push(Promise.all([purchases(p.from, p.to), purchases(p.prevFrom, p.prevTo)]).then(([cur, prev]) => { out.purchases = { current: cur, previous: prev }; }));
    tasks.push(Promise.all([agingReport(p.today), apAgingReport(p.today)]).then(([ar, ap]) => {
      const overdue = (t: Record<string, unknown>) => D(t.d1_30 as string).plus(D(t.d31_60 as string)).plus(D(t.d61_90 as string)).plus(D(t.d90_plus as string)).toFixed(2);
      out.receivables = { total: D(ar.totals.total).toFixed(2), overdue: overdue(ar.totals) };
      out.payables = { total: D(ap.totals.total).toFixed(2), overdue: overdue(ap.totals) };
    }));
    // Supplier bills falling due in the next 7 days (upcoming payments).
    const week = new Date(Date.parse(`${p.today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    tasks.push(prisma.$queryRaw<{ n: bigint; t: Prisma.Decimal | null }[]>`SELECT count(*) n, sum(b."total") t FROM "SupplierBill" b WHERE b."status" = 'posted' AND b."dueDate" BETWEEN ${p.today} AND ${week}`.then(([r]) => { out.upcomingPayments = { bills: Number(r.n), total: D(r.t).toFixed(2), until: week }; }));
    tasks.push(prisma.$queryRaw<{ type: string; b: Prisma.Decimal | null }[]>`SELECT c."type", sum(l."debit" - l."credit") b FROM "CashAccount" c JOIN "JournalLine" l ON l."accountId" = c."accountId" WHERE c."active" GROUP BY 1`.then((rows) => {
      const of = (t: string) => D(rows.find((r) => r.type === t)?.b);
      out.cash = { cash: of("cash").toFixed(2), bank: of("bank").toFixed(2), total: of("cash").plus(of("bank")).toFixed(2) };
    }));
    tasks.push(prisma.openingBatch.count({ where: { kind: "initial", status: "posted" } }).then((n) => { out.openingBalancesComplete = n > 0; }));
  }
  if (stock) {
    tasks.push(Promise.all([produce(p.from, p.to), produce(p.prevFrom, p.prevTo)]).then(([cur, prev]) => { out.produce = { current: cur, previous: prev }; }));
    tasks.push(Promise.all([
      viewer.can("stock.valuation.view") ? prisma.stockValuationLayer.aggregate({ _sum: { value: true } }).then((a) => D(a._sum.value).toFixed(2)) : Promise.resolve(null),
      prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "StockProduct" p WHERE p."active" AND p."reorderPointQty" IS NOT NULL AND coalesce((SELECT sum(m."quantity") FROM "StockMovement" m JOIN "StorageLocation" l ON l."id" = m."locationId" WHERE m."productId" = p."id" AND l."type" NOT IN ('waste', 'quarantine')), 0) - coalesce((SELECT sum(r."quantity") FROM "StockReservation" r WHERE r."productId" = p."id" AND r."status" = 'active'), 0) <= p."reorderPointQty"`,
      prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM (SELECT m."lotId" FROM "StockMovement" m JOIN "StockLot" lt ON lt."id" = m."lotId" JOIN "StorageLocation" l ON l."id" = m."locationId" WHERE l."type" <> 'waste' AND lt."expiryDate" IS NOT NULL AND lt."expiryDate"::date <= current_date + 3 GROUP BY m."lotId" HAVING sum(m."quantity") > 0) x`,
      prisma.stockIssueException.count({ where: { status: "open" } }),
    ]).then(([value, low, expiring, exceptions]) => { out.inventory = { value, lowStock: Number(low[0]?.n ?? 0), expiringLots: Number(expiring[0]?.n ?? 0), openExceptions: exceptions }; }));
  }
  if (ops) {
    tasks.push(Promise.all([
      prisma.order.groupBy({ by: ["status"], where: { status: { in: OPEN_STATUSES } }, _count: { _all: true } }),
      prisma.order.count({ where: { status: { in: OPEN_STATUSES }, deliveryDate: { lt: p.today } } }),
      prisma.order.count({ where: { status: { in: OPEN_STATUSES }, needsReview: true } }),
      prisma.inventoryDocument.findMany({ where: { type: "issue", status: "posted", sourceType: "order", businessDate: { gte: p.from, lte: p.to } }, select: { sourceId: true }, distinct: ["sourceId"] }).then((d) => d.length),
    ]).then(([by, late, review, dispatched]) => { out.orders = { byStatus: Object.fromEntries(by.map((r) => [r.status, r._count._all])), late, needsReview: review, dispatchedInPeriod: dispatched }; }));
  }
  tasks.push(prisma.approvalRequest.groupBy({ by: ["type"], where: { status: "pending" }, _count: { _all: true } }).then((rows) => { out.approvals = Object.fromEntries(rows.map((r) => [r.type, r._count._all])); }));
  await Promise.all(tasks);
  return out;
}
