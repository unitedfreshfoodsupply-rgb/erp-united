import { listComponents, saveComponent } from "@/lib/hr/compensation";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.compensation.view", "hr.compensation.manage", "hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve"], async (_req, actor) => ({ components: await listComponents(actor) }));

/** A pay component; inactive until its tax and insurance treatment is set. */
export const POST = postHandler("hr.compensation.manage", async (body, actor) => ({ component: await saveComponent(null, body, actor) }));
