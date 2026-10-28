import { listCorrections, requestAttendanceCorrection } from "@/lib/hr/attendance";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], async (req, actor) => ({ corrections: await listCorrections(actor, new URL(req.url).searchParams.get("status")) }));

/** Asks to change a confirmed or locked day; applied only when someone else approves it. */
export const POST = postHandler("hr.attendance.record", async (body, actor) => ({ correction: await requestAttendanceCorrection(body, actor) }));
