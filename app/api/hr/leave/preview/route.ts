import { previewLeave } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

/** How many days a request would take and the balance it would draw on — nothing is saved. */
export const POST = postHandler("hr.leave.request", (body, actor) => previewLeave(body, actor), () => 200);
