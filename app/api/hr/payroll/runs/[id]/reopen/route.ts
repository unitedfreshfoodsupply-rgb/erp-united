import { reopenRun } from "@/lib/hr/payroll";
import { postHandler } from "@/lib/route-handlers";

/** An approver withdraws an approval before posting, with a reason. */
export const POST = postHandler("hr.payroll.approve", async (body, actor, params) => ({ run: await reopenRun(params.id, body, actor) }), () => 200);
