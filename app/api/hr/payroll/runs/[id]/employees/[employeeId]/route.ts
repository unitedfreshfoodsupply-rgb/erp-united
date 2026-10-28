import { updateRunEmployee } from "@/lib/hr/payroll";
import { postHandler } from "@/lib/route-handlers";

/** Inclusion, hold reason and the advance recovery for one payslip (draft or calculated runs only). */
export const PATCH = postHandler("hr.payroll.prepare", async (body, actor, params) => ({ payslip: await updateRunEmployee(params.id, params.employeeId, body, actor) }), () => 200);
