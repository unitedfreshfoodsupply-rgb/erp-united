import { retirePolicy } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

/** Ends a verified policy (or discards a draft). */
export const POST = postHandler("hr.leave.configure", async (body, actor, params) => ({ policy: await retirePolicy(params.id, body, actor) }), () => 200);
