import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { todayLocalISO } from "@/lib/localDate";
import { customerStatement } from "@/lib/sales/invoicing";
import { statementLine } from "@/lib/locale/statement-text";
import { STATEMENT_COLUMNS, STATEMENT_KIND, csvResponse, exportLang, nameIn, toCsv, toCsvColumns, tr } from "@/lib/core/csv-export";


/** Excel-safe CSV export of a customer statement — same data as the JSON view. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requirePermission(req, "sales.invoices.view");
    const sp = new URL(req.url).searchParams;
    const to = sp.get("to") ?? todayLocalISO();
    const from = sp.get("from") ?? `${to.slice(0, 4)}-01-01`;
    const st = await customerStatement(params.id, from, to);
    // No ?lang: the original output (machine-key header, kinds as codes). ?lang=ar|en: titled, translated.
    const lang = exportLang(sp);
    const L = lang ?? "ar";
    const rows: Record<string, unknown>[] = [
      { date: tr(L, "كشف حساب", "Statement of account"), kind: lang ? nameIn(lang, st.customer) : st.customer.name, number: tr(L, `من ${st.from} إلى ${st.to}`, `${st.from} to ${st.to}`), reference: "", debit: "", credit: "", balance: "" },
      { date: st.opening, kind: tr(L, "الرصيد الافتتاحي", "Opening balance"), number: "", reference: "", debit: "", credit: "", balance: st.opening },
      ...st.rows.map((r) => ({ date: r.date, kind: lang ? STATEMENT_KIND[r.kind]?.[lang] ?? r.kind : r.kind, number: lang === "en" ? statementLine(r, "en").number : r.number, reference: lang === "en" ? statementLine(r, "en").ref : r.ref, debit: r.debit, credit: r.credit, balance: r.balance })),
      { date: st.closing, kind: tr(L, "الرصيد الختامي", "Closing balance"), number: "", reference: "", debit: "", credit: "", balance: st.closing },
    ];
    return csvResponse(lang ? toCsvColumns(rows, STATEMENT_COLUMNS, lang) : toCsv(rows), `customer-statement-${st.customer.code || st.customer.id}-${from}-${to}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}