import { recordEmploymentChange } from "@/lib/hr/employment";
import { postHandler } from "@/lib/route-handlers";

/** A transfer, promotion, status change, contract change, termination or re-hire — a new history row. */
export const POST = postHandler("hr.employees.manage", async (body, actor, params) => ({ employment: await recordEmploymentChange(params.id, body, actor) }));
