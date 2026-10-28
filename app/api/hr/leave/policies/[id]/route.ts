import { savePolicy } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

/** Changes a draft policy (verified policies are never edited). */
export const PATCH = postHandler("hr.leave.configure", async (body, actor, params) => ({ policy: await savePolicy(params.id, body, actor) }), () => 200);
