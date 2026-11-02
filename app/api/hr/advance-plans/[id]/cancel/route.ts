import { cancelAdvancePlan } from "@/lib/hr/advance-plans";
import { anyOf } from "@/lib/hr/attendance-http";
import { readJson } from "@/lib/http";

/** Stops a plan, with a reason (what was recovered stays). */
export const POST = anyOf(["hr.advances.manage", "hr.payroll.approve"], async (req, actor, params) => ({ plan: await cancelAdvancePlan(params.id, await readJson(req), actor) }));
