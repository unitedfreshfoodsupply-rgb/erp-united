import { verifyRuleSet } from "@/lib/hr/statutory";
import { postHandler } from "@/lib/route-handlers";

/** A second person confirms the values against their source; payroll may use them from then on. */
export const POST = postHandler("hr.statutory.manage", async (_body, actor, params) => ({ ruleSet: await verifyRuleSet(params.id, actor) }), () => 200);
