import { deleteHoliday } from "@/lib/hr/attendance-config";
import { anyOf } from "@/lib/hr/attendance-http";

/** Removed only while no confirmed or locked day of that date relies on it. */
export const DELETE = anyOf(["hr.employees.manage"], (_req, actor, params) => deleteHoliday(params.id, actor));
