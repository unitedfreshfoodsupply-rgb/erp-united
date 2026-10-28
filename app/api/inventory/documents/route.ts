import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { listDocuments } from "@/lib/inventory/documents";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePermission(req, "stock.view");
    const sp = new URL(req.url).searchParams;
    const result = await listDocuments({ type: sp.get("type") ?? undefined, status: sp.get("status") ?? undefined, limit: Number(sp.get("limit")) || undefined, offset: Number(sp.get("offset")) || undefined });
    // Movement costs are valuation data.
    const withValue = ctx.can("stock.valuation.view");
    return jsonFor(ctx, {
      documents: withValue ? result.documents : result.documents.map((d) => ({ ...d, movements: d.movements.map((m) => ({ ...m, unitCost: null })) })),
      pagination: result.pagination,
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}
