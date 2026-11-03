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

  if (decidable.length) {
    tasks.push(prisma.approvalRequest.count({ where: { status: "pending", type: { in: decidable }, NOT: { requestedById: viewer.id } } })
      .then((count) => push({ key: "approvals", count, href: "/approvals" })));
  }
  if (can(viewer, "sales.invoices.manage")) {
    tasks.push(prisma.salesInvoice.count({ where: { status: "draft" } }).then((count) => push({ key: "draft-invoices", count, href: "/sales" })));
    tasks.push(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "Order" o
      WHERE o."status" = 'dispatched'
        AND NOT EXISTS (SELECT 1 FROM "SalesInvoice" i WHERE i."orderId" = o."id" AND i."status" <> 'void')
        AND NOT EXISTS (SELECT 1 FROM "TripStop" s WHERE s."orderId" = o."id" AND s."active" AND s."status" IN ('pending', 'failed'))`
      .then(([r]) => push({ key: "orders-to-invoice", count: Number(r?.n ?? 0), href: "/sales" })));
  }
  if (can(viewer, "purchasing.bills.manage")) {
    tasks.push(prisma.supplierBill.count({ where: { status: "draft" } }).then((count) => push({ key: "draft-bills", count, href: "/purchasing" })));
  }
  if (can(viewer, "accounting.eta.view")) {
    tasks.push(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "SalesInvoice" i
      WHERE i."status" = 'issued'
        AND NOT EXISTS (SELECT 1 FROM "EtaDocument" d WHERE d."sourceType" = 'sales_invoice' AND d."sourceId" = i."id" AND d."status" IN ('valid', 'submitted', 'submitting'))`
      .then(([r]) => push({ key: "eta-pending", count: Number(r?.n ?? 0), href: "/eta" })));
  }
  if (can(viewer, "orders.approve")) {
    tasks.push(prisma.order.count({ where: { status: { in: OPEN_STATUSES }, needsReview: true } }).then((count) => push({ key: "orders-review", count, href: "/supervisor" })));
  }

  if (can(viewer, "orders.view", "reports.view")) {
    tasks.push(prisma.order.groupBy({ by: ["status"], where: { status: { in: OPEN_STATUSES } }, _count: { _all: true } }).then(async (rows) => {
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
      const [late, dispatched] = await Promise.all([
        prisma.order.count({ where: { status: { in: OPEN_STATUSES }, deliveryDate: { lt: today } } }),
        // Orders whose stock left today (a posted, unreversed issue document dated today).
        prisma.inventoryDocument.findMany({ where: { type: "issue", status: "posted", businessDate: today, sourceType: "order" }, select: { sourceId: true }, distinct: ["sourceId"] }).then((d) => d.length),
      ]);
      out.operations = { byStatus, open: rows.reduce((s, r) => s + r._count._all, 0), late, dispatchedToday: dispatched };
    }));
  }
  if (can(viewer, "reports.finance")) {
    tasks.push(prisma.$queryRaw<{ cur: Prisma.Decimal | null; prev: Prisma.Decimal | null; collected: Prisma.Decimal | null; issued: bigint }[]>`
      SELECT
        (SELECT coalesce(sum("net"), 0) FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${monthStart} AND ${today})
          - (SELECT coalesce(sum("net"), 0) FROM "CreditNote" WHERE "issueDate" BETWEEN ${monthStart} AND ${today}) AS cur,
        (SELECT coalesce(sum("net"), 0) FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${prevStart} AND ${prevEnd})
          - (SELECT coalesce(sum("net"), 0) FROM "CreditNote" WHERE "issueDate" BETWEEN ${prevStart} AND ${prevEnd}) AS prev,
        (SELECT coalesce(sum(r."amount"), 0) FROM "CustomerReceipt" r WHERE r."date" BETWEEN ${monthStart} AND ${today}
          AND NOT EXISTS (SELECT 1 FROM "CustomerReceiptReversal" x WHERE x."receiptId" = r."id")) AS collected,
        (SELECT count(*) FROM "SalesInvoice" WHERE "status" = 'issued' AND "issueDate" BETWEEN ${monthStart} AND ${today}) AS issued`
      .then(([r]) => { out.sales = { monthToDate: D(r?.cur).toFixed(2), previousToDate: D(r?.prev).toFixed(2), collected: D(r?.collected).toFixed(2), invoicesIssued: Number(r?.issued ?? 0) }; }));
    tasks.push(agingReport(today).then((a) => {
      const t = a.totals;
      out.receivables = { total: t.total, overdue: D(t.d1_30).plus(D(t.d31_60)).plus(D(t.d61_90)).plus(D(t.d90_plus)).toFixed(2) };
    }));
    // What UNITED owes suppliers, and what is already past due (the AP aging).
    tasks.push(apAgingReport(today).then((a) => {
      const t = a.totals;
      out.payables = { total: D(t.total).toFixed(2), overdue: D(t.d1_30).plus(D(t.d31_60)).plus(D(t.d61_90)).plus(D(t.d90_plus)).toFixed(2) };
    }));
    // Cash in hand and at the bank: the GL balance of every active cash/bank account as of
    // today (a posting dated later this month is not money yet; same rule as the Command Center).
    tasks.push(prisma.$queryRaw<{ type: string; b: Prisma.Decimal | null }[]>`
      SELECT c."type", sum(l."debit" - l."credit") AS b
      FROM "CashAccount" c JOIN "JournalLine" l ON l."accountId" = c."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId"
      WHERE c."active" AND e."date" <= ${today} GROUP BY c."type"`
      .then((rows) => {
        const of = (t: string) => D(rows.find((r) => r.type === t)?.b ?? 0);
        out.cash = { cash: of("cash").toFixed(2), bank: of("bank").toFixed(2), total: of("cash").plus(of("bank")).toFixed(2) };
      }));
  }
  if (can(viewer, "stock.view")) {
    tasks.push(Promise.all([
      // Weighed produce only (pieces are not kilos): received, and how it graded.
      prisma.stockIntake.aggregate({ where: { status: "posted", receivedDate: today, product: { unit: "KG" } }, _sum: { receivedQty: true, goodQty: true, gradeBQty: true, wasteQty: true, rejectedQty: true } }),
      prisma.stockIntake.count({ where: { status: "posted", receivedDate: today } }),
      prisma.stockProduct.count({ where: { active: true } }),
      // Products at or below their reorder point, counting only sellable locations.
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "StockProduct" p
        WHERE p."active" AND p."reorderPointQty" IS NOT NULL
          AND coalesce((SELECT sum(m."quantity") FROM "StockMovement" m JOIN "StorageLocation" l ON l."id" = m."locationId"
                        WHERE m."productId" = p."id" AND l."type" NOT IN ('waste', 'quarantine')), 0) <= p."reorderPointQty"`,
      prisma.stockIssueException.count({ where: { status: "open" } }),
    ]).then(([kg, receipts, products, low, exceptions]) => {
      const s = kg._sum;
      out.stock = {
        receiptsToday: receipts, receivedTodayKg: D(s.receivedQty).toFixed(0), activeProducts: products,
        gradedToday: { good: D(s.goodQty).toFixed(1), gradeB: D(s.gradeBQty).toFixed(1), waste: D(s.wasteQty).toFixed(1), rejected: D(s.rejectedQty).toFixed(1) },
        lowStock: Number(low[0]?.n ?? 0), openExceptions: exceptions,
      };
    }));
  }
  if (can(viewer, "purchasing.requests.view")) {
    tasks.push(prisma.purchaseRequest.count({ where: { status: { in: ["pending_approval", "approved"] } } }).then((count) => { out.purchaseRequests = { open: count }; }));
  }

  await Promise.all(tasks);
  const ORDER = ["approvals", "orders-review", "orders-to-invoice", "draft-invoices", "draft-bills", "eta-pending"];
  out.actions.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  return { today, ...out };
}

export type HomeSummary = Awaited<ReturnType<typeof homeSummary>>;

export { HOME_PERMISSIONS } from "@/lib/nav";
