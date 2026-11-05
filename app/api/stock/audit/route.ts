import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requireStockActor } from "@/lib/stock-auth";
import { prisma } from "@/lib/prisma";
import type { Permission } from "@/lib/permissions";
import { visibleAuditRows, withoutProvisionalCost } from "@/lib/security/audit-visibility";

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
 * The stock module's slice of the shared audit trail. Kept separate from /api/audit
 * (supervisor-only, order-scoped) so the stock controller can see the history of their
 * own entries without being handed the order pipeline's log. Rows follow the same money
 * rules as /api/audit and the supplier profile: agreed supplier prices only with
 * purchasing.prices.view, a receipt's provisional cost only with stock.valuation.view.
 */
export async function GET(req: NextRequest) {
  try {
    const viewer = await requireStockActor(req, "stock.view");
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entity_id");
    const logs = await prisma.auditLog.findMany({
      where: { entityType: { in: STOCK_ENTITY_TYPES }, ...(entityId ? { entityId } : {}) },
      orderBy: { timestamp: "desc" },
      take: entityId ? 100 : 60,
    });
    const can = (p: Permission) => viewer.permissions.includes(p);
    return jsonFor(viewer, { logs: withoutProvisionalCost(visibleAuditRows(logs, can), can) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
