import { saveAttendanceDays } from "@/lib/hr/attendance";
import { postHandler } from "@/lib/route-handlers";

/** Saves one date of the register as drafts (confirmed and locked days need a correction). */
export const POST = postHandler("hr.attendance.record", (body, actor) => saveAttendanceDays(body, actor), () => 200);
