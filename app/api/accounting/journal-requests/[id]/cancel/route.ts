import { cancelJournalRequest } from "@/lib/accounting/ledger";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("accounting.manage", async (body, actor, params) => ({ request: await cancelJournalRequest(params.id, body, actor) }), () => 200);
