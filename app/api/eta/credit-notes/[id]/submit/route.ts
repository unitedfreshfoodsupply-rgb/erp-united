import { postHandler } from "@/lib/route-handlers";
import { submitCreditNoteToEta } from "@/lib/eta/service";

/** Sends the credit note to ETA once (after its invoice is accepted). A repeat returns the existing state (200). */
export const POST = postHandler("accounting.eta.manage", async (_body, actor, params) => submitCreditNoteToEta(params.id, actor), (r) => ((r as { submitted?: boolean }).submitted ? 201 : 200));
