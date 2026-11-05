/* The printed UNITED invoice: its own design, Arabic RTL by default and English by the
   same structure; payment state; ETA identifiers printed only when they are facts. Since Nov
   2026 an invoice not submitted to the ETA prints as a commercial sales invoice, and an issued
   invoice prints from the snapshot frozen at issue. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceDocument, INVOICE_LABELS, type InvoiceDocInput } from "../../lib/sales/invoiceDocument";
import type { SalesIssueSnapshot } from "../../lib/sales/invoice-snapshot";

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
  // Not submitted to the ETA: UNITED's commercial sales invoice, saying so (Nov 2026).
  assert.deepEqual([d.title, d.commercialNote], ["فاتورة مبيعات", "فاتورة تجارية — غير مُرسلة لمنظومة الفاتورة الإلكترونية"]);
  assert.equal(d.seller?.name, "يونايتد");
  assert.deepEqual([d.meta.number, d.meta.issueDate, d.meta.issueTime, d.meta.dueDate, d.meta.order], ["INV-2026-00042", "2026-10-08", "10:05", "2026-10-22", "UN-20261008-0007"]);
  assert.deepEqual([d.buyer.name, d.buyer.taxId, d.buyer.code], ["فندق النيل", "123456789", "CUS-00007"]);
  assert.deepEqual(d.lines[0], { no: 1, code: null, description: "مانجا", qty: "10", unit: "KG", unitPrice: "50.00", discount: "50.00 (10%)", net: "450.00", tax: "63.00 (14%)", total: "513.00" });
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
  assert.deepEqual([d.title, d.commercialNote], ["Sales Invoice", "Commercial invoice — not submitted to the ETA e-invoicing system"]);
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

test("a tax invoice only when the ETA has the document: received or accepted, with its real UUID", () => {
  const valid = invoiceDocument({ ...base, eta: { status: "valid", uuid: "ABC123UUID", longId: null, submittedAt: null, acceptedAt: null } });
  assert.deepEqual([valid.title, valid.commercialNote], ["فاتورة ضريبية", null]);
  for (const status of ["rejected", "invalid", "failed", "submitting"]) {
    const d = invoiceDocument({ ...base, lang: "en", eta: { status, uuid: "X", longId: null, submittedAt: null, acceptedAt: null } });
    assert.deepEqual([d.title, d.eta], ["Sales Invoice", null], status);
  }
  // A received status without a UUID is not a fact either.
  assert.equal(invoiceDocument({ ...base, eta: { status: "valid", uuid: null, longId: null, submittedAt: null, acceptedAt: null } }).title, "فاتورة مبيعات");
});

const snapshot: SalesIssueSnapshot = {
  v: 1,
  seller: { code: "UNI", legalName: "UNITED Fresh Food Supply S.A.E.", tradeName: "UNITED", nameAr: "يونايتد", legalForm: "شركة مساهمة مصرية", issuedCapital: "EGP 5,000,000", taxRegistrationNumber: "111222333", commercialRegistration: "CR-9", address: "6 أكتوبر", phone: "0222", email: "ar@united.example", bank: { name: "البنك الأهلي", accountName: "UNITED", accountNumber: null, iban: "EG380019000500000000263180002" }, invoiceTerms: "البضاعة بتتراجع وقت الاستلام" },
  buyer: { id: "c1", code: "CUS-00007", name: "Nile Hotel", nameAr: "فندق النيل", legalName: "Nile Hotels Co.", taxRegistrationNo: "123456789", commercialRegNo: "CR-77", address: "الزمالك", city: "القاهرة", phone: "0100 000", email: null, paymentTermsDays: 14, identitySource: "card" },
  order: { id: "o1", number: "UN-20261008-0007", customerPoRef: "PO-NH-5521", deliveryDate: "2026-10-08", trip: "TRP-2026-00012" },
  lines: { "1": { productCode: "MNG-01" }, "2": { productCode: null } },
};

test("an issued invoice prints from its snapshot — today's company record never rewrites it", () => {
  // The company has since changed its name, address and bank, and dropped its registry number.
  const today = { ...base.company!, legalName: "Renamed Co.", address: "عنوان جديد", commercialRegistration: null };
  const d = invoiceDocument({ ...base, snapshot, company: today });
  assert.equal(d.source, "snapshot");
  assert.deepEqual([d.seller?.legalName, d.seller?.address, d.seller?.commercialReg, d.seller?.taxId], ["UNITED Fresh Food Supply S.A.E.", "6 أكتوبر", "CR-9", "111222333"]);
  assert.deepEqual([d.meta.order, d.meta.customerPo, d.meta.trip, d.meta.delivery], ["UN-20261008-0007", "PO-NH-5521", "TRP-2026-00012", "2026-10-08"]);
  assert.deepEqual([d.buyer.code, d.buyer.phone, d.buyer.commercialReg], ["CUS-00007", "0100 000", "CR-77"]);
  // The buyer's legal identity stays the frozen columns the ETA mapper also reads.
  assert.deepEqual([d.buyer.name, d.buyer.taxId], ["فندق النيل", "123456789"]);
  assert.deepEqual(d.lines.map((l) => l.code), ["MNG-01", null]);
  assert.equal(d.bank?.iban, "EG380019000500000000263180002");
  assert.equal(d.commercialTerms, "البضاعة بتتراجع وقت الاستلام");
  assert.deepEqual([d.seller?.legalForm, d.seller?.issuedCapital], ["شركة مساهمة مصرية", "EGP 5,000,000"]);
  assert.deepEqual(d.sellerGaps, []);
});

test("an invoice issued before snapshots: today's company, and the gaps it has are named, never filled", () => {
  const d = invoiceDocument({ ...base, company: { legalName: "UNITED", tradeName: null, nameAr: null, taxRegistrationNumber: null, commercialRegistration: null, address: null, phone: null, email: null } });
  assert.equal(d.source, "legacy");
  assert.deepEqual(d.sellerGaps, ["tax_registration_number", "commercial_registration", "address", "legal_form_and_capital", "phone_or_email"]);
  assert.deepEqual([d.seller?.taxId, d.seller?.address, d.bank, d.commercialTerms], [null, null, null, null]);
  assert.deepEqual(invoiceDocument({ ...base, company: null }).sellerGaps.length, 6);
});

test("payment status: unpaid, partly paid, settled", () => {
  const status = (paid: string, open: string) => invoiceDocument({ ...base, lang: "en", invoice: { ...base.invoice, paid, open } }).payment.status;
  assert.deepEqual([status("0", "658"), status("200", "458"), status("658", "0")], ["Unpaid", "Partly paid", "Settled"]);
  assert.equal(invoiceDocument({ ...base, invoice: { ...base.invoice, status: "draft", open: null } }).payment.status, null);
});

test("multi-page invoice: every line is kept, numbered and formatted the same way", () => {
  const lines = Array.from({ length: 120 }, (_, i) => ({ ...base.invoice.lines[1], lineNo: i + 1, description: `صنف ${i + 1}` }));
  const d = invoiceDocument({ ...base, invoice: { ...base.invoice, lines } });
  assert.equal(d.lines.length, 120);
  assert.deepEqual([d.lines[0].no, d.lines[119].no, d.lines[119].unitPrice, d.lines[119].qty], [1, 120, "7.0732", "20.5"]);
});

test("credit notes: printed with their amount; a credited, unpaid invoice never prints as paid (LOG-9)", () => {
  const cn = (number: string, total: string) => ({ number, issueDate: "2026-10-20", total });
  // Fully credited, nothing received: the open amount is 0 because of the credit note, not money.
  const full = invoiceDocument({ ...base, invoice: { ...base.invoice, paid: "0", open: "0", payments: [], credited: "658", creditNotes: [cn("CN-2026-00003", "658")] } });
  assert.deepEqual([full.payment.status, full.payment.paidInFull, full.payment.balance, full.payment.paid, full.payment.credited], ["مخصومة بالكامل بإشعار دائن", false, "0.00", "0.00", "658.00"]);
  assert.deepEqual(full.payment.creditNotes, [{ number: "CN-2026-00003", date: "2026-10-20", amount: "658.00" }]);
  assert.equal(invoiceDocument({ ...base, lang: "en", invoice: { ...base.invoice, paid: "0", open: "0", payments: [], credited: "658", creditNotes: [] } }).payment.status, "Credited in full");
  // Partly credited, partly paid: the balance is total − credit notes − paid, and both show.
  const part = invoiceDocument({ ...base, lang: "en", invoice: { ...base.invoice, paid: "200", open: "358", credited: "100", creditNotes: [cn("CN-1", "100")] } });
  assert.deepEqual([part.payment.status, part.payment.credited, part.payment.balance, part.payment.paidInFull], ["Partly paid", "100.00", "358.00", false]);
  // Credited in part and the rest paid: settled, paid in full.
  const rest = invoiceDocument({ ...base, lang: "en", invoice: { ...base.invoice, paid: "558", open: "0", credited: "100", creditNotes: [cn("CN-1", "100")] } });
  assert.deepEqual([rest.payment.status, rest.payment.paidInFull], ["Settled", true]);
  // No credit notes: no row (and every label has its English counterpart, checked above).
  assert.deepEqual([invoiceDocument(base).payment.credited, invoiceDocument(base).payment.creditNotes], [null, []]);
});
