import { leaveLedger } from "@/lib/hr/leave";
import { anyOf } from "@/lib/hr/attendance-http";

export const GET = anyOf(["hr.leave.request", "hr.leave.approve", "hr.leave.configure"], async (req, actor) => ({ entries: await leaveLedger(new URL(req.url).searchParams.get("employee_id") ?? "", actor) }));
