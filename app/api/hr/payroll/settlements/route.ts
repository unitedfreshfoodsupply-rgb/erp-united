import { createSettlement, listSettlements } from "@/lib/hr/settlement";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"], async (_req, actor) => ({ settlements: await listSettlements(actor) }));

/** The final settlement of a terminated employee: a final_settlement payroll run with its inputs. */
export const POST = postHandler("hr.payroll.prepare", async (body, actor) => ({ settlement: await createSettlement(body, actor) }));
