import { compileDeviceAttendance } from "@/lib/hr/attendance";
import { postHandler } from "@/lib/route-handlers";

/** Turns mapped device punches into draft days (never over a manual, corrected, confirmed or locked day). */
export const POST = postHandler("hr.attendance.record", (body, actor) => compileDeviceAttendance(body, actor), () => 200);
