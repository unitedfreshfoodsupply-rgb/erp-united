import { verifyPolicy } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

/** A second person confirms the values against their source. */
export const POST = postHandler("hr.leave.configure", async (_body, actor, params) => ({ policy: await verifyPolicy(params.id, actor) }), () => 200);
