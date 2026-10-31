import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { fileVatReturn, listVatReturns } from "@/lib/accounting/vat-returns";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json(await listVatReturns());
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("accounting.manage", async (body, actor) => ({ vatReturn: await fileVatReturn(body, actor) }));
