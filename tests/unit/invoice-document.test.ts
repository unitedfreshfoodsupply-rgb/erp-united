/* The printed UNITED invoice: its own design, Arabic RTL by default and English by the
   same structure; payment state; ETA identifiers printed only when they are facts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceDocument, INVOICE_LABELS, type InvoiceDocInput } from "../../lib/sales/invoiceDocument";

const base: InvoiceDocInput = {
  lang: "ar",
  company: { legalName: "UNITED Fresh Food Supply", tradeName: "UNITED", nameAr: "يونايتد", taxRegistrationNumber: "987654321", commercialRegistration: "12345", address: "القاهرة", phone: "0100", email: null },
  eta: null,
  invoice: {
    number: "INV-2026-00042", status: "issued", issueDate: "2026-10-08", dueDate: "2026-10-22", issuedAt: "2026-10-08T07:05:00.000Z", currencyCode: "EGP",
    buyerName: "فندق النيل", buyerTaxId: "123456789", buyerAddress: "الزمالك", notes: null,
    gross: "645", discountTotal: "50", net: "595", taxTotal: "63", total: "658", paid: "200", open: "458",
    customer: { code: "CUS-00007", paymentTermsDays: 14 }, order: { orderNumber: "UN-20261008-0007", deliveryDate: "2026-10-08" },
    lines: [
      { lineNo: 1, description: "مانجا", uomCode: "KG", quantity: "10", unitPrice: "50", discountPct: "10", discount: "50", net: "450", taxCode: "VAT14", taxRate: "14", tax: "63", total: "513" },
      { lineNo: 2, description: "طماطم", uomCode: "KG", quantity: "20.5", unitPrice: "7.0732", discountPct: "0", discount: "0", net: "145", taxCode: "EXEMPT", taxRate: "0", tax: "0", total: "145" },
    ],
    payments: [{ number: "RCT-2026-00001", date: "2026-10-09", amount: "200" }],
  },
};

test("Arabic by default: RTL, Arabic labels, every required section present", () => {
  const d = invoiceDocument(base);
  assert.equal(d.dir, "rtl");
  assert.equal(d.labels.title, "فاتورة ضريبية");
  assert.equal(d.seller?.name, "يونايتد");
  assert.deepEqual([d.meta.number, d.meta.issueDate, d.meta.issueTime, d.meta.dueDate, d.meta.order], ["INV-2026-00042", "2026-10-08", "10:05", "2026-10-22", "UN-20261008-0007"]);
  assert.deepEqual([d.buyer.name, d.buyer.taxId, d.buyer.code], ["فندق النيل", "123456789", "CUS-00007"]);
  assert.deepEqual(d.lines[0], { no: 1, description: "مانجا", qty: "10", unit: "KG", unitPrice: "50.00", discount: "50.00 (10%)", net: "450.00", tax: "63.00 (14%)", total: "513.00" });
  assert.equal(d.lines[1].tax, INVOICE_LABELS.ar.exempt);
  assert.equal(d.lines[1].unitPrice, "7.0732");
  assert.deepEqual(d.totals, { gross: "645.00", discount: "50.00", net: "595.00", tax: "63.00", total: "658.00", hasDiscount: true });
  assert.deepEqual(d.taxSummary.map((t) => [t.label, t.base, t.tax]), [["VAT14 14%", "450.00", "63.00"], ["EXEMPT · معفى", "145.00", "0.00"]]);
  assert.deepEqual([d.payment.terms, d.payment.paid, d.payment.balance, d.payment.paidInFull], ["آجل 14 يوم", "200.00", "458.00", false]);
  assert.equal(d.payment.receipts[0].number, "RCT-2026-00001");
});

test("English from the same structure: LTR, English labels, same figures", () => {
  const d = invoiceDocument({ ...base, lang: "en" });
  assert.equal(d.dir, "ltr");
  assert.equal(d.labels.title, "Tax Invoice");
  assert.equal(d.seller?.name, "UNITED");
  assert.equal(d.payment.terms, "Net 14 days");
  assert.equal(d.totals.total, "658.00");
  // Every Arabic label has an English counterpart.
  assert.deepEqual(Object.keys(INVOICE_LABELS.en).sort(), Object.keys(INVOICE_LABELS.ar).sort());
});

test("ETA identifiers print only when they are facts — never an error or a retry state", () => {
  assert.equal(invoiceDocument(base).eta, null);
  for (const status of ["rejected", "invalid", "failed", "unknown", "submitting", "pending"]) {
    assert.equal(invoiceDocument({ ...base, eta: { status, uuid: "U", longId: null, submittedAt: null, acceptedAt: null } }).eta, null, status);
  }
  const ok = invoiceDocument({ ...base, eta: { status: "valid", uuid: "ABC123UUID", longId: "LONG1", submittedAt: "2026-10-08T08:00:00Z", acceptedAt: "2026-10-08T08:01:00Z" } }).eta;
  assert.deepEqual([ok?.uuid, ok?.longId, ok?.status], ["ABC123UUID", "LONG1", "مقبولة"]);
});

test("cash customer, fully paid, no discount", () => {
  // Issued for cash: issue set the due date to the issue date.
  const d = invoiceDocument({ ...base, invoice: { ...base.invoice, dueDate: "2026-10-08", discountTotal: "0", open: "0", customer: { code: "C", paymentTermsDays: 0 } } });
  assert.deepEqual([d.payment.terms, d.payment.paidInFull, d.totals.hasDiscount], ["نقدي عند التسليم", true, false]);
});

test("an issued invoice prints the terms it was issued with, not the customer's terms of today", () => {
  // Issued at 14 days; the customer has since moved to cash, then to 30 days.
  for (const today of [0, 30]) {
    const d = invoiceDocument({ ...base, invoice: { ...base.invoice, customer: { code: "C", paymentTermsDays: today } } });
    assert.deepEqual([d.payment.terms, d.meta.dueDate], ["آجل 14 يوم", "2026-10-22"]);
  }
  const en = invoiceDocument({ ...base, lang: "en", invoice: { ...base.invoice, customer: { code: "C", paymentTermsDays: 0 } } });
  assert.equal(en.payment.terms, "Net 14 days");
});

test("a draft shows the customer's current terms (the ones issue will apply)", () => {
  const draft = { ...base.invoice, status: "draft", number: null, issueDate: null, dueDate: null, issuedAt: null };
  assert.equal(invoiceDocument({ ...base, invoice: { ...draft, customer: { code: "C", paymentTermsDays: 30 } } }).payment.terms, "آجل 30 يوم");
  assert.equal(invoiceDocument({ ...base, lang: "en", invoice: { ...draft, customer: { code: "C", paymentTermsDays: 0 } } }).payment.terms, "Cash on delivery");
});
