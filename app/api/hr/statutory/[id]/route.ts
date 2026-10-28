import { saveRuleSet } from "@/lib/hr/statutory";
import { postHandler } from "@/lib/route-handlers";

export const PATCH = postHandler("hr.statutory.manage", async (body, actor, params) => ({ ruleSet: await saveRuleSet(params.id, body, actor) }), () => 200);
