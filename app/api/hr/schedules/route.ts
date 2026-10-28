import { listSchedules, saveSchedule } from "@/lib/hr/attendance-config";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], async (_req, actor) => ({ schedules: await listSchedules(actor) }));

/** A weekly working pattern; weekly hours are computed from its days. */
export const POST = postHandler("hr.employees.manage", async (body, actor) => ({ schedule: await saveSchedule(null, body, actor) }));
