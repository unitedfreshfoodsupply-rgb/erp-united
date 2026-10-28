import { listLeaveRequests, requestLeave } from "@/lib/hr/leave";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.leave.request", "hr.leave.approve", "hr.leave.configure"], async (req, actor) => {
  const p = new URL(req.url).searchParams;
  return { requests: await listLeaveRequests(actor, { status: p.get("status"), employeeId: p.get("employee_id") }) };
});

/** Records a leave request and sends it for approval by someone else. */
export const POST = postHandler("hr.leave.request", async (body, actor) => ({ request: await requestLeave(body, actor) }));
