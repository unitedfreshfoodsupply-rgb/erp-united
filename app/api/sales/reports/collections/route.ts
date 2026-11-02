import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { isValidISODate } from "@/lib/dates";
import { collectionFollowUp } from "@/lib/sales/collections";

/** WS3 G2: overdue receivables to follow up, by customer (read-only; nothing is sent). Same gate as the aging report. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "sales.invoices.view");
    const asOf = new URL(req.url).searchParams.get("as_of");
    return NextResponse.json(await collectionFollowUp(asOf && isValidISODate(asOf) ? asOf : undefined));
  } catch (err) {
    return handleApiError(err, req);
  }
}
