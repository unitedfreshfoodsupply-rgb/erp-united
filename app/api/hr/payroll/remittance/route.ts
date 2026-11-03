import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { csvResponse, toCsv, toCsvColumns } from "@/lib/core/csv-export";
import { PAYROLL_CSV_COLUMNS } from "@/lib/hr/csv-columns";
import { remittanceReport } from "@/lib/hr/remittance";

/** Monthly SI / salary tax / levy summary per employee from posted runs (?period=YYYY-MM, &format=csv). Not an official form. */
export async function GET(req: NextRequest) {
  try {
    const actor = serviceActorFromContext(await requireAnyPermission(req, ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"]));
    const url = new URL(req.url);
    const csv = url.searchParams.get("format") === "csv";
    const report = await remittanceReport(url.searchParams.get("period") ?? "", actor, { export: csv });
    const lang = url.searchParams.get("lang");
    if (csv) {
      // Machine-readable keys by default; ?lang=ar|en titles the columns for people.
      const keys = Object.keys(report.rows[0] ?? {});
      const body = lang === "ar" || lang === "en" ? toCsvColumns(report.rows, keys.map((k) => ({ key: k, ...(PAYROLL_CSV_COLUMNS[k] ?? { ar: k, en: k }) })), lang) : toCsv(report.rows);
      return csvResponse(body, `payroll-remittance-${report.period}`);
    }
    return NextResponse.json({ report });
  } catch (err) {
    return handleApiError(err, req);
  }
}
