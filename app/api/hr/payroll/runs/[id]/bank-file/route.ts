import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { bankPaymentFile } from "@/lib/hr/payroll-posting";
import { csvResponse, toCsv, toCsvColumns } from "@/lib/core/csv-export";
import { PAYROLL_CSV_COLUMNS } from "@/lib/hr/csv-columns";

/** What is unpaid per payslip with verified salary accounts — a generic list, not a bank's upload format. */
export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  try {
    // The service also requires hr.private.view (account numbers are private data).
    const actor = serviceActorFromContext(await requirePermission(req, "hr.payroll.pay"));
    const { run, rows } = await bankPaymentFile(ctx.params.id, actor);
    // Machine-readable keys by default (a generic list for upload tools); ?lang=ar|en titles the columns for people.
    const lang = new URL(req.url).searchParams.get("lang");
    const keys = Object.keys(rows[0] ?? {});
    const body = lang === "ar" || lang === "en" ? toCsvColumns(rows, keys.map((k) => ({ key: k, ...(PAYROLL_CSV_COLUMNS[k] ?? { ar: k, en: k }) })), lang) : toCsv(rows);
    return csvResponse(body, `payroll-bank-${run.number}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}
