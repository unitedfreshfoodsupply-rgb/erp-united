import { saveLeaveType } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

export const PATCH = postHandler("hr.leave.configure", async (body, actor, params) => ({ type: await saveLeaveType(params.id, body, actor) }), () => 200);
