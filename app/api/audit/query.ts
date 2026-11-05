import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * One page of the audit log, newest first, and the number of rows the filter matches.
 *
 * The page is read first. When it is not full it is the end of the list, so the total is the
 * rows before it plus the rows on it, and the count — which repeats the whole search, every
 * word against eight fields — is not run. That is every search with fewer hits than a page and
 * almost every order timeline. A full page (or one past the end) still counts.
 */
export async function auditPage(where: Prisma.AuditLogWhereInput, limit: number, offset: number) {
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: "desc" },
    skip: offset,
    take: limit,
    include: { order: { select: { orderNumber: true, customerName: true } } },
  });
  const total = rows.length < limit && (rows.length > 0 || offset === 0) ? offset + rows.length : await prisma.auditLog.count({ where });
  return { total, rows };
}
