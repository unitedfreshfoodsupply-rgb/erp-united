import { prisma } from "@/lib/prisma";
import type { Permission } from "@/lib/permissions";
import { visibleAuditRows, withoutProvisionalCost } from "@/lib/security/audit-visibility";
import { canSeeCosts, redactCosts } from "@/lib/security/redact";

// Every entity the stock module owns. Product identity decisions (aliases, order-line
// mappings) are stock decisions — they are what future stock movements will be posted
// against — so they belong in this view, not only in the raw table.
const STOCK_ENTITY_TYPES = [
  "supplier",
  "stock_product",
  "stock_intake",
  "stock_movement",
  "product_alias",
  "product_mapping",
  "inventory_document",
  "stock_lot",
  "stock_reservation",
  "stock_issue_exception",
  "product_packaging",
];

/**
 * The stock module's slice of the shared audit trail (GET /api/stock/audit), exactly as
 * the viewer may see it: agreed supplier prices only with purchasing.prices.view, a
 * receipt's provisional cost and cost-field values only with stock.valuation.view.
 * The route only authenticates and serialises this, so the rules are tested here.
 */
export async function stockAuditFor(viewer: { permissions: readonly string[] }, entityId: string | null) {
  const logs = await prisma.auditLog.findMany({
    where: { entityType: { in: STOCK_ENTITY_TYPES }, ...(entityId ? { entityId } : {}) },
    orderBy: { timestamp: "desc" },
    take: entityId ? 100 : 60,
  });
  const can = (p: Permission) => viewer.permissions.includes(p);
  const data = { logs: withoutProvisionalCost(visibleAuditRows(logs, can), can) };
  return canSeeCosts(viewer) ? data : redactCosts(data);
}
