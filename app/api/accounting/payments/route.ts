import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { listPayments } from "@/lib/accounting/cash";
import { createPayment } from "@/lib/accounting/cash";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    // Full financial visibility, or the workflow this list serves (a clerk who records
    // these does not need the ledger, balances or reports — see lib/permissions.ts).
    await requireAnyPermission(req, ["accounting.view", "accounting.payments.manage"]);
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await listPayments({ supplierId: sp.get("supplier_id") ?? undefined, limit: Number(sp.get("limit")) || undefined, offset: Number(sp.get("offset")) || undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
export const POST = postHandler("accounting.payments.manage", async (body, actor) => ({ payment: await createPayment(body, actor) }));
