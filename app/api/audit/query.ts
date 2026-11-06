import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Permission } from "@/lib/permissions";
import { visibleAuditRows, withoutProvisionalCost } from "@/lib/security/audit-visibility";
import { canSeeCosts, redactCosts } from "@/lib/security/redact";

/**
 * One page of the audit log, newest first, and the number of rows the filter matches.
 *
 * The page is read first. When it is not full it is the end of the list, so the total is the
 * rows before it plus the rows on it, and the count — which repeats the whole search, every
 * word against eight fields — is not run. That is every search with fewer hits than a page and
 * almost every order timeline. A full page (or one past the end) still counts.
 *
 * `likelyShort: false` (the whole log, or a date or type filter, which almost always fill a page)
 * sends the count alongside the page instead, as before: one wait for both when the pool has more
 * than one connection (with production's single connection the two run in turn either way).
 */
export async function auditPage(where: Prisma.AuditLogWhereInput, limit: number, offset: number, opts: { likelyShort?: boolean } = {}) {
  const find = () => prisma.auditLog.findMany({
    where,
    // Rows written together (writeAuditMany) share a timestamp; the id, made in writing order,
    // keeps them in a stable order instead of whatever the plan returns.
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    skip: offset,
    take: limit,
    include: { order: { select: { orderNumber: true, customerName: true } } },
  });
  if (opts.likelyShort === false) {
    const [total, rows] = await Promise.all([prisma.auditLog.count({ where }), find()]);
    return { total, rows };
  }
  const rows = await find();
  const total = rows.length < limit && (rows.length > 0 || offset === 0) ? offset + rows.length : await prisma.auditLog.count({ where });
  return { total, rows };
}

/**
 * One page of GET /api/audit exactly as the viewer may see it, under the same money rules as
 * the stock audit (lib/security/stock-audit.ts) and the profiles: rows the viewer's permissions
 * do not cover are dropped (visibleAuditRows); a receipt's provisional unit cost, and the values
 * and reason of a cost-field change, only with stock.valuation.view. The route only
 * authenticates, builds the filter and serialises this, so the rules are tested here.
 */
export async function auditLogFor(
  viewer: { permissions: readonly string[] },
  where: Prisma.AuditLogWhereInput,
  limit: number,
  offset: number,
  opts: { likelyShort?: boolean } = {}
) {
  const { total, rows } = await auditPage(where, limit, offset, opts);
  const can = (p: Permission) => viewer.permissions.includes(p);
  const logs = withoutProvisionalCost(visibleAuditRows(rows, can), can);

  // Resolve item names for order_item events.
  const itemIds = [...new Set(logs.filter((l) => l.entityType === "order_item").map((l) => l.entityId))];
  const items = itemIds.length
    ? await prisma.orderItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, productName: true, unit: true } })
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const data = {
    total,
    offset,
    limit,
    logs: logs.map((l) => ({
      ...l,
      itemName: l.entityType === "order_item" ? itemById.get(l.entityId)?.productName ?? null : null,
      itemUnit: l.entityType === "order_item" ? itemById.get(l.entityId)?.unit ?? null : null,
    })),
  };
  return canSeeCosts(viewer) ? data : redactCosts(data);
}
