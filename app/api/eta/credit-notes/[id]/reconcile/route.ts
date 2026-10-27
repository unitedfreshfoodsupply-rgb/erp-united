import { postHandler } from "@/lib/route-handlers";
import { reconcileCreditNoteEta } from "@/lib/eta/service";

/** Resolves an "unknown" credit-note submission from what the accountant found on the ETA portal. */
export const POST = postHandler("accounting.eta.manage", async (body, actor, params) => ({ eta: await reconcileCreditNoteEta(params.id, body, actor) }), () => 200);
