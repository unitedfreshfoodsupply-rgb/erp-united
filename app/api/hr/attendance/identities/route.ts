import { addIdentity } from "@/lib/hr/attendance-config";
import { postHandler } from "@/lib/route-handlers";

/** Maps a device's user number to an employee. */
export const POST = postHandler("hr.employees.manage", async (body, actor) => ({ identity: await addIdentity(body, actor) }));
