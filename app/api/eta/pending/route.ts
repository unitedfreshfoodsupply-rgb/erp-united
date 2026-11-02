import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { etaPendingSubmissions } from "@/lib/eta/service";

/** Issued invoices and credit notes not (yet) registered at ETA, oldest first, with their age in hours. Read only. */
export async function GET(req: NextRequest) {
  try {
    const actor = await requireServiceActor(req, "accounting.eta.view");
    return NextResponse.json({ pending: await etaPendingSubmissions(actor) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
