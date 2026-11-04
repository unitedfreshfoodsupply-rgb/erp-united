import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { comparativeStatements } from "@/lib/accounting/comparatives";
import { todayLocalISO } from "@/lib/localDate";
import { openingPosition } from "@/lib/accounting/opening-migration";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const sp = new URL(req.url).searchParams;
    const to = sp.get("to") ?? todayLocalISO();
    const from = sp.get("from") ?? `${to.slice(0, 4)}-01-01`;
    return NextResponse.json({ report: await comparativeStatements({ from, to, basis: sp.get("compare") ?? undefined }), opening: await openingPosition() });
  } catch (err) {
    return handleApiError(err, req);
  }
}
