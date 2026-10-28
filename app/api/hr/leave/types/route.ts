import { listLeaveTypes, saveLeaveType } from "@/lib/hr/leave";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.leave.request", "hr.leave.approve", "hr.leave.configure"], async (_req, actor) => ({ types: await listLeaveTypes(actor) }));

/** A leave type: how it is paid and how its days are counted (company / statutory input). */
export const POST = postHandler("hr.leave.configure", async (body, actor) => ({ type: await saveLeaveType(null, body, actor) }));
