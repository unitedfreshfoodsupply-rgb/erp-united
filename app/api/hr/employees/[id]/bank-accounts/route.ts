import { addBankAccount } from "@/lib/hr/private-data";
import { postHandler } from "@/lib/route-handlers";

/** A new salary account; the previous one is kept as history, deactivated. */
export const POST = postHandler("hr.private.manage", async (body, actor, params) => ({ account: await addBankAccount(params.id, body, actor) }));
