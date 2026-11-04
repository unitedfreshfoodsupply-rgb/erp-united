import { COMPANY_GAP_LABELS, type CompanyDocumentGap } from "@/lib/core/document-snapshot";

/**
 * On screen only, above a commercial document: the company details the document needs and the
 * company record does not have. Never printed, and the document never fills them in — an
 * administrator completes the company record (Admin → Company, Stores & Units).
 */
export function DocumentGapNotice({ gaps, lang }: { gaps: CompanyDocumentGap[]; lang: "ar" | "en" }) {
  if (!gaps.length) return null;
  const fields = gaps.map((g) => COMPANY_GAP_LABELS[lang][g]).join(lang === "ar" ? "، " : ", ");
  return (
    <div role="status" data-testid="document-gaps" className="no-print doc-screen-only mb-4 rounded-lg border border-united-warn/40 bg-united-warn/10 px-3 py-2 text-sm font-bold text-united-dark">
      {lang === "ar"
        ? `بيانات الشركة ناقصة على المستند: ${fields} — بتتكمّل من الإدارة ← الشركة والمخازن والوحدات (مش من الفاتورة).`
        : `Company details missing from this document: ${fields} — completed in Admin → Company, Stores & Units (not on the invoice).`}
    </div>
  );
}
