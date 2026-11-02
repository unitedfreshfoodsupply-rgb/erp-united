import { rolloverLeave } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

/** Year-end carry-over and expiry for one leave type, by the policy in force on 31 December — idempotent. */
export const POST = postHandler("hr.leave.configure", (body, actor) => rolloverLeave(body, actor), () => 200);
