import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createTransfer, listTransfers } from "@/lib/accounting/treasury";
import { documentStatus, postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const q = new URL(req.url).searchParams;
    return NextResponse.json(await listTransfers({ cashAccountId: q.get("cash_account_id") ?? undefined, status: q.get("status") ?? undefined, limit: Number(q.get("limit")) || undefined, offset: Number(q.get("offset")) || undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("accounting.manage", async (body, actor) => createTransfer(body, actor), documentStatus);
