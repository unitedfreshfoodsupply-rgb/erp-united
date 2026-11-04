import { withdrawClosure } from "@/lib/accounting/opening-migration";
import { postHandler } from "@/lib/route-handlers";

/** Takes a pending closure request back. */
export const POST = postHandler("accounting.manage", async (body, actor) => ({ migration: await withdrawClosure(body, actor) }), () => 200);
