import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { listFiscalYears } from "@/lib/accounting/fiscal-years";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json({ years: await listFiscalYears() });
  } catch (err) {
    return handleApiError(err, req);
  }
}
