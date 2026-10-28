import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { bankPaymentFile } from "@/lib/hr/payroll-posting";
import { csvResponse, toCsv } from "@/lib/core/csv-export";

/** What is unpaid per payslip with verified salary accounts — a generic list, not a bank's upload format. */
export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  try {
    // The service also requires hr.private.view (account numbers are private data).
    const actor = serviceActorFromContext(await requirePermission(req, "hr.payroll.pay"));
    const { run, rows } = await bankPaymentFile(ctx.params.id, actor);
    return csvResponse(toCsv(rows), `payroll-bank-${run.number}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}
