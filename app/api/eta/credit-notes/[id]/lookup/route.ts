import { postHandler } from "@/lib/route-handlers";
import { lookupCreditNoteEta } from "@/lib/eta/service";

/** Asks ETA what it holds for an uncertain submission (Get Submission / Search Documents by internalID). */
export const POST = postHandler("accounting.eta.manage", async (_body, actor, params) => ({ eta: await lookupCreditNoteEta(params.id, actor) }), () => 200);
