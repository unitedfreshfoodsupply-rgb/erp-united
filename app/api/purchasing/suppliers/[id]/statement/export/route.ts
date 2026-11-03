import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { todayLocalISO } from "@/lib/localDate";
import { supplierStatement } from "@/lib/purchasing/bills";
import { STATEMENT_COLUMNS, STATEMENT_KIND, csvResponse, exportLang, nameIn, toCsvColumns, tr } from "@/lib/core/csv-export";

/** Excel-safe CSV export of a supplier statement — same data as the JSON view. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requirePermission(req, "purchasing.bills.view");
    const sp = new URL(req.url).searchParams;
    const to = sp.get("to") ?? todayLocalISO();
    const from = sp.get("from") ?? `${to.slice(0, 4)}-01-01`;
    const st = await supplierStatement(params.id, from, to);
    const lang = exportLang(sp);
    const rows: Record<string, unknown>[] = [
      { date: tr(lang, "كشف حساب", "Statement of account"), kind: nameIn(lang, st.supplier), number: tr(lang, `من ${st.from} إلى ${st.to}`, `${st.from} to ${st.to}`), reference: "", debit: "", credit: "", balance: "" },
      { date: st.opening, kind: tr(lang, "الرصيد الافتتاحي", "Opening balance"), number: "", reference: "", debit: "", credit: "", balance: st.opening },
      ...st.rows.map((r) => ({ date: r.date, kind: STATEMENT_KIND[r.kind]?.[lang] ?? r.kind, number: r.number, reference: r.ref, debit: r.debit, credit: r.credit, balance: r.balance })),
      { date: st.closing, kind: tr(lang, "الرصيد الختامي", "Closing balance"), number: "", reference: "", debit: "", credit: "", balance: st.closing },
    ];
    return csvResponse(toCsvColumns(rows, STATEMENT_COLUMNS, lang), `supplier-statement-${st.supplier.code || st.supplier.id}-${from}-${to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}