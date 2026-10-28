import { attendanceDayDetail } from "@/lib/hr/attendance";
import { anyOf } from "@/lib/hr/attendance-http";

/** One day and every revision of it. */
export const GET = anyOf(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], (_req, actor, params) => attendanceDayDetail(params.id, actor));
