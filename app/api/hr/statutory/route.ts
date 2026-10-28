import { listRuleSets, saveRuleSet } from "@/lib/hr/statutory";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.statutory.manage", "hr.payroll.prepare", "hr.payroll.approve", "hr.payroll.view"], async (_req, actor) => ({ ruleSets: await listRuleSets(actor) }));

/** A draft rule set: values typed from the official source, verified later by someone else. */
export const POST = postHandler("hr.statutory.manage", async (body, actor) => ({ ruleSet: await saveRuleSet(null, body, actor) }));
