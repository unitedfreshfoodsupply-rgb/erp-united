import { requestClosure } from "@/lib/accounting/opening-migration";
import { postHandler } from "@/lib/route-handlers";

/** Asks someone with accounting.opening.approve to close the migration; refused while a closure check fails. */
export const POST = postHandler("accounting.manage", async (body, actor) => ({ migration: await requestClosure(body, actor) }), () => 202);
