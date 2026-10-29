import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { listReceipts } from "@/lib/accounting/cash";
import { createReceipt } from "@/lib/accounting/cash";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    // Full financial visibility, or the workflow this list serves (a clerk who records
    // these does not need the ledger, balances or reports — see lib/permissions.ts).
    await requireAnyPermission(req, ["accounting.view", "accounting.receipts.manage"]);
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await listReceipts({ customerId: sp.get("customer_id") ?? undefined, limit: Number(sp.get("limit")) || undefined, offset: Number(sp.get("offset")) || undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
export const POST = postHandler("accounting.receipts.manage", async (body, actor) => ({ receipt: await createReceipt(body, actor) }));
