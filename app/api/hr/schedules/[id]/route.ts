import { saveSchedule } from "@/lib/hr/attendance-config";
import { postHandler } from "@/lib/route-handlers";

export const PATCH = postHandler("hr.employees.manage", async (body, actor, params) => ({ schedule: await saveSchedule(params.id, body, actor) }), () => 200);
