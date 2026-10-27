import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { etaCreditNoteState } from "@/lib/eta/service";

/** One credit note: readiness issues (including whether its invoice is accepted), the ETA document, its state and history. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireServiceActor(req, "accounting.eta.view");
    return NextResponse.json(await etaCreditNoteState(params.id, actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}
