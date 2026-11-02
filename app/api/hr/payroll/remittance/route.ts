import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { csvResponse, toCsv } from "@/lib/core/csv-export";
import { remittanceReport } from "@/lib/hr/remittance";

/** Monthly SI / salary tax / levy summary per employee from posted runs (?period=YYYY-MM, &format=csv). Not an official form. */
export async function GET(req: NextRequest) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"]));
    const url = new URL(req.url);
    const csv = url.searchParams.get("format") === "csv";
    const report = await remittanceReport(url.searchParams.get("period") ?? "", actor, { export: csv });
    if (csv) return csvResponse(toCsv(report.rows), `payroll-remittance-${report.period}`);
    return NextResponse.json({ report });
  } catch (err) {
    return handleApiError(err, req);
  }
}
