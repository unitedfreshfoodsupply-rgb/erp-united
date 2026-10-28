import { cancelAttendanceCorrection } from "@/lib/hr/attendance";
import { anyOf } from "@/lib/hr/attendance-http";

/** The requester (or an approver) withdraws a pending correction. */
export const POST = anyOf(["hr.attendance.record", "hr.attendance.approve"], async (_req, actor, params) => ({ correction: await cancelAttendanceCorrection(params.id, actor) }));
