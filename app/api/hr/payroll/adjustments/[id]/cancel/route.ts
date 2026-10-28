import { cancelAdjustment } from "@/lib/hr/payroll";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("hr.payroll.prepare", async (_body, actor, params) => ({ adjustment: await cancelAdjustment(params.id, actor) }), () => 200);
