import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { trialBalance } from "@/lib/accounting/ledger";
import { todayLocalISO } from "@/lib/localDate";
import { openingPosition } from "@/lib/accounting/opening-migration";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const sp = new URL(req.url).searchParams;
    // `opening`: whether the opening figures are final or still provisional (phased opening migration not closed).
    return NextResponse.json({ trialBalance: await trialBalance(sp.get("from") ?? `${todayLocalISO().slice(0, 4)}-01-01`, sp.get("to") ?? todayLocalISO()), opening: await openingPosition() });
  } catch (err) {
    return handleApiError(err, req);
  }
}
