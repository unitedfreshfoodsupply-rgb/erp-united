import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { getInvoice, updateDraftInvoice } from "@/lib/sales/invoicing";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requirePermission(req, "sales.invoices.view");
    return NextResponse.json({ invoice: await getInvoice(params.id) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** A draft's notes (its lines follow the order, its buyer the customer record). */
export const PATCH = postHandler("sales.invoices.manage", async (body, actor, params) => {
  await updateDraftInvoice(params.id, body, actor);
  return { invoice: await getInvoice(params.id) };
}, () => 200);
