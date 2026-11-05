import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { todayLocalISO } from "@/lib/localDate";
import { OPEN_STATUSES } from "@/lib/orderPresentation";
import { APPROVAL_TYPES, type ApprovalType } from "@/lib/core/approvals";
import { agingReport } from "@/lib/sales/invoicing";
import { apAgingReport } from "@/lib/purchasing/bills";

/**
 * The home dashboard: what is waiting for this person, and how today looks in the parts of the
 * business they can see. Every section is computed only when the viewer holds its permission —
 * the server never sends a figure the viewer could not open on its own screen. Counts and sums
 * only; every number links to the screen that holds the records behind it.
 */

type Viewer = { id: string; permissions: Set<string> };
const can = (v: Viewer, ...p: string[]) => p.some((x) => v.permissions.has(x));
const D = (x: Prisma.Decimal | number | string | null | undefined) => new Prisma.Decimal(x ?? 0);

export type HomeAction = { key: string; count: number; amount?: string; href: string };

export async function homeSummary(viewer: Viewer) {
  const today = todayLocalISO();
  const monthStart = `${today.slice(0, 7)}-01`;
  const prev = new Date(`${monthStart}T00:00:00Z`);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const prevStart = prev.toISOString().slice(0, 10);
  // The same day-of-month last month (clamped), so month-to-date compares like with like.
  const day = Number(today.slice(8, 10));
  const prevEndDate = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), Math.min(day, new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate())));
  const prevEnd = prevEndDate.toISOString().slice(0, 10);

  const decidable = (Object.keys(APPROVAL_TYPES) as ApprovalType[]).filter((t) => viewer.permissions.has(APPROVAL_TYPES[t].approvePermission));

  const tasks: Promise<unknown>[] = [];
  const out: {
    actions: HomeAction[];
    operations?: { byStatus: Record<string, number>; open: number; late: number; dispatchedToday: number };
    sales?: { monthToDate: string; previousToDate: string; collected: string; invoicesIssued: number };
    receivables?: { total: string; overdue: string };
    stock?: {
      receiptsToday: number; receivedTodayKg: string; activeProducts: number;
      gradedToday: { good: string; gradeB: string; waste: string; rejected: string };
      lowStock: number; openExceptions: number;
    };
    payables?: { total: string; overdue: string };
    cash?: { cash: string; bank: string; total: string };
    purchaseRequests?: { open: number };
  } = { actions: [] };
  const push = (a: HomeAction | null) => { if (a && a.count > 0) out.actions.push(a); };

  // Every count and sum below is a scalar subquery of ONE statement (PM-9): the sections run on a
  // single pooled connection, so separate queries waited for each other (35-40 round trips for
  // the owner). Each subquery is the query the section used to run on its own; a section the
  // viewer may not see adds nothing. The two aging reports stay separate.
  const cols: Prisma.Sql[] = [];
  const col = (name: string, sql: Prisma.Sql) => cols.push(Prisma.sql`(${sql}) AS ${Prisma.raw(`"${name}"`)}`);
  if (decidable.length) {
    col("approvals", Prisma.sql`SELECT count(*)::int FROM "ApprovalRequest" a WHERE a."status" = 'pending' AND a."type" IN (${Prisma.join(decidable)}) AND (NOT a."requestedById" = ${viewer.id})`);
  }
  if (can(viewer, "sales.invoices.manage")) {
    col("draftInvoices", Prisma.sql`SELECT count(*)::int FROM "SalesInvoice" WHERE "status" = 'draft'`);
    col("ordersToInvoice", Prisma.sql`
      SELECT count(*)::int FROM "Order" o
      WHERE o."status" = 'dispatched'
        AND NOT EXISTS (SELECT 1 FROM "SalesInvoice" i WHERE i."orderId" = o."id" AND i."status" <> 'void')
        AND NOT EXISTS (SELECT 1 FROM "TripStop" s WHERE s."orderId" = o."id" AND s."active" AND s."status" IN ('pending', 'failed'))`);
  }
  if (can(viewer, "purchasing.bills.manage")) {
    col("draftBills", Prisma.sql`SELECT count(*)::int FROM "SupplierBill" WHERE "status" = 'draft'`);
  }
  if (can(viewer, "accounting.eta.view")) {
    col("etaPending", Prisma.sql`
      SELECT count(*)::int FROM "SalesInvoice" i
      WHERE i."status" = 'issued'
        AND NOT EXISTS (SELECT 1 FROM "EtaDocument" d WHERE d."sourceType" = 'sales_invoice' AND d."sourceId" = i."id" AND d."status" IN ('valid', 'submitted', 'submitting'))`);
  }
  const open = Prisma.join(OPEN_STATUSES);
  if (can(viewer, "orders.approve")) {
    col("ordersReview", Prisma.sql`SELECT count(*)::int FROM "Order" WHERE "status" IN (${open}) AND "needsReview" = true`);
  }
  const operations = can(viewer, "orders.view", "reports.view");
  if (operations) {
    col("byStatus", Prisma.sql`SELECT json_object_agg(g."status", g.n) FROM (SELECT "status", count(*)::int AS n FROM "Order" WHERE "status" IN (${open}) GROUP BY "status") g`);
    col("late", Prisma.sql`SELECT count(*)::int FROM "Order" WHERE "status" IN (${open}) AND "deliveryDate" < ${today}`);
    // Orders whose stock left today (a posted, unreversed issue document dated today).
    col("dispatchedToday", Prisma.sql`SELECT count(*)::int FROM (SELECT DISTINCT "sourceId" FROM "InventoryDocument" WHERE "type" = 'issue' AND "status" = 'posted' AND "businessDate" = ${today} AND "sourceType" = 'order') d`);
  }
  const finance = can(viewer, "reports.finance");
  if (finance) {
    col("salesCur", Prisma.sql`SELECT (SELECT coalesce(sum("net"), 0) FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${monthStart} AND ${today})
          - (SELECT coalesce(sum("net"), 0) FROM "CreditNote" WHERE "issueDate" BETWEEN ${monthStart} AND ${today})`);
    col("salesPrev", Prisma.sql`SELECT (SELECT coalesce(sum("net"), 0) FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${prevStart} AND ${prevEnd})
          - (SELECT coalesce(sum("net"), 0) FROM "CreditNote" WHERE "issueDate" BETWEEN ${prevStart} AND ${prevEnd})`);
    col("collected", Prisma.sql`SELECT coalesce(sum(r."amount"), 0) FROM "CustomerReceipt" r WHERE r."date" BETWEEN ${monthStart} AND ${today}
          AND NOT EXISTS (SELECT 1 FROM "CustomerReceiptReversal" x WHERE x."receiptId" = r."id")`);
    col("invoicesIssued", Prisma.sql`SELECT count(*)::int FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${monthStart} AND ${today}`);
    // Cash in hand and at the bank: the GL balance of every active cash/bank account as of
    // today (a posting dated later this month is not money yet; same rule as the Command Center).
    for (const type of ["cash", "bank"]) {
      col(type, Prisma.sql`SELECT sum(l."debit" - l."credit") FROM "CashAccount" c JOIN "JournalLine" l ON l."accountId" = c."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId"
          WHERE c."active" AND e."date" <= ${today} AND c."type" = ${type}`);
    }
    tasks.push(agingReport(today).then((a) => {
      const t = a.totals;
      out.receivables = { total: t.total, overdue: D(t.d1_30).plus(D(t.d31_60)).plus(D(t.d61_90)).plus(D(t.d90_plus)).toFixed(2) };
    }));
    // What UNITED owes suppliers, and what is already past due (the AP aging).
    tasks.push(apAgingReport(today).then((a) => {
      const t = a.totals;
      out.payables = { total: D(t.total).toFixed(2), overdue: D(t.d1_30).plus(D(t.d31_60)).plus(D(t.d61_90)).plus(D(t.d90_plus)).toFixed(2) };
    }));
  }
  const stock = can(viewer, "stock.view");
  if (stock) {
    // Weighed produce only (pieces are not kilos): received, and how it graded.
    for (const f of ["receivedQty", "goodQty", "gradeBQty", "wasteQty", "rejectedQty"]) {
      col(`kg_${f}`, Prisma.sql`SELECT sum(i.${Prisma.raw(`"${f}"`)}) FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId" WHERE i."status" = 'posted' AND i."receivedDate" = ${today} AND p."unit" = 'KG'`);
    }
    col("receiptsToday", Prisma.sql`SELECT count(*)::int FROM "StockIntake" WHERE "status" = 'posted' AND "receivedDate" = ${today}`);
    col("activeProducts", Prisma.sql`SELECT count(*)::int FROM "StockProduct" WHERE "active" = true`);
    // Products at or below their reorder point, counting only sellable locations.
    col("lowStock", Prisma.sql`
        SELECT count(*)::int FROM "StockProduct" p
        WHERE p."active" AND p."reorderPointQty" IS NOT NULL
          AND coalesce((SELECT sum(m."quantity") FROM "StockMovement" m JOIN "StorageLocation" l ON l."id" = m."locationId"
                        WHERE m."productId" = p."id" AND l."type" NOT IN ('waste', 'quarantine')), 0) <= p."reorderPointQty"`);
    col("openExceptions", Prisma.sql`SELECT count(*)::int FROM "StockIssueException" WHERE "status" = 'open'`);
  }
  if (can(viewer, "purchasing.requests.view")) {
    col("openRequests", Prisma.sql`SELECT count(*)::int FROM "PurchaseRequest" WHERE "status" IN ('pending_approval', 'approved')`);
  }

  if (cols.length) {
    tasks.push(prisma.$queryRaw<Record<string, number | Prisma.Decimal | Record<string, number> | null>[]>`SELECT ${Prisma.join(cols)}`.then(([r]) => {
      const n = (k: string) => Number(r[k] ?? 0);
      const dec = (k: string) => D(r[k] as Prisma.Decimal | null);
      if (decidable.length) push({ key: "approvals", count: n("approvals"), href: "/approvals" });
      if (can(viewer, "sales.invoices.manage")) {
        push({ key: "draft-invoices", count: n("draftInvoices"), href: "/sales" });
        push({ key: "orders-to-invoice", count: n("ordersToInvoice"), href: "/sales" });
      }
      if (can(viewer, "purchasing.bills.manage")) push({ key: "draft-bills", count: n("draftBills"), href: "/purchasing" });
      if (can(viewer, "accounting.eta.view")) push({ key: "eta-pending", count: n("etaPending"), href: "/eta" });
      if (can(viewer, "orders.approve")) push({ key: "orders-review", count: n("ordersReview"), href: "/supervisor" });
      if (operations) {
        const byStatus = (r.byStatus as Record<string, number> | null) ?? {};
        out.operations = { byStatus, open: Object.values(byStatus).reduce((s, v) => s + v, 0), late: n("late"), dispatchedToday: n("dispatchedToday") };
      }
      if (finance) {
        out.sales = { monthToDate: dec("salesCur").toFixed(2), previousToDate: dec("salesPrev").toFixed(2), collected: dec("collected").toFixed(2), invoicesIssued: n("invoicesIssued") };
        out.cash = { cash: dec("cash").toFixed(2), bank: dec("bank").toFixed(2), total: dec("cash").plus(dec("bank")).toFixed(2) };
      }
      if (stock) {
        out.stock = {
          receiptsToday: n("receiptsToday"), receivedTodayKg: dec("kg_receivedQty").toFixed(0), activeProducts: n("activeProducts"),
          gradedToday: { good: dec("kg_goodQty").toFixed(1), gradeB: dec("kg_gradeBQty").toFixed(1), waste: dec("kg_wasteQty").toFixed(1), rejected: dec("kg_rejectedQty").toFixed(1) },
          lowStock: n("lowStock"), openExceptions: n("openExceptions"),
        };
      }
      if (can(viewer, "purchasing.requests.view")) out.purchaseRequests = { open: n("openRequests") };
    }));
  }

  await Promise.all(tasks);
  const ORDER = ["approvals", "orders-review", "orders-to-invoice", "draft-invoices", "draft-bills", "eta-pending"];
  out.actions.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  return { today, ...out };
}

export type HomeSummary = Awaited<ReturnType<typeof homeSummary>>;

export { HOME_PERMISSIONS } from "@/lib/nav";
