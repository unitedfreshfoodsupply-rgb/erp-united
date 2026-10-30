import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { isValidISODate } from "@/lib/dates";
import { todayLocalISO } from "@/lib/localDate";
import { agingReport } from "@/lib/sales/invoicing";
import { apAgingReport } from "@/lib/purchasing/bills";

/**
 * Management overview — the figures behind the dashboard charts, each answering one question:
 *
 *  - Are sales and purchases moving together? Net sales (issued invoices − credit notes, before
 *    tax) and net purchases (posted bills − debit notes, before tax) per week.
 *  - How good is what we receive? Intake grading per week — good, grade B, waste, rejected —
 *    for products weighed in kilograms only (a box and a kilogram do not add up).
 *  - Who owes us, who do we owe, and how late? Receivable and payable aging buckets as of the
 *    period end (the same reports as the Sales and Purchasing screens).
 *  - Who are the customers that matter this period? Top customers by net sales.
 *
 * Headline figures compare with the previous period of the same length. Every query is an
 * aggregate in the database; they run together. Read-only.
 */

const D = (v: Prisma.Decimal | number | string | null | undefined) => new Prisma.Decimal(v ?? 0);
const f2 = (d: Prisma.Decimal) => d.toFixed(2);
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
/** Weeks start on Saturday, the first working day in Egypt. */
const weekStart = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 1) % 7));
const MAX_DAYS = 400;

type WeekRow = { week: string; v: Prisma.Decimal | null };

export async function managementOverview(opts: { from?: string; to?: string }) {
  const to = opts.to ?? todayLocalISO();
  const from = opts.from ?? addDays(weekStart(to), -11 * 7);
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  if (daysBetween(from, to) > MAX_DAYS) throw new ApiError(400, "الفترة أطول من المسموح (400 يوم)");
  const span = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));

  // Week key: the Saturday on or before the date ((dow + 1) % 7 days back).
  const wk = Prisma.sql`(d::date - ((extract(dow from d::date)::int + 1) % 7))::text`;
  const salesWeekly = prisma.$queryRaw<WeekRow[]>`
    SELECT ${wk} AS week, sum(v) AS v FROM (
      SELECT "issueDate" AS d, "net" AS v FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${from} AND ${to}
      UNION ALL SELECT "issueDate", -"net" FROM "CreditNote" WHERE "issueDate" BETWEEN ${from} AND ${to}
    ) x GROUP BY 1`;
  const purchasesWeekly = prisma.$queryRaw<WeekRow[]>`
    SELECT ${wk} AS week, sum(v) AS v FROM (
      SELECT "billDate" AS d, "net" AS v FROM "SupplierBill" WHERE "status" = 'posted' AND "billDate" BETWEEN ${from} AND ${to}
      UNION ALL SELECT "issueDate", -"net" FROM "DebitNote" WHERE "issueDate" BETWEEN ${from} AND ${to}
    ) x GROUP BY 1`;
  const gradingWeekly = prisma.$queryRaw<{ week: string; good: Prisma.Decimal; gradeB: Prisma.Decimal; waste: Prisma.Decimal; rejected: Prisma.Decimal }[]>`
    SELECT ${wk} AS week, sum("goodQty") AS good, sum("gradeBQty") AS "gradeB", sum("wasteQty") AS waste, sum("rejectedQty") AS rejected
    FROM (SELECT i."receivedDate" AS d, i.* FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId"
          WHERE i."status" = 'posted' AND p."unit" = 'KG' AND i."receivedDate" BETWEEN ${from} AND ${to}) x
    GROUP BY 1`;
  const totals = (a: string, b: string) => prisma.$queryRaw<{ sales: Prisma.Decimal | null; purchases: Prisma.Decimal | null; collected: Prisma.Decimal | null; received: Prisma.Decimal | null; waste: Prisma.Decimal | null; gradeB: Prisma.Decimal | null }[]>`
    SELECT
      (SELECT coalesce(sum("net"), 0) FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${a} AND ${b})
        - (SELECT coalesce(sum("net"), 0) FROM "CreditNote" WHERE "issueDate" BETWEEN ${a} AND ${b}) AS sales,
      (SELECT coalesce(sum("net"), 0) FROM "SupplierBill" WHERE "status" = 'posted' AND "billDate" BETWEEN ${a} AND ${b})
        - (SELECT coalesce(sum("net"), 0) FROM "DebitNote" WHERE "issueDate" BETWEEN ${a} AND ${b}) AS purchases,
      (SELECT coalesce(sum(r."amount"), 0) FROM "CustomerReceipt" r WHERE r."date" BETWEEN ${a} AND ${b}
        AND NOT EXISTS (SELECT 1 FROM "CustomerReceiptReversal" x WHERE x."receiptId" = r."id")) AS collected,
      (SELECT coalesce(sum(i."receivedQty"), 0) FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId" WHERE i."status" = 'posted' AND p."unit" = 'KG' AND i."receivedDate" BETWEEN ${a} AND ${b}) AS received,
      (SELECT coalesce(sum(i."wasteQty"), 0) FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId" WHERE i."status" = 'posted' AND p."unit" = 'KG' AND i."receivedDate" BETWEEN ${a} AND ${b}) AS waste,
      (SELECT coalesce(sum(i."gradeBQty"), 0) FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId" WHERE i."status" = 'posted' AND p."unit" = 'KG' AND i."receivedDate" BETWEEN ${a} AND ${b}) AS "gradeB"`;
  const topCustomers = prisma.$queryRaw<{ customerId: string; nameAr: string | null; nameEn: string; code: string; net: Prisma.Decimal; invoices: bigint }[]>`
    SELECT i."customerId", c."nameAr" AS "nameAr", c."name" AS "nameEn", c."code", sum(i."net") AS net, count(*) AS invoices
    FROM "SalesInvoice" i JOIN "Customer" c ON c."id" = i."customerId"
    WHERE i."status" = 'issued' AND i."issueDate" BETWEEN ${from} AND ${to}
    GROUP BY i."customerId", c."nameAr", c."name", c."code" ORDER BY sum(i."net") DESC LIMIT 8`;

  const [sales, purchases, grading, [cur], [prev], top, ar, ap] = await Promise.all([
    salesWeekly, purchasesWeekly, gradingWeekly, totals(from, to), totals(prevFrom, prevTo), topCustomers, agingReport(to), apAgingReport(to),
  ]);

  // Every week of the period, empty weeks included, so a quiet week reads as zero, not as a gap.
  const weeks: string[] = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) weeks.push(w);
  const byWeek = <T extends { week: string }>(rows: T[]) => new Map(rows.map((r) => [r.week, r]));
  const s = byWeek(sales), p = byWeek(purchases), g = byWeek(grading);

  const pct = (part: Prisma.Decimal | null, whole: Prisma.Decimal | null) => (D(whole).gt(0) ? D(part).dividedBy(D(whole)).times(100).toFixed(1) : null);
  const head = (r: typeof cur) => ({
    sales: f2(D(r?.sales)), purchases: f2(D(r?.purchases)), collected: f2(D(r?.collected)),
    receivedKg: D(r?.received).toFixed(0), wastePct: pct(r?.waste ?? null, r?.received ?? null), gradeBPct: pct(r?.gradeB ?? null, r?.received ?? null),
  });
  const bucketOrder = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
  const overdue = (t: Record<string, string>) => f2(bucketOrder.slice(1).reduce((sum, k) => sum.plus(D(t[k])), D(0)));

  return {
    from, to, previous: { from: prevFrom, to: prevTo },
    headline: { current: head(cur), previous: head(prev) },
    weekly: weeks.map((week) => ({
      week,
      sales: f2(D(s.get(week)?.v)),
      purchases: f2(D(p.get(week)?.v)),
      good: D(g.get(week)?.good).toFixed(0),
      gradeB: D(g.get(week)?.gradeB).toFixed(0),
      waste: D(g.get(week)?.waste).toFixed(0),
      rejected: D(g.get(week)?.rejected).toFixed(0),
    })),
    receivables: { asOf: ar.asOf, total: ar.totals.total, overdue: overdue(ar.totals), buckets: bucketOrder.map((k) => ({ bucket: k, amount: ar.totals[k] })) },
    payables: { asOf: ap.asOf, total: ap.totals.total, overdue: overdue(ap.totals), buckets: bucketOrder.map((k) => ({ bucket: k, amount: ap.totals[k] })) },
    topCustomers: top.map((c) => ({ customerId: c.customerId, nameAr: c.nameAr, nameEn: c.nameEn, code: c.code, net: f2(D(c.net)), invoices: Number(c.invoices) })),
  };
}

export type ManagementOverview = Awaited<ReturnType<typeof managementOverview>>;
