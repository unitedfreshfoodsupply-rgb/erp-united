import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { cutoverReadiness } from "@/lib/accounting/cutover";

/** Read-only: what still separates the books from a reconciled go-live (MIG-02). */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json(await cutoverReadiness());
  } catch (err) {
    return handleApiError(err, req);
  }
}
