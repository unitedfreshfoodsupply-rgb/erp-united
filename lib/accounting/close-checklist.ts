import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";

/**
 * ACC-13 (maturity 2026-11): what is still unfinished in a month before it is closed.
 * These are warnings, not blocks — whether to close with them is the accountant's call
 * (the hard blocks stay in closePeriod). Each item says what it is and where to fix it.
 */
export type CloseWarning = { code: "dispatched_not_invoiced" | "draft_invoices" | "unposted_bills" | "pending_journals" | "pending_payments" | "open_issue_exceptions"; count: number; href: string };

export async function periodCloseChecklist(code: string): Promise<{ code: string; warnings: CloseWarning[] }> {
  if (!/^\d{4}-\d{2}$/.test(code)) throw new ApiError(400, "الشهر لازم يكون YYYY-MM");
  const [y, m] = code.split("-").map(Number);
  const from = `${code}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [dispatched, drafts, bills, journals, payments, exceptions] = await Promise.all([
    // Orders whose stock left in the month (a live issue document) with no live invoice.
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT d."sourceId") AS n FROM "InventoryDocument" d
      WHERE d."type" = 'issue' AND d."status" = 'posted' AND d."sourceType" = 'order' AND d."businessDate" BETWEEN ${from} AND ${to}
        AND NOT EXISTS (SELECT 1 FROM "SalesInvoice" i WHERE i."orderId" = d."sourceId" AND i."status" IN ('issued', 'draft'))`,
    prisma.salesInvoice.count({ where: { status: "draft", createdAt: { lte: new Date(`${to}T23:59:59Z`) } } }),
    prisma.supplierBill.count({ where: { status: { in: ["draft", "pending_approval"] }, billDate: { gte: from, lte: to } } }),
    prisma.journalRequest.count({ where: { status: "pending_approval", date: { gte: from, lte: to } } }),
    prisma.supplierPaymentRequest.count({ where: { status: "pending_approval", date: { gte: from, lte: to } } }),
    prisma.stockIssueException.count({ where: { status: "open" } }),
  ]);
  const all: CloseWarning[] = [
    { code: "dispatched_not_invoiced", count: Number(dispatched[0]?.n ?? 0), href: "/sales" },
    { code: "draft_invoices", count: drafts, href: "/sales" },
    { code: "unposted_bills", count: bills, href: "/purchasing" },
    { code: "pending_journals", count: journals, href: "/approvals" },
    { code: "pending_payments", count: payments, href: "/approvals" },
    { code: "open_issue_exceptions", count: exceptions, href: "/supervisor/exceptions" },
  ];
  return { code, warnings: all.filter((w) => w.count > 0) };
}
