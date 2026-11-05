import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { migrationOverview, startMigration } from "@/lib/accounting/opening-migration";
import { postHandler } from "@/lib/route-handlers";

/** The opening migration control center: status, segments, clearing account, exceptions, approvals, closure checks. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    return NextResponse.json({ overview: await migrationOverview() });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Starts the phased opening migration at its cut-off date. */
export const POST = postHandler("accounting.manage", async (body, actor) => ({ migration: await startMigration(body, actor) }));
