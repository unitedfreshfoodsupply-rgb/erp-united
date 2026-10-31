import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { previewYearClose } from "@/lib/accounting/fiscal-years";

/** What closing the year would post (revenue and expense balances, net result) and what blocks it. */
export async function GET(req: NextRequest, { params }: { params: { code: string } }) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json({ year: await previewYearClose(params.code) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
