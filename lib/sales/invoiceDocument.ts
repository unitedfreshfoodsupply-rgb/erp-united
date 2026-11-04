/**
 * The UNITED invoice as a document to print — UNITED's own design, independent of the
 * ETA data format (ETA standardises the submitted data, not the layout). Pure: built
 * from the frozen invoice snapshot, so it is unit tested without a browser.
 *
 * Bilingual by structure: every label comes from one dictionary per language, the
 * direction follows the language, and figures are always Latin digits, left-to-right.
 */
import { formatNumber } from "@/lib/format";

export type InvoiceLang = "ar" | "en";

export const INVOICE_LABELS = {
  ar: {
    title: "فاتورة ضريبية", subtitle: "Tax Invoice", seller: "المورّد", buyer: "العميل", taxId: "رقم التسجيل الضريبي", commercialReg: "السجل التجاري",
    customerCode: "كود العميل", invoiceNo: "رقم الفاتورة", issueDate: "تاريخ الإصدار", issueTime: "وقت الإصدار", dueDate: "تاريخ الاستحقاق", order: "أمر التوريد",
    delivery: "التسليم", currency: "العملة", no: "#", item: "الصنف", qty: "الكمية", unit: "الوحدة", unitPrice: "سعر الوحدة", discount: "الخصم", net: "الصافي",
    tax: "الضريبة", lineTotal: "الإجمالي", exempt: "معفى", subtotal: "الإجمالي قبل الخصم", totalDiscount: "إجمالي الخصم", netTotal: "الصافي بعد الخصم",
    totalTax: "إجمالي الضريبة", grandTotal: "إجمالي الفاتورة", taxSummary: "ملخص الضريبة", taxBase: "الوعاء", rate: "النسبة", payment: "السداد",
    terms: "شروط الدفع", cash: "نقدي عند التسليم", days: (n: number) => `آجل ${n} يوم`, paid: "المدفوع", balance: "المتبقي", paidInFull: "مدفوعة بالكامل",
    receipts: "إيصالات التحصيل", eta: "الفاتورة الإلكترونية — مصلحة الضرائب", etaUuid: "الرقم الإلكتروني (UUID)", etaLongId: "الرقم المرجعي",
    etaStatus: "الحالة", etaSubmitted: "تاريخ الإرسال", etaAccepted: "تاريخ القبول", thanks: "شكرًا لتعاملكم مع UNITED", page: "صفحة",
  },
  en: {
    title: "Tax Invoice", subtitle: "فاتورة ضريبية", seller: "Seller", buyer: "Customer", taxId: "Tax registration no.", commercialReg: "Commercial registry",
    customerCode: "Customer code", invoiceNo: "Invoice no.", issueDate: "Issue date", issueTime: "Issue time", dueDate: "Due date", order: "Order",
    delivery: "Delivery", currency: "Currency", no: "#", item: "Item", qty: "Qty", unit: "Unit", unitPrice: "Unit price", discount: "Discount", net: "Net",
    tax: "Tax", lineTotal: "Total", exempt: "Exempt", subtotal: "Subtotal", totalDiscount: "Total discount", netTotal: "Net after discount",
    totalTax: "Total tax", grandTotal: "Invoice total", taxSummary: "Tax summary", taxBase: "Taxable amount", rate: "Rate", payment: "Payment",
    terms: "Payment terms", cash: "Cash on delivery", days: (n: number) => `Net ${n} days`, paid: "Paid", balance: "Balance due", paidInFull: "Paid in full",
    receipts: "Receipts", eta: "E-invoice — Egyptian Tax Authority", etaUuid: "Document UUID", etaLongId: "Long ID",
    etaStatus: "Status", etaSubmitted: "Submitted", etaAccepted: "Accepted", thanks: "Thank you for choosing UNITED", page: "Page",
  },
} as const;

const ETA_STATUS_LABEL: Record<InvoiceLang, Record<string, string>> = {
  ar: { submitted: "مُرسلة — قيد التحقق", valid: "مقبولة", cancelled: "ملغية" },
  en: { submitted: "Submitted — being validated", valid: "Valid", cancelled: "Cancelled" },
};
/** Only states that are facts about the document are printed — never errors or retries. */
const PRINTABLE_ETA = new Set(["submitted", "valid", "cancelled"]);

type Num = string | number | { toString(): string };

export type InvoiceDocInput = {
  invoice: {
    number: string | null; status: string; issueDate: string | null; dueDate: string | null; issuedAt: Date | string | null; currencyCode: string;
    buyerName: string | null; buyerTaxId: string | null; buyerAddress: string | null; notes: string | null;
    gross: Num; discountTotal: Num; net: Num; taxTotal: Num; total: Num; paid: Num; open: Num | null;
    customer: { code: string; paymentTermsDays: number } | null;
    order: { orderNumber: string; deliveryDate: string } | null;
    lines: { lineNo: number; description: string; uomCode: string; quantity: Num; unitPrice: Num; discountPct: Num; discount: Num; net: Num; taxCode: string; taxRate: Num; tax: Num; total: Num }[];
    payments: { number: string; date: string; amount: Num }[];
  };
  company: { legalName: string; tradeName: string | null; nameAr: string | null; taxRegistrationNumber: string | null; commercialRegistration: string | null; address: string | null; phone: string | null; email: string | null } | null;
  eta: { status: string; uuid: string | null; longId: string | null; submittedAt: Date | string | null; acceptedAt: Date | string | null } | null;
  lang: InvoiceLang;
};

const money = (v: Num) => formatNumber(v.toString(), { minDp: 2, maxDp: 2 });
const qty = (v: Num) => formatNumber(v.toString(), { maxDp: 3 });
const price = (v: Num) => formatNumber(v.toString(), { minDp: 2, maxDp: 4 });
const cairo = (d: Date | string, opts: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Cairo", ...opts });

export function invoiceDocument(input: InvoiceDocInput) {
  const { invoice: inv, company, eta, lang } = input;
  const L = INVOICE_LABELS[lang];
  const taxes = new Map<string, { label: string; rate: number; base: number; tax: number }>();
  for (const l of inv.lines) {
    const rate = Number(l.taxRate.toString());
    const t = taxes.get(l.taxCode) ?? { label: rate ? `${l.taxCode} ${rate}%` : `${l.taxCode} · ${L.exempt}`, rate, base: 0, tax: 0 };
    t.base += Number(l.net.toString());
    t.tax += Number(l.tax.toString());
    taxes.set(l.taxCode, t);
  }
  // An issued invoice prints the terms it was issued with — its frozen due date less its issue
  // date (issue sets one from the other) — never the customer's terms of today. A draft shows the
  // customer's current terms, which issue will apply.
  const termDays = inv.issueDate && inv.dueDate
    ? Math.round((Date.parse(`${inv.dueDate}T00:00:00Z`) - Date.parse(`${inv.issueDate}T00:00:00Z`)) / 86_400_000)
    : inv.customer?.paymentTermsDays ?? null;
  const terms = termDays === null || Number.isNaN(termDays) ? null : termDays > 0 ? L.days(termDays) : L.cash;
  const open = inv.open === null ? null : Number(inv.open.toString());
  return {
    lang,
    dir: lang === "ar" ? ("rtl" as const) : ("ltr" as const),
    labels: L,
    seller: company && {
      name: (lang === "ar" ? company.nameAr : null) ?? company.tradeName ?? company.legalName,
      legalName: company.legalName,
      taxId: company.taxRegistrationNumber, commercialReg: company.commercialRegistration,
      address: company.address, phone: company.phone, email: company.email,
    },
    buyer: { name: inv.buyerName ?? "", taxId: inv.buyerTaxId, address: inv.buyerAddress, code: inv.customer?.code ?? null },
    meta: {
      number: inv.number ?? "",
      issueDate: inv.issueDate ?? "",
      issueTime: inv.issuedAt ? cairo(inv.issuedAt, { hour: "2-digit", minute: "2-digit", hour12: false }) : null,
      dueDate: inv.dueDate,
      order: inv.order?.orderNumber ?? null,
      delivery: inv.order?.deliveryDate ?? null,
      currency: inv.currencyCode,
    },
    lines: inv.lines.map((l) => ({
      no: l.lineNo, description: l.description, qty: qty(l.quantity), unit: l.uomCode, unitPrice: price(l.unitPrice),
      discount: Number(l.discount.toString()) ? `${money(l.discount)}${Number(l.discountPct.toString()) ? ` (${Number(l.discountPct.toString())}%)` : ""}` : "—",
      net: money(l.net), tax: Number(l.taxRate.toString()) ? `${money(l.tax)} (${Number(l.taxRate.toString())}%)` : L.exempt, total: money(l.total),
    })),
    totals: { gross: money(inv.gross), discount: money(inv.discountTotal), net: money(inv.net), tax: money(inv.taxTotal), total: money(inv.total), hasDiscount: Number(inv.discountTotal.toString()) !== 0 },
    taxSummary: [...taxes.values()].map((t) => ({ label: t.label, rate: t.rate, base: money(t.base), tax: money(t.tax) })),
    payment: {
      terms, dueDate: inv.dueDate, paid: money(inv.paid), balance: open === null ? null : money(open), paidInFull: open !== null && open <= 0,
      receipts: inv.payments.map((p) => ({ number: p.number, date: p.date, amount: money(p.amount) })),
    },
    notes: inv.notes,
    eta: eta && PRINTABLE_ETA.has(eta.status) && eta.uuid
      ? {
          status: ETA_STATUS_LABEL[lang][eta.status] ?? eta.status,
          uuid: eta.uuid,
          longId: eta.longId,
          submittedAt: eta.submittedAt ? cairo(eta.submittedAt, { dateStyle: "short", timeStyle: "short", hour12: false }) : null,
          acceptedAt: eta.acceptedAt ? cairo(eta.acceptedAt, { dateStyle: "short", timeStyle: "short", hour12: false }) : null,
        }
      : null,
  };
}

export type InvoiceDocument = ReturnType<typeof invoiceDocument>;
