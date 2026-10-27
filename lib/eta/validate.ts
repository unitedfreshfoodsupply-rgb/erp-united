import { Prisma } from "@prisma/client";
import { lineAmounts } from "@/lib/sales/money";
import { mapInvoiceToEta, receiverType } from "./mapper";
import type { EtaDocumentV1, EtaIssue, EtaSource } from "./types";

/**
 * Everything checked before an invoice may go to ETA. `error` blocks the submission;
 * `warning` is shown to the accountant and does not block.
 *
 * Three families:
 *  1. Data UNITED does not hold yet (codes, addresses, ids) — reported, never filled in.
 *  2. UNITED's own arithmetic — recomputed with the same function that priced the
 *     invoice; a mismatch means the stored invoice is inconsistent and must not go out.
 *  3. The ETA document's own totals — recomputed from the mapped lines.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const REG_NO = /^\d{9}$/;
const ADDRESS_FIELDS = ["country", "governate", "regionCity", "street", "buildingNumber"] as const;

export function validateEtaSource(src: EtaSource): { issues: EtaIssue[]; document: EtaDocumentV1 } {
  const issues: EtaIssue[] = [];
  const err = (field: string, message: string) => issues.push({ level: "error", field, message });
  const warn = (field: string, message: string) => issues.push({ level: "warning", field, message });
  const inv = src.invoice;

  // Document
  if (inv.status !== "issued") err("invoice.status", "الفاتورة لازم تكون صادرة قبل الإرسال");
  if (!inv.number) err("internalID", "الفاتورة من غير رقم");
  if (!inv.issuedAt) err("dateTimeIssued", "تاريخ ووقت الإصدار ناقص");
  if (src.kind === "credit_note" && !src.references?.length) err("references", "الفاتورة الأصلية لسه ما اتقبلتش من منظومة الضرائب — الإشعار الدائن بيتبعت بعد قبولها");
  if (inv.currencyCode !== "EGP") err("unitValue.currencySold", `عملة ${inv.currencyCode}: الإرسال بعملة أجنبية محتاج سعر صرف — مش مدعوم لسه`);

  // Issuer
  if (!src.issuer.name) err("issuer.name", "اسم الشركة ناقص (بيانات الشركة)");
  if (!src.issuer.registrationNumber) err("issuer.id", "رقم التسجيل الضريبي للشركة ناقص (بيانات الشركة)");
  else if (!REG_NO.test(src.issuer.registrationNumber)) err("issuer.id", "رقم التسجيل الضريبي للشركة لازم 9 أرقام");
  if (!src.issuer.etaBranchId) err("issuer.address.branchID", "كود الفرع في منظومة الضرائب ناقص (بيانات المُصدِر)");
  if (!src.issuer.activityCode) err("taxpayerActivityCode", "كود النشاط الضريبي ناقص (بيانات المُصدِر)");
  for (const f of ADDRESS_FIELDS) if (!src.issuer.address[f]) err(`issuer.address.${f}`, `عنوان الشركة: ${f} ناقص (بيانات المُصدِر)`);

  // Receiver
  const type = receiverType(src);
  const total = D(inv.total);
  if (!inv.buyerName) err("receiver.name", "اسم العميل ناقص على الفاتورة");
  if (type === "B") {
    if (!inv.buyerTaxId) err("receiver.id", "عميل شركة من غير رقم تسجيل ضريبي على الفاتورة");
    else if (!REG_NO.test(inv.buyerTaxId)) err("receiver.id", "رقم التسجيل الضريبي للعميل لازم 9 أرقام");
    for (const f of ADDRESS_FIELDS) if (!src.receiver.address[f]) err(`receiver.address.${f}`, `عنوان العميل الضريبي: ${f} ناقص`);
  } else if (type === "P") {
    if (total.gte(src.personIdThreshold) && !src.receiver.personalId) err("receiver.id", `فاتورة لشخص طبيعي بـ ${total.toFixed(2)} (من ${src.personIdThreshold} وأكتر) محتاجة الرقم القومي`);
  } else {
    if (!src.receiver.personalId) err("receiver.id", "عميل أجنبي من غير رقم هوية");
    if (!src.receiver.address.country) err("receiver.address.country", "دولة العميل الأجنبي ناقصة");
  }

  // Lines
  if (src.lines.length === 0) err("invoiceLines", "الفاتورة من غير أصناف");
  const sum = { gross: D(0), discount: D(0), net: D(0), tax: D(0), total: D(0) };
  for (const l of src.lines) {
    const at = `invoiceLines[${l.lineNo}]`;
    const q = D(l.quantity);
    const p = D(l.unitPrice);
    if (!q.gt(0)) err(`${at}.quantity`, `سطر ${l.lineNo}: الكمية لازم أكبر من صفر`);
    if (!p.gt(0)) err(`${at}.unitValue`, `سطر ${l.lineNo}: سعر الوحدة لازم أكبر من صفر`);
    if (!l.productId) err(`${at}.itemCode`, `سطر ${l.lineNo} (${l.description}): مش مربوط بصنف — مفيش كود ضريبي`);
    else if (!l.itemType || !l.itemCode) err(`${at}.itemCode`, `سطر ${l.lineNo} (${l.description}): كود الصنف في منظومة الضرائب (GS1/EGS) ناقص`);
    if (!l.internalCode) err(`${at}.internalCode`, `سطر ${l.lineNo}: الكود الداخلي ناقص`);
    if (!l.etaUnitType) err(`${at}.unitType`, `سطر ${l.lineNo}: الوحدة ${l.uomCode} مش مربوطة بكود وحدة الضرائب`);
    if (!l.etaTaxType || !l.etaTaxSubtype) err(`${at}.taxableItems`, `سطر ${l.lineNo}: التصنيف الضريبي لـ ${l.taxCode} ناقص (نوع/نوع فرعي)`);

    // An invoice line is recomputed with the function that priced it. A credit note's
    // last credit on a line is the exact remainder (to the piastre), not a re-pricing,
    // so only ETA's own line arithmetic below applies to it.
    if (src.kind === "sales_invoice") {
      const expect = lineAmounts({ quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate });
      for (const k of ["gross", "discount", "net", "tax", "total"] as const) {
        if (!expect[k].equals(D(l[k]))) err(`${at}.${k}`, `سطر ${l.lineNo}: ${k} المسجل ${D(l[k]).toFixed(2)} والمحسوب ${expect[k].toFixed(2)} — الفاتورة مش متسقة`);
      }
    }
    const exact = q.times(p);
    if (!exact.equals(D(l.gross))) warn(`${at}.salesTotal`, `سطر ${l.lineNo}: الكمية × السعر = ${exact.toFixed(5)} والفاتورة مقرّبة ${D(l.gross).toFixed(2)} — راجع قاعدة التقريب في بيئة التجربة`);
    sum.gross = sum.gross.plus(l.gross);
    sum.discount = sum.discount.plus(l.discount);
    sum.net = sum.net.plus(l.net);
    sum.tax = sum.tax.plus(l.tax);
    sum.total = sum.total.plus(l.total);
  }
  const header = { gross: inv.gross, discount: inv.discountTotal, net: inv.net, tax: inv.taxTotal, total: inv.total };
  for (const k of ["gross", "discount", "net", "tax", "total"] as const) {
    if (!sum[k].equals(D(header[k]))) err(`totals.${k}`, `إجمالي ${k} في رأس الفاتورة ${D(header[k]).toFixed(2)} ومجموع السطور ${sum[k].toFixed(2)}`);
  }
  if (!D(inv.net).plus(inv.taxTotal).equals(D(inv.total))) err("totalAmount", "إجمالي الفاتورة ≠ الصافي + الضريبة");

  // The ETA document's own arithmetic, as ETA will check it.
  const doc = mapInvoiceToEta(src);
  const dsum = (f: (l: (typeof doc.invoiceLines)[number]) => number) => doc.invoiceLines.reduce((s, l) => s.plus(f(l)), D(0));
  if (!dsum((l) => l.salesTotal).equals(D(doc.totalSalesAmount))) err("totalSalesAmount", "مجموع salesTotal ≠ totalSalesAmount");
  if (!dsum((l) => l.discount.amount).equals(D(doc.totalDiscountAmount))) err("totalDiscountAmount", "مجموع الخصومات ≠ totalDiscountAmount");
  if (!dsum((l) => l.netTotal).equals(D(doc.netAmount))) err("netAmount", "مجموع netTotal ≠ netAmount");
  const taxSum = doc.taxTotals.reduce((s, t) => s.plus(t.amount), D(0));
  if (!D(doc.netAmount).plus(taxSum).minus(doc.extraDiscountAmount).equals(D(doc.totalAmount))) err("totalAmount", "totalAmount ≠ netAmount + الضرائب − الخصم الإضافي");
  for (const l of doc.invoiceLines) {
    if (!D(l.salesTotal).minus(l.discount.amount).equals(D(l.netTotal))) err("invoiceLines.netTotal", `${l.internalCode}: netTotal ≠ salesTotal − الخصم`);
    const lineTax = l.taxableItems.reduce((s, t) => s.plus(t.amount), D(0));
    if (!D(l.netTotal).plus(lineTax).plus(l.totalTaxableFees).minus(l.itemsDiscount).equals(D(l.total))) err("invoiceLines.total", `${l.internalCode}: total ≠ netTotal + الضريبة`);
  }

  return { issues, document: doc };
}

export const hasBlockingIssues = (issues: EtaIssue[]) => issues.some((i) => i.level === "error");
