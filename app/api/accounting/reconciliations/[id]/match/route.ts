import { matchStatement } from "@/lib/accounting/cash";
import { postHandler } from "@/lib/route-handlers";

/** Bank statement lines (CSV or JSON) matched against the uncleared book lines; `apply` ticks the matches. */
export const POST = postHandler("accounting.manage", async (body, actor, params) => ({ result: await matchStatement(params.id, body, actor) }), () => 200);
