import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAuth } from "@/lib/authz";
import { reportCatalogue } from "@/lib/reports/engine";

/** The reports this user may open (the Reports centre). */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    return NextResponse.json({ reports: reportCatalogue(ctx) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
