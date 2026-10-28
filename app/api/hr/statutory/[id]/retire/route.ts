import { retireRuleSet } from "@/lib/hr/statutory";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("hr.statutory.manage", async (body, actor, params) => ({ ruleSet: await retireRuleSet(params.id, body, actor) }), () => 200);
