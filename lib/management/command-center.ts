import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { isValidISODate } from "@/lib/dates";
import { todayLocalISO } from "@/lib/localDate";
import { agingReport } from "@/lib/sales/invoicing";
import { apAgingReport, debitedByBill } from "@/lib/purchasing/bills";
import { OPEN_STATUSES } from "@/lib/orderPresentation";
import type { Permission } from "@/lib/permissions";

/**
 * The management command center (maturity 2026-11): the whole business on one page, for a
 * period, each figure from its authoritative source, compared with the previous period of
 * the same length, and linked to the report or screen that shows the records behind it.
 * Sections the viewer may not see are not computed at all.
 *
 * Profit mapping (from the general ledger; year-end closing entries excluded):
 *   revenue        = revenue accounts (credit − debit), sales net of returns — not asset gains
 *   cost of sales  = COGS + purchase price variance + inventory adjustments & waste
 *   gross profit   = revenue − cost of sales
 *   operating exp. = every other expense account except asset disposal losses
 *   other income   = gains − losses on disposal of fixed assets
 *   net profit     = gross profit − operating expenses + other income (= all revenue − all expenses)
 */
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const COST_OF_SALES = ["cogs", "ppv", "inventory_adjustment"];
// Not trading: a gain or loss on selling a fixed asset is "other income", outside gross margin.
const OTHER = ["fa_disposal_gain", "fa_disposal_loss"];
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
  const other = (k: string | null) => OTHER.includes(k ?? "");
  const revenue = rows.filter((r) => r.type === "revenue" && !other(r.key)).reduce((s, r) => s.minus(r.amount), D(0));
  const costOfSales = rows.filter((r) => r.type === "expense" && COST_OF_SALES.includes(r.key ?? "")).reduce((s, r) => s.plus(r.amount), D(0));
  const opex = rows.filter((r) => r.type === "expense" && !COST_OF_SALES.includes(r.key ?? "") && !other(r.key)).reduce((s, r) => s.plus(r.amount), D(0));
  const otherIncome = rows.filter((r) => other(r.key)).reduce((s, r) => s.minus(r.amount), D(0));
  const gross = revenue.minus(costOfSales);
  return { revenue: revenue.toFixed(2), costOfSales: costOfSales.toFixed(2), grossProfit: gross.toFixed(2), operatingExpenses: opex.toFixed(2), otherIncome: otherIncome.toFixed(2), netProfit: gross.minus(opex).plus(otherIncome).toFixed(2), grossMarginPct: revenue.isZero() ? null : gross.div(revenue).times(100).toFixed(1) };
}

// The command center's scalar figures are subqueries of ONE statement (PM-9): on the single pooled
// connection each separate query waited for the one before. A section the viewer may not see adds
// no subquery; the profit rows, the agings and the bills falling due stay separate queries.
type Cols = { sql: Prisma.Sql[]; add: (name: string, sql: Prisma.Sql) => void };
const columns = (): Cols => {
  const sql: Prisma.Sql[] = [];
  return { sql, add: (name, q) => sql.push(Prisma.sql`(${q}) AS ${Prisma.raw(`"${name}"`)}`) };
};

/** Posted bills less debit notes in a period, before VAT. */
function purchases(c: Cols, key: string, from: string, to: string) {
  c.add(`${key}_bills`, Prisma.sql`SELECT sum("net") FROM "SupplierBill" WHERE "status" = 'posted' AND "billDate" BETWEEN ${from} AND ${to}`);
  c.add(`${key}_debits`, Prisma.sql`SELECT sum("net") FROM "DebitNote" WHERE "issueDate" BETWEEN ${from} AND ${to}`);
  return (r: Row) => dec(r, `${key}_bills`).minus(dec(r, `${key}_debits`)).toFixed(2);
}

/** Weighed produce received in a period and how it graded. */
function produce(c: Cols, key: string, from: string, to: string) {
  for (const [name, expr] of [["rec", Prisma.sql`i."receivedQty"`], ["g", Prisma.sql`i."goodQty"`], ["b", Prisma.sql`i."gradeBQty"`], ["w", Prisma.sql`i."wasteQty"`], ["wv", Prisma.sql`i."wasteQty" * i."unitCost"`]] as const) {
    c.add(`${key}_${name}`, Prisma.sql`SELECT sum(${expr}) FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId" WHERE i."status" = 'posted' AND p."unit" = 'KG' AND i."receivedDate" BETWEEN ${from} AND ${to}`);
  }
  return (r: Row) => {
    const rec = dec(r, `${key}_rec`), w = dec(r, `${key}_w`);
    return { receivedKg: rec.toFixed(1), goodKg: dec(r, `${key}_g`).toFixed(1), gradeBKg: dec(r, `${key}_b`).toFixed(1), wasteKg: w.toFixed(1), wastePct: rec.isZero() ? null : w.div(rec).times(100).toFixed(1), wasteValue: dec(r, `${key}_wv`).toFixed(2) };
  };
}
type Row = Record<string, Prisma.Decimal | number | Record<string, number> | null>;
const dec = (r: Row, k: string) => D(r[k] as Prisma.Decimal | null);

export async function commandCenter(viewer: Viewer, q: { from?: string | null; to?: string | null }) {
  const p = periods(q.from, q.to);
  const fin = viewer.can("reports.finance");
  const stock = viewer.can("stock.view");
  const ops = viewer.can("reports.view") || viewer.can("orders.view");
  const out: Record<string, unknown> = { period: { from: p.from, to: p.to, prevFrom: p.prevFrom, prevTo: p.prevTo } };
  const tasks: Promise<unknown>[] = [];

  const c = columns();
  const fill: ((r: Row) => void)[] = [];
  const n = (r: Row, k: string) => Number(r[k] ?? 0);

  if (fin) {
    tasks.push(Promise.all([profit(p.from, p.to), profit(p.prevFrom, p.prevTo)]).then(([cur, prev]) => { out.profit = { current: cur, previous: prev }; }));
    const cur = purchases(c, "pur_cur", p.from, p.to), prev = purchases(c, "pur_prev", p.prevFrom, p.prevTo);
    fill.push((r) => { out.purchases = { current: cur(r), previous: prev(r) }; });
    tasks.push(Promise.all([agingReport(p.today), apAgingReport(p.today)]).then(([ar, ap]) => {
      const overdue = (t: Record<string, unknown>) => D(t.d1_30 as string).plus(D(t.d31_60 as string)).plus(D(t.d61_90 as string)).plus(D(t.d90_plus as string)).toFixed(2);
      out.receivables = { total: D(ar.totals.total).toFixed(2), overdue: overdue(ar.totals) };
      out.payables = { total: D(ap.totals.total).toFixed(2), overdue: overdue(ap.totals) };
    }));
    // Upcoming payments: what is still open (after payments and debit notes) on posted
    // supplier bills falling due in the next 7 days.
    const week = new Date(Date.parse(`${p.today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    tasks.push(prisma.supplierBill.findMany({ where: { status: "posted", dueDate: { gte: p.today, lte: week } }, select: { id: true, total: true } }).then(async (bills) => {
      const off = await debitedByBill(prisma, bills.map((b) => b.id));
      const open = bills.map((b) => b.total.minus(off.get(b.id) ?? 0)).filter((o) => o.gt(0));
      out.upcomingPayments = { bills: open.length, total: open.reduce((s, o) => s.plus(o), D(0)).toFixed(2), until: week };
    }));
    // Cash and bank as of today (postings may be dated later in the month; they are not money yet).
    for (const type of ["cash", "bank"]) {
      c.add(type, Prisma.sql`SELECT sum(l."debit" - l."credit") FROM "CashAccount" c JOIN "JournalLine" l ON l."accountId" = c."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE c."active" AND e."date" <= ${p.today} AND c."type" = ${type}`);
    }
    c.add("openingBatches", Prisma.sql`SELECT count(*)::int FROM "OpeningBatch" WHERE "kind" = 'initial' AND "status" = 'posted'`);
    fill.push((r) => {
      out.cash = { cash: dec(r, "cash").toFixed(2), bank: dec(r, "bank").toFixed(2), total: dec(r, "cash").plus(dec(r, "bank")).toFixed(2) };
      out.openingBalancesComplete = n(r, "openingBatches") > 0;
    });
  }
  if (stock) {
    // Waste value is a cost figure: only with stock.valuation.view, as every stock response (redact.ts).
    const costs = viewer.can("stock.valuation.view");
    const strip = (x: ReturnType<ReturnType<typeof produce>>) => (costs ? x : { ...x, wasteValue: null });
    const cur = produce(c, "pro_cur", p.from, p.to), prev = produce(c, "pro_prev", p.prevFrom, p.prevTo);
    if (costs) c.add("stockValue", Prisma.sql`SELECT sum("value") FROM "StockValuationLayer"`);
    c.add("lowStock", Prisma.sql`SELECT count(*)::int FROM "StockProduct" p WHERE p."active" AND p."reorderPointQty" IS NOT NULL AND coalesce((SELECT sum(m."quantity") FROM "StockMovement" m JOIN "StorageLocation" l ON l."id" = m."locationId" WHERE m."productId" = p."id" AND l."type" NOT IN ('waste', 'quarantine')), 0) - coalesce((SELECT sum(r."quantity") FROM "StockReservation" r WHERE r."productId" = p."id" AND r."status" = 'active'), 0) <= p."reorderPointQty"`);
    // Expiring = within 3 days of today's business day (Cairo, not the database's UTC date), the day /reports/expiry counts from.
    c.add("expiringLots", Prisma.sql`SELECT count(*)::int FROM (SELECT m."lotId" FROM "StockMovement" m JOIN "StockLot" lt ON lt."id" = m."lotId" JOIN "StorageLocation" l ON l."id" = m."locationId" WHERE l."type" <> 'waste' AND lt."expiryDate" IS NOT NULL AND lt."expiryDate"::date <= ${p.today}::date + 3 GROUP BY m."lotId" HAVING sum(m."quantity") > 0) x`);
    c.add("openExceptions", Prisma.sql`SELECT count(*)::int FROM "StockIssueException" WHERE "status" = 'open'`);
    fill.push((r) => {
      out.produce = { current: strip(cur(r)), previous: strip(prev(r)) };
      out.inventory = { value: costs ? dec(r, "stockValue").toFixed(2) : null, lowStock: n(r, "lowStock"), expiringLots: n(r, "expiringLots"), openExceptions: n(r, "openExceptions") };
    });
  }
  if (ops) {
    const open = Prisma.join(OPEN_STATUSES);
    c.add("byStatus", Prisma.sql`SELECT json_object_agg(g."status", g.n) FROM (SELECT "status", count(*)::int AS n FROM "Order" WHERE "status" IN (${open}) GROUP BY "status") g`);
    c.add("late", Prisma.sql`SELECT count(*)::int FROM "Order" WHERE "status" IN (${open}) AND "deliveryDate" < ${p.today}`);
    c.add("needsReview", Prisma.sql`SELECT count(*)::int FROM "Order" WHERE "status" IN (${open}) AND "needsReview" = true`);
    c.add("dispatched", Prisma.sql`SELECT count(*)::int FROM (SELECT DISTINCT "sourceId" FROM "InventoryDocument" WHERE "type" = 'issue' AND "status" = 'posted' AND "sourceType" = 'order' AND "businessDate" BETWEEN ${p.from} AND ${p.to}) d`);
    fill.push((r) => { out.orders = { byStatus: (r.byStatus as Record<string, number> | null) ?? {}, late: n(r, "late"), needsReview: n(r, "needsReview"), dispatchedInPeriod: n(r, "dispatched") }; });
  }
  c.add("approvals", Prisma.sql`SELECT json_object_agg(g."type", g.n) FROM (SELECT "type", count(*)::int AS n FROM "ApprovalRequest" WHERE "status" = 'pending' GROUP BY "type") g`);
  fill.push((r) => { out.approvals = (r.approvals as Record<string, number> | null) ?? {}; });
  tasks.push(prisma.$queryRaw<Row[]>`SELECT ${Prisma.join(c.sql)}`.then(([r]) => { for (const f of fill) f(r); }));
  await Promise.all(tasks);
  return out;
}
