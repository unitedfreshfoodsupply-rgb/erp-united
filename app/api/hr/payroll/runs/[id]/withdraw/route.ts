import { withdrawRun } from "@/lib/hr/payroll";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("hr.payroll.prepare", async (body, actor, params) => ({ run: await withdrawRun(params.id, body, actor) }), () => 200);
