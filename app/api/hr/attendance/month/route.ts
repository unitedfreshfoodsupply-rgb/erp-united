import { attendanceMonth } from "@/lib/hr/attendance";
import { anyOf } from "@/lib/hr/attendance-http";
import { todayLocalISO } from "@/lib/localDate";

/** The month grid with per-employee totals. */
export const GET = anyOf(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], (req, actor) => attendanceMonth(new URL(req.url).searchParams.get("month") || todayLocalISO().slice(0, 7), actor));
