import { postHandler } from "@/lib/route-handlers";
import { recordCreditNotePortalFiling } from "@/lib/eta/service";

/** Records a document filed on the ETA portal (UUID, date, evidence): registered, never sent by the API. */
export const POST = postHandler("accounting.eta.manage", async (body, actor, params) => ({ eta: await recordCreditNotePortalFiling(params.id, body, actor) }), () => 200);
