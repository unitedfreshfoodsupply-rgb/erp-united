import { approveAdvancePlan } from "@/lib/hr/advance-plans";
import { postHandler } from "@/lib/route-handlers";

/** Approves a pending plan (never its author). */
export const POST = postHandler("hr.payroll.approve", async (_body, actor, params) => ({ plan: await approveAdvancePlan(params.id, actor) }), () => 200);
