/* The printed supplier bill (Nov 2026): UNITED's record of the supplier's own invoice, Arabic RTL
   and English LTR from one structure; from the snapshot frozen at posting, with the state of a
   bill not posted yet printed on it; PO and receipt references; what is still owed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { billDocument, BILL_LABELS, type BillDocInput } from "../../lib/purchasing/billDocument";
import type { BillPostSnapshot } from "../../lib/purchasing/bill-snapshot";

const line = { lineNo: 1, productCode: "TOM-1", description: "طماطم", uomCode: "KG", receiptNumber: "RCV-2026-00010", receivedDate: "2026-11-01", poNumber: "PO-2026-00004", receivedQty: "500", quantity: "500", unitPrice: "8", expectedUnitPrice: "8", taxRate: "0", net: "4000", tax: "0", total: "4000" };
const base: BillDocInput = {
  lang: "ar",
  bill: {
    number: "BILL-2026-00003", status: "posted", kind: "goods", supplierInvoiceNo: "F-7781", billDate: "2026-11-02", dueDate: "2026-11-16", currencyCode: "EGP", notes: null, matchStatus: "matched",
    gross: "6400", net: "6400", taxTotal: "0", total: "6400", variance: "0", debited: "400", paid: "1000", open: "5000",
    createdBy: "Karim", approvedBy: null, postedBy: "Karim",
    lines: [line, { ...line, lineNo: 2, productCode: null, description: "خيار", receiptNumber: "RCV-2026-00011", quantity: "300", total: "2400", net: "2400" }],
    serviceLines: [], payments: [{ number: "PAY-2026-00002", date: "2026-11-03", amount: "1000" }], debitNotes: [{ number: "DN-2026-00001", issueDate: "2026-11-03", total: "400" }],
  },
  snapshot: null,
  current: null,
  attachments: [],
};
const snapshot: BillPostSnapshot = {
  v: 1,
  supplier: { id: "s1", code: "SUP-00049", name: "Saif Alloush", nameAr: "سيف علوش", legalName: null, taxRegistrationNo: "555666777", commercialRegNo: null, address: "سوق العبور", city: "القليوبية", phone: "0111", email: null, paymentTermsDays: 14, category: "vegetable" },
  buyer: { code: "UNI", legalName: "UNITED Fresh Food Supply", tradeName: "UNITED", nameAr: "يونايتد", legalForm: "شركة مساهمة مصرية", issuedCapital: "EGP 5,000,000", taxRegistrationNumber: "111222333", commercialRegistration: "CR-9", address: "6 أكتوبر", phone: "0222", email: null, bank: null, invoiceTerms: null },
  lines: { "1": { productCode: "TOM-1", poNumber: "PO-2026-00004", receiptNumber: "RCV-2026-00010", receivedDate: "2026-11-01" }, "2": { productCode: "CUC-1", poNumber: "PO-2026-00004", receiptNumber: "RCV-2026-00011", receivedDate: "2026-11-01" } },
};

test("a posted bill prints the supplier as it was at posting, Arabic RTL", () => {
  const d = billDocument({ ...base, snapshot, current: { supplier: { ...snapshot.supplier, name: "Renamed", nameAr: "اسم جديد", taxRegistrationNo: null }, buyer: null } });
  assert.deepEqual([d.dir, d.title, d.source, d.status.final], ["rtl", "فاتورة مشتريات", "snapshot", true]);
  assert.deepEqual([d.supplier?.name, d.supplier?.code, d.supplier?.taxId, d.supplier?.address], ["سيف علوش", "SUP-00049", "555666777", "سوق العبور، القليوبية"]);
  assert.deepEqual([d.meta.supplierInvoiceNo, d.meta.billDate, d.meta.dueDate, d.meta.terms], ["F-7781", "2026-11-02", "2026-11-16", "آجل 14 يوم"]);
  // One PO, two receipts — each listed once; the line's code comes from the snapshot.
  assert.deepEqual([d.meta.purchaseOrders, d.meta.receipts], [["PO-2026-00004"], ["RCV-2026-00010", "RCV-2026-00011"]]);
  assert.deepEqual(d.lines.map((l) => l.code), ["TOM-1", "CUC-1"]);
  assert.deepEqual([d.settlement.debited, d.settlement.paid, d.settlement.balance, d.settlement.settled], ["400.00", "1,000.00", "5,000.00", false]);
  assert.deepEqual(d.buyerGaps, []);
  assert.equal(d.recordNote, BILL_LABELS.ar.recordNote);
});

test("English from the same structure; every Arabic label has an English one", () => {
  const d = billDocument({ ...base, lang: "en", snapshot });
  assert.deepEqual([d.dir, d.title, d.supplier?.name, d.meta.terms, d.meta.match], ["ltr", "Purchase Invoice", "Saif Alloush", "Net 14 days", "Matched"]);
  assert.deepEqual(Object.keys(BILL_LABELS.en).sort(), Object.keys(BILL_LABELS.ar).sort());
});

test("a bill not posted yet prints its state and today's cards — it is not a liability yet", () => {
  for (const [status, label] of [["draft", "مسودة — مش مترحّلة"], ["pending_approval", "مستنية اعتماد"], ["cancelled", "ملغية"]]) {
    const d = billDocument({ ...base, bill: { ...base.bill, status, open: null }, current: { supplier: snapshot.supplier, buyer: snapshot.buyer } });
    assert.deepEqual([d.status.final, d.status.label, d.source, d.settlement.balance], [false, label, "current", null], status);
  }
});

test("missing company details are named for the buyer side; nothing invented", () => {
  const d = billDocument({ ...base, current: { supplier: snapshot.supplier, buyer: { ...snapshot.buyer!, taxRegistrationNumber: null, address: null } } });
  assert.deepEqual(d.buyerGaps, ["tax_registration_number", "address"]);
  assert.equal(d.buyer?.taxId, null);
});

test("attachments are listed; a settled bill says so", () => {
  const d = billDocument({ ...base, bill: { ...base.bill, open: "0" }, attachments: [{ fileName: "F-7781.pdf", category: "invoice" }], snapshot });
  assert.deepEqual([d.attachments.length, d.settlement.settled], [1, true]);
});

test("a service bill prints its accounts, not goods receipts", () => {
  const d = billDocument({ ...base, lang: "en", snapshot, bill: { ...base.bill, kind: "service", lines: [], serviceLines: [{ lineNo: 1, description: "Truck rent", account: { code: "6200", name: "Transport", nameAr: "نقل" }, taxRate: "14", net: "1000", tax: "140", total: "1140" }] } });
  assert.deepEqual([d.title, d.meta.match, d.serviceLines[0].account, d.serviceLines[0].tax], ["Supplier Invoice — Services", null, "6200 · Transport", "140.00 (14%)"]);
});
