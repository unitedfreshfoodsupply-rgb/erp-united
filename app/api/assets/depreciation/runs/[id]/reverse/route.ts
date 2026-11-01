import { reverseDepreciationRun } from "@/lib/accounting/fixed-assets";
import { postHandler } from "@/lib/route-handlers";

/** Reverse a whole depreciation run (its month open; nothing later depreciated or disposed). */
export const POST = postHandler("accounting.assets.manage", async (body, actor, params) => ({ run: await reverseDepreciationRun(params.id, body, actor) }), () => 200);
