import { saveComponent } from "@/lib/hr/compensation";
import { postHandler } from "@/lib/route-handlers";

export const PATCH = postHandler("hr.compensation.manage", async (body, actor, params) => ({ component: await saveComponent(params.id, body, actor) }), () => 200);
