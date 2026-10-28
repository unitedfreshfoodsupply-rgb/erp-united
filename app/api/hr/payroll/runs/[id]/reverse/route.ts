import { reverseRun } from "@/lib/hr/payroll-posting";
import { postHandler } from "@/lib/route-handlers";

/** Reverses a posted run that has no live payments, with a reason. */
export const POST = postHandler("hr.payroll.post", async (body, actor, params) => ({ run: await reverseRun(params.id, body, actor) }), () => 200);
