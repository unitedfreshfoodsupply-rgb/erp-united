import { adjustLeaveBalance } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

/** An opening balance or a correction, with its reason. */
export const POST = postHandler("hr.leave.configure", async (body, actor) => ({ entry: await adjustLeaveBalance(body, actor) }));
