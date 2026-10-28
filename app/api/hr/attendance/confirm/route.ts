import { confirmAttendance } from "@/lib/hr/attendance";
import { postHandler } from "@/lib/route-handlers";

/** Draft days of a date become confirmed. */
export const POST = postHandler("hr.attendance.record", (body, actor) => confirmAttendance(body, actor), () => 200);
