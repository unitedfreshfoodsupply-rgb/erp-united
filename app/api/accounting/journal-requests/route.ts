import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { listJournalRequests } from "@/lib/accounting/ledger";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json({ requests: await listJournalRequests({ status: new URL(req.url).searchParams.get("status") ?? undefined }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
