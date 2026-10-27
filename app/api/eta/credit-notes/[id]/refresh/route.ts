import { postHandler } from "@/lib/route-handlers";
import { refreshCreditNoteEta } from "@/lib/eta/service";

export const POST = postHandler("accounting.eta.manage", async (_body, actor, params) => ({ eta: await refreshCreditNoteEta(params.id, actor) }), () => 200);
