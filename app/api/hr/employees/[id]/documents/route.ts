import { registerDocument } from "@/lib/hr/private-data";
import { postHandler } from "@/lib/route-handlers";

/** Type, number and expiry for a file already attached to the employee (POST /api/attachments, entity "employee"). */
export const POST = postHandler("hr.private.manage", async (body, actor, params) => ({ document: await registerDocument(params.id, body, actor) }));
