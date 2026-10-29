import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { openInvoices } from "@/lib/accounting/cash";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest, { params }: { params: Record<string, string> }) {
  try {
    // Full financial visibility, or the workflow this list serves (a clerk who records
    // these does not need the ledger, balances or reports — see lib/permissions.ts).
    await requireAnyPermission(req, ["accounting.view", "accounting.receipts.manage"]);
    return NextResponse.json({ invoices: await openInvoices(prisma, params.id).then((r) => r.map((i) => ({ ...i, total: i.total.toFixed(2), open: i.open.toFixed(2) }))) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
