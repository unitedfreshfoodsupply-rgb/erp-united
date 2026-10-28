import { revealBankAccount } from "@/lib/hr/private-data";
import { postHandler } from "@/lib/route-handlers";

/** POST, not GET: the full number is shown on purpose, once, and the look is audited. */
export const POST = postHandler("hr.private.view", async (_body, actor, params) => ({ account: await revealBankAccount(params.id, params.accountId, actor) }), () => 200);
