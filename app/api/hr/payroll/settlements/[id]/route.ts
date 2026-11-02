import { getSettlement, updateSettlement } from "@/lib/hr/settlement";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"], async (_req, actor, params) => ({ settlement: await getSettlement(params.id, actor) }));

/** Items, leave encashment and advance recovery, while the settlement run is a draft or calculated. */
export const PATCH = postHandler("hr.payroll.prepare", async (body, actor, params) => ({ settlement: await updateSettlement(params.id, body, actor) }), () => 200);
