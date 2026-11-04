/**
 * A supplier bill as a document to print (Nov 2026): UNITED's record of the supplier's own
 * invoice — its number and date, what was received against which PO and receipt, what the
 * supplier charged, what was debited and paid, and what is still owed. It is not the supplier's
 * original (that is kept as an attachment) and never says otherwise. Pure, like the sales
 * invoice document: built from the posted snapshot, or from the current cards until it posts.
 */
import { formatNumber } from "@/lib/format";
import { companyDocumentGaps, type CompanyDocumentGap, type CompanySnapshot, type PartySnapshot } from "@/lib/core/document-snapshot";
import type { BillPostSnapshot } from "@/lib/purchasing/bill-snapshot";

export type BillLang = "ar" | "en";

export const BILL_LABELS = {
  ar: {
    title: "فاتورة مشتريات", subtitle: "Purchase Invoice", serviceTitle: "فاتورة مورد — خدمات", serviceSubtitle: "Supplier Invoice — Services",
    recordNote: "سجل UNITED لفاتورة المورد — الأصل محفوظ في مرفقات الفاتورة",
    supplier: "المورد", buyer: "المشتري", supplierCode: "كود المورد", taxId: "رقم التسجيل الضريبي", commercialReg: "السجل التجاري", phone: "تليفون",
    billNo: "رقم القيد", supplierInvoiceNo: "رقم فاتورة المورد", billDate: "تاريخ فاتورة المورد", dueDate: "تاريخ الاستحقاق", terms: "شروط الدفع", currency: "العملة",
    purchaseOrders: "أوامر الشراء", receipts: "أذون الاستلام", status: "الحالة", match: "المطابقة",
    no: "#", code: "الكود", item: "الصنف", receipt: "إذن الاستلام", po: "أمر الشراء", received: "المستلم", qty: "الكمية المفوترة", unit: "الوحدة", unitPrice: "سعر الوحدة",
    agreed: "المتفق عليه", net: "الصافي", tax: "الضريبة", lineTotal: "الإجمالي", account: "الحساب", description: "البيان", exempt: "معفى",
    subtotal: "الإجمالي قبل الخصم", totalDiscount: "إجمالي الخصم", netTotal: "الصافي", totalTax: "إجمالي الضريبة", grandTotal: "إجمالي الفاتورة",
    debited: "إشعارات مدينة", paid: "المدفوع", balance: "المتبقي للمورد", settled: "مسددة بالكامل", payments: "سندات الصرف", debitNotes: "الإشعارات المدينة",
    variance: "الفرق عن المتفق عليه", attachments: "المرفقات", noAttachment: "مفيش صورة من فاتورة المورد متسجلة",
    recordedBy: "سجّلها", approvedBy: "اعتمدها", postedBy: "رحّلها", notes: "ملاحظات", page: "صفحة", of: "من",
    cash: "نقدي", days: (n: number) => `آجل ${n} يوم`,
    statusLabel: { draft: "مسودة — مش مترحّلة", pending_approval: "مستنية اعتماد", posted: "مترحّلة", cancelled: "ملغية" } as Record<string, string>,
    matchLabel: { matched: "مطابقة", within_tolerance: "في حدود السماحية", variance: "فيها فرق (اتعتمد)", unpriced: "مفيش سعر متفق عليه" } as Record<string, string>,
  },
  en: {
    title: "Purchase Invoice", subtitle: "فاتورة مشتريات", serviceTitle: "Supplier Invoice — Services", serviceSubtitle: "فاتورة مورد — خدمات",
    recordNote: "UNITED's record of the supplier's invoice — the original is kept in the bill's attachments",
    supplier: "Supplier", buyer: "Buyer", supplierCode: "Supplier code", taxId: "Tax registration no.", commercialReg: "Commercial registry", phone: "Phone",
    billNo: "Record no.", supplierInvoiceNo: "Supplier invoice no.", billDate: "Supplier invoice date", dueDate: "Due date", terms: "Payment terms", currency: "Currency",
    purchaseOrders: "Purchase orders", receipts: "Goods receipts", status: "Status", match: "Match",
    no: "#", code: "Code", item: "Item", receipt: "Receipt", po: "PO", received: "Received", qty: "Billed qty", unit: "Unit", unitPrice: "Unit price",
    agreed: "Agreed", net: "Net", tax: "Tax", lineTotal: "Total", account: "Account", description: "Description", exempt: "Exempt",
    subtotal: "Subtotal", totalDiscount: "Total discount", netTotal: "Net", totalTax: "Total tax", grandTotal: "Invoice total",
    debited: "Debit notes", paid: "Paid", balance: "Owed to the supplier", settled: "Settled in full", payments: "Payments", debitNotes: "Debit notes",
    variance: "Variance from agreed", attachments: "Attachments", noAttachment: "No copy of the supplier's invoice is attached",
    recordedBy: "Recorded by", approvedBy: "Approved by", postedBy: "Posted by", notes: "Notes", page: "Page", of: "of",
    cash: "Cash", days: (n: number) => `Net ${n} days`,
    statusLabel: { draft: "Draft — not posted", pending_approval: "Awaiting approval", posted: "Posted", cancelled: "Cancelled" } as Record<string, string>,
    matchLabel: { matched: "Matched", within_tolerance: "Within tolerance", variance: "Variance (approved)", unpriced: "No agreed price" } as Record<string, string>,
  },
} as const;

type Num = string | number | { toString(): string };

export type BillDocInput = {
  bill: {
    number: string; status: string; kind: string; supplierInvoiceNo: string; billDate: string; dueDate: string; currencyCode: string; notes: string | null; matchStatus: string;
    gross: Num; net: Num; taxTotal: Num; total: Num; variance: Num; debited: Num; paid: Num; open: Num | null;
    createdBy: string; approvedBy: string | null; postedBy: string | null;
    lines: { lineNo: number; productCode: string | null; description: string; uomCode: string; receiptNumber: string; receivedDate: string; poNumber: string | null; receivedQty: Num; quantity: Num; unitPrice: Num; expectedUnitPrice: Num | null; taxRate: Num; net: Num; tax: Num; total: Num }[];
    serviceLines: { lineNo: number; description: string; account: { code: string; name: string; nameAr: string | null }; taxRate: Num; net: Num; tax: Num; total: Num }[];
    payments: { number: string; date: string; amount: Num }[];
    debitNotes: { number: string; issueDate: string; total: Num }[];
  };
  /** Posted bills: who it was from as they were at posting. */
  snapshot: BillPostSnapshot | null;
  /** Drafts (and bills posted before Nov 2026): the current cards. */
  current: { supplier: PartySnapshot; buyer: CompanySnapshot | null } | null;
  attachments: { fileName: string; category: string }[];
  lang: BillLang;
};

const money = (v: Num) => formatNumber(v.toString(), { minDp: 2, maxDp: 2 });
const qty = (v: Num) => formatNumber(v.toString(), { maxDp: 3 });
const price = (v: Num) => formatNumber(v.toString(), { minDp: 2, maxDp: 4 });
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function billDocument(input: BillDocInput) {
  const { bill: b, lang } = input;
  const L = BILL_LABELS[lang];
  const supplier = input.snapshot?.supplier ?? input.current?.supplier ?? null;
  const buyer = input.snapshot?.buyer ?? input.current?.buyer ?? null;
  const termDays = days(b.billDate, b.dueDate);
  const open = b.open === null ? null : Number(b.open.toString());
  const lines = b.lines.map((l) => {
    const snap = input.snapshot?.lines[String(l.lineNo)];
    return {
      no: l.lineNo, code: snap?.productCode ?? l.productCode, description: l.description.split(" · ")[0], receipt: snap?.receiptNumber ?? l.receiptNumber, po: snap?.poNumber ?? l.poNumber,
      received: qty(l.receivedQty), qty: qty(l.quantity), unit: l.uomCode, unitPrice: price(l.unitPrice), agreed: l.expectedUnitPrice == null ? "—" : price(l.expectedUnitPrice),
      net: money(l.net), tax: Number(l.taxRate.toString()) ? `${money(l.tax)} (${Number(l.taxRate.toString())}%)` : L.exempt, total: money(l.total),
    };
  });
  const unique = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  return {
    lang,
    dir: lang === "ar" ? ("rtl" as const) : ("ltr" as const),
    labels: L,
    title: b.kind === "service" ? L.serviceTitle : L.title,
    subtitle: b.kind === "service" ? L.serviceSubtitle : L.subtitle,
    recordNote: L.recordNote,
    /** A bill not posted yet prints with its state across it — it is not a liability yet. */
    status: { key: b.status, label: L.statusLabel[b.status] ?? b.status, final: b.status === "posted" },
    source: input.snapshot ? ("snapshot" as const) : ("current" as const),
    supplier: supplier && {
      name: (lang === "ar" ? supplier.nameAr : null) ?? supplier.name, legalName: supplier.legalName, code: supplier.code,
      taxId: supplier.taxRegistrationNo, commercialReg: supplier.commercialRegNo, address: [supplier.address, supplier.city].filter(Boolean).join(lang === "ar" ? "، " : ", ") || null,
      phone: supplier.phone, email: supplier.email,
    },
    buyer: buyer && { name: (lang === "ar" ? buyer.nameAr : null) ?? buyer.tradeName ?? buyer.legalName, legalName: buyer.legalName, taxId: buyer.taxRegistrationNumber, commercialReg: buyer.commercialRegistration, address: buyer.address },
    buyerGaps: companyDocumentGaps(buyer) as CompanyDocumentGap[],
    meta: {
      number: b.number, supplierInvoiceNo: b.supplierInvoiceNo, billDate: b.billDate, dueDate: b.dueDate, currency: b.currencyCode,
      terms: Number.isNaN(termDays) ? null : termDays > 0 ? L.days(termDays) : L.cash,
      purchaseOrders: unique(lines.map((l) => l.po)), receipts: unique(lines.map((l) => l.receipt)),
      match: b.kind === "goods" ? L.matchLabel[b.matchStatus] ?? b.matchStatus : null,
    },
    lines,
    serviceLines: b.serviceLines.map((l) => ({
      no: l.lineNo, description: l.description, account: `${l.account.code} · ${(lang === "ar" ? l.account.nameAr : null) ?? l.account.name}`,
      net: money(l.net), tax: Number(l.taxRate.toString()) ? `${money(l.tax)} (${Number(l.taxRate.toString())}%)` : L.exempt, total: money(l.total),
    })),
    totals: {
      gross: money(b.gross), discount: money(Number(b.gross.toString()) - Number(b.net.toString())), hasDiscount: Number(b.gross.toString()) !== Number(b.net.toString()),
      net: money(b.net), tax: money(b.taxTotal), total: money(b.total), variance: Number(b.variance.toString()) ? money(b.variance) : null,
    },
    settlement: {
      debited: money(b.debited), paid: money(b.paid), balance: open === null ? null : money(open), settled: open !== null && open <= 0,
      payments: b.payments.map((p) => ({ number: p.number, date: p.date, amount: money(p.amount) })),
      debitNotes: b.debitNotes.map((d) => ({ number: d.number, date: d.issueDate, amount: money(d.total) })),
    },
    attachments: input.attachments,
    people: { recordedBy: b.createdBy, approvedBy: b.approvedBy, postedBy: b.postedBy },
    notes: b.notes,
  };
}

export type BillDocument = ReturnType<typeof billDocument>;
