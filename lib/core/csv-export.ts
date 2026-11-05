/** Excel-safe CSV export helpers (UTF-8 BOM + RFC 4180 quoting). */
const BOM = "\uFEFF";

/**
 * A cell a spreadsheet would run as a formula — "=HYPERLINK(…)", "@SUM(…)", a leading tab
 * or CR, or "+"/"-" followed by anything but a number — opens as the text it is: a leading
 * apostrophe is added (CSV formula injection). Names and notes typed at the gate or sent by
 * an integration reach these files. Signed amounts and phone numbers ("-12.50", "+2010…")
 * are not formulas and stay exactly as stored.
 */
function asText(s: string): string {
  const formula = /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s.,()]*%?$/.test(s));
  return formula ? `'${s}` : s;
}

/** Quote a cell per RFC 4180: wrap in quotes, double any inner quotes. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = asText(String(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a CSV document with a UTF-8 BOM so Microsoft Excel renders Arabic and
 * other non-Latin text correctly instead of mojibake. `rows` are objects; keys
 * of the first row define the column order.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return BOM;
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  return BOM + lines.join("\r\n");
}

export function csvResponse(csv: string, filename: string) {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}.csv"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * Export language (maturity 2026-11): `?lang=ar|en` writes titled columns and labels in that
 * language. Without it (null) a route writes exactly what it wrote before — machine keys as
 * the header row and values as stored — so existing integrations keep their contract.
 */
export type ExportLang = "ar" | "en";
export const exportLang = (sp: URLSearchParams): ExportLang | null => (sp.get("lang") === "en" ? "en" : sp.get("lang") === "ar" ? "ar" : null);
export const tr = (lang: ExportLang, ar: string, en: string) => (lang === "en" ? en : ar);
/** A party or product name in the export's language (falls back to the name it has). */
/** A party's name in the export's language. Some DTOs put the Arabic name in `name` and the English one in `nameEn`. */
export const nameIn = (lang: ExportLang, x: { name: string; nameAr?: string | null; nameEn?: string | null }) => (lang === "ar" ? x.nameAr || x.name : x.nameEn || x.name || x.nameAr || "");

export type CsvColumn = { key: string; ar: string; en: string };
/** Rows with fixed keys, written under the chosen language's column titles (header kept even when empty). */
export function toCsvColumns(rows: Record<string, unknown>[], columns: CsvColumn[], lang: ExportLang): string {
  const lines = [columns.map((c) => csvCell(c[lang])).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key])).join(","));
  return BOM + lines.join("\r\n");
}

/** Statement line kinds (customer and supplier statements), by language. */
export const STATEMENT_KIND: Record<string, { ar: string; en: string }> = {
  invoice: { ar: "فاتورة", en: "Invoice" },
  credit_note: { ar: "إشعار دائن", en: "Credit note" },
  receipt: { ar: "تحصيل", en: "Receipt" },
  receipt_reversal: { ar: "عكس تحصيل", en: "Receipt reversal" },
  refund: { ar: "رد مبلغ", en: "Refund" },
  charge: { ar: "مستحق إضافي", en: "Charge" },
  opening_balance: { ar: "رصيد افتتاحي", en: "Opening balance" },
  bill: { ar: "فاتورة مورد", en: "Supplier bill" },
  debit_note: { ar: "إشعار مدين", en: "Debit note" },
  payment: { ar: "سداد", en: "Payment" },
  payment_reversal: { ar: "عكس سداد", en: "Payment reversal" },
};
export const STATEMENT_COLUMNS: CsvColumn[] = [
  { key: "date", ar: "التاريخ", en: "Date" }, { key: "kind", ar: "النوع", en: "Type" }, { key: "number", ar: "الرقم", en: "Number" },
  { key: "reference", ar: "المرجع", en: "Reference" }, { key: "debit", ar: "مدين", en: "Debit" }, { key: "credit", ar: "دائن", en: "Credit" }, { key: "balance", ar: "الرصيد", en: "Balance" },
];
