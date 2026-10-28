import { createRun, listRuns } from "@/lib/hr/payroll";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"], async (_req, actor) => ({ runs: await listRuns(actor) }));

/** The month's regular run, with a payslip for everyone employed in it. */
export const POST = postHandler("hr.payroll.prepare", async (body, actor) => ({ run: await createRun(body, actor) }));
