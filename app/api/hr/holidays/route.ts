import { createHoliday, listHolidays } from "@/lib/hr/attendance-config";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], async (req, actor) => ({ holidays: await listHolidays(actor, new URL(req.url).searchParams.get("year")) }));

/** An official holiday, with the decree or announcement it comes from. */
export const POST = postHandler("hr.employees.manage", async (body, actor) => ({ holiday: await createHoliday(body, actor) }));
