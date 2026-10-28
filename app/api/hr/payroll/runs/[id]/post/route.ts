import { postRun } from "@/lib/hr/payroll-posting";
import { postHandler } from "@/lib/route-handlers";

/** Posts an approved run to the ledger, once. */
export const POST = postHandler("hr.payroll.post", async (_body, actor, params) => ({ run: await postRun(params.id, actor) }), () => 200);
