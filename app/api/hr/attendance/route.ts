import { attendanceRegister } from "@/lib/hr/attendance";
import { anyOf } from "@/lib/hr/attendance-http";
import { todayLocalISO } from "@/lib/localDate";

/** The daily register: everyone employed that day, with their entry or what the calendar suggests. */
export const GET = anyOf(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], (req, actor) => attendanceRegister(new URL(req.url).searchParams.get("date") || todayLocalISO(), actor));
