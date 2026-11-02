import { createAdvancePlan, listAdvancePlans } from "@/lib/hr/advance-plans";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.advances.manage", "hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve"], async (req, actor) => ({ plans: await listAdvancePlans(actor, { employeeId: new URL(req.url).searchParams.get("employee_id") }) }));

/** An instalment plan for an advance; deducted from payroll only once someone else approves it. */
export const POST = postHandler("hr.advances.manage", async (body, actor) => ({ plan: await createAdvancePlan(body, actor) }));
