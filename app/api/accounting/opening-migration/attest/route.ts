import { attest } from "@/lib/accounting/opening-migration";
import { postHandler } from "@/lib/route-handlers";

/** Confirms (or withdraws) what the data cannot show: completeness, cash count, bank statements, other accounts. */
export const POST = postHandler("accounting.manage", async (body, actor) => ({ migration: await attest(body, actor) }), () => 200);
