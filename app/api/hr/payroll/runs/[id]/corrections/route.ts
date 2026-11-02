import { createCorrectionRun } from "@/lib/hr/payroll";
import { postHandler } from "@/lib/route-handlers";

/** A correction run of a posted regular run: posts only the differences (idempotent by key). */
export const POST = postHandler("hr.payroll.prepare", async (body, actor, params) => ({ run: await createCorrectionRun(params.id, body, actor) }));
