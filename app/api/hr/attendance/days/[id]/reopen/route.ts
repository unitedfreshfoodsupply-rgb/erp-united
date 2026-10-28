import { reopenAttendanceDay } from "@/lib/hr/attendance";
import { postHandler } from "@/lib/route-handlers";

/** An approver sends a confirmed day back to draft, with a reason. */
export const POST = postHandler("hr.attendance.approve", async (body, actor, params) => ({ day: await reopenAttendanceDay(params.id, body, actor) }), () => 200);
