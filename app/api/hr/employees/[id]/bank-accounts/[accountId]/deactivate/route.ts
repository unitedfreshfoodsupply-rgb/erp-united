import { deactivateBankAccount } from "@/lib/hr/private-data";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("hr.private.manage", async (body, actor, params) => ({ account: await deactivateBankAccount(params.id, params.accountId, body, actor) }), () => 200);
