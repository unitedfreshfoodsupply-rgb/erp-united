import { submitRun } from "@/lib/hr/payroll";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("hr.payroll.prepare", async (_body, actor, params) => ({ run: await submitRun(params.id, actor) }), () => 200);
