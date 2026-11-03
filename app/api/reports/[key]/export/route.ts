import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAuth } from "@/lib/authz";
import { reportCsv, reportParams, reportXls, runReport } from "@/lib/reports/engine";

/** A report as a file: ?format=csv|xls and ?lang=ar|en (headers, title and direction in that language). */
export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  try {
    const ctx = await requireAuth(req);
    const sp = new URL(req.url).searchParams;
    const lang = sp.get("lang") === "en" ? "en" : "ar";
    const r = await runReport(params.key, reportParams(sp), ctx);
    const base = `${r.key}_${r.params.from}_${r.params.to}_${lang}`;
    if (sp.get("format") === "xls") {
      return new NextResponse(reportXls(r, lang), { headers: { "Content-Type": "application/vnd.ms-excel; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.xls"`, "Cache-Control": "no-store" } });
    }
    return new NextResponse(reportCsv(r, lang), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.csv"`, "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err, req);
  }
}
