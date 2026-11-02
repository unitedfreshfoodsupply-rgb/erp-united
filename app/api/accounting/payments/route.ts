import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { listPayments } from "@/lib/accounting/cash";
import { createPayment } from "@/lib/accounting/cash";
import { documentStatus, postHandler } from "@/lib/route-handlers";
import { searchOf } from "@/lib/core/search";

export async function GET(req: NextRequest) {
  try {
    // Full financial visibility, or the workflow this list serves (a clerk who records
    // these does not need the ledger, balances or reports — see lib/permissions.ts).
    await requireAnyPermission(req, ["accounting.view", "accounting.payments.manage"]);
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await listPayments({ supplierId: sp.get("supplier_id") ?? undefined, limit: Number(sp.get("limit")) || undefined, offset: Number(sp.get("offset")) || undefined, ...searchOf(sp) }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
// ACC-04: 201 { payment } when it posted; 202 { paymentRequest } while it waits for a second
// person (accounting.payment_approval); 200 for a replayed request.
export const POST = postHandler("accounting.payments.manage", (body, actor) => createPayment(body, actor), documentStatus);
