import { createEmployeeTransaction } from "@/lib/hr/service";
import { documentStatus, postHandler } from "@/lib/route-handlers";

/**
 * An advance paid, a reimbursement paid, or an advance returned: 201 { transaction }.
 * A purchasing-custody advance waits for a second person: 202 { custodyRequest } (200 on a replay).
 */
export const POST = postHandler(
  "hr.advances.manage",
  async (body, actor) => {
    const r = await createEmployeeTransaction(body, actor);
    return "custodyRequest" in r ? r : { transaction: r };
  },
  documentStatus
);
