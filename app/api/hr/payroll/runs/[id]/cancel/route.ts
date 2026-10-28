import { cancelRun } from "@/lib/hr/payroll";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("hr.payroll.prepare", async (body, actor, params) => ({ run: await cancelRun(params.id, body, actor) }), () => 200);
