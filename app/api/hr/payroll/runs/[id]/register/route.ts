import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { payrollRegister } from "@/lib/hr/payroll-posting";
import { csvResponse, toCsv } from "@/lib/core/csv-export";

/** The payroll register: one row per included payslip, a column per component (Excel-safe CSV). */
export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"]));
    const { run, rows } = await payrollRegister(ctx.params.id, actor);
    return csvResponse(toCsv(rows), `payroll-register-${run.number}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}
