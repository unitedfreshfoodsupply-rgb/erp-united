import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { expiringDocuments } from "@/lib/hr/private-data";

/** Employee documents expiring in the next 60 days (or already expired). */
export async function GET(req: NextRequest) {
  try {
    const actor = await requireServiceActor(req, "hr.private.view");
    return NextResponse.json({ documents: await expiringDocuments(actor) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
