/* Ordinary commercial invoices (Nov 2026), on the test database with synthetic data.
   Sales: a draft reads the current company and customer cards; its notes are edited with an
   audit of the old and new text; issue freezes the seller, buyer card, order references and
   product codes with the invoice, posts the receivable once and refuses a second issue; later
   master-data changes never reach the issued invoice or its print.
   Purchases: a bill records the supplier's invoice against the receipts, is edited only as a
   draft (audited), refuses a second bill with the same supplier invoice number, posts the
   payable once and freezes the supplier's card; a posted bill is corrected only by a debit
   note; recording a bill never creates a payment. Every write is refused server-side without
   its permission. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, taxNo } from "./_db";
import { createCustomer, createLegalEntityForCustomer, updateCustomer } from "@/lib/sales/customers";
import { customerReceivable, getInvoice, issueInvoice, updateDraftInvoice } from "@/lib/sales/invoicing";
import { invoiceDocument } from "@/lib/sales/invoiceDocument";
import { createPurchaseOrder, sendPurchaseOrder, submitPurchaseOrder } from "@/lib/purchasing/orders";
import { billableReceipts, cancelBill, createBill, createDebitNote, getBill, postBill, supplierPayable, updateBill } from "@/lib/purchasing/bills";
import { billDocument } from "@/lib/purchasing/billDocument";
import { createIntake } from "@/lib/stock-service";
import { documentCompany } from "@/lib/core/document-snapshot";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZCIV${Date.now()}`;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const today = todayLocalISO();
const status = (s: number) => (e: any) => e?.status === s;

const sales = actor("محاسب المبيعات", ["sales.customers.view", "sales.customers.manage", "sales.invoices.view", "sales.invoices.manage"], "civ-sales");
const salesViewer = actor("مندوب", ["sales.customers.view", "sales.invoices.view"], "civ-sales-viewer");
const buyer = actor("مشتريات", ["purchasing.orders.manage", "purchasing.prices.manage"], "civ-buyer");
const store = actor("أمين مخزن", ["stock.receive", "stock.sort", "stock.view", "stock.valuation.view"], "civ-store");
const billing = actor("فواتير الموردين", ["purchasing.bills.manage", "purchasing.bills.view"], "civ-bills");
const billViewer = actor("مراجع", ["purchasing.bills.view"], "civ-bill-viewer");

let companyId = "";
let restoreCompany: Prisma.CompanyUpdateInput = {};

before(async () => {
  const c = await documentCompany(prisma);
  assert.ok(c, "the seed has a company");
  companyId = c.id;
  restoreCompany = { phone: c.phone, address: c.address };
  await prisma.company.update({ where: { id: c.id }, data: { phone: `${TAG}-0222`, address: `${TAG} 6 أكتوبر` } });
});
after(async () => {
  if (companyId) await prisma.company.update({ where: { id: companyId }, data: restoreCompany });
  await prisma.$disconnect();
});

const journals = (sourceType: string, sourceId: string) => prisma.journalEntry.count({ where: { sourceType, sourceId } });

test("sales invoice: the draft reads master data live; issue freezes it, posts once, and nothing rewrites it afterwards", async () => {
  const c = await createCustomer({ name: `${TAG} فندق النيل`, tax_registration_no: taxNo(), phone: "0100-111" }, sales);
  await createLegalEntityForCustomer(c.id, { country: "EG", governate: "Cairo", region_city: "Zamalek", street: "26 July", building_number: "3" }, sales);
  const product = await prisma.stockProduct.create({ data: { name: `${TAG} Mango`, sku: `${TAG}-MNG` } });
  const draft = await prisma.salesInvoice.create({
    data: {
      customerId: c.id, gross: D(500), discountTotal: D(0), net: D(500), taxTotal: D(0), total: D(500), createdBy: "test",
      lines: { create: { lineNo: 1, productId: product.id, description: "مانجا", uomCode: "KG", quantity: D(10), unitPrice: D(50), taxCode: "EXEMPT", taxRate: D(0), gross: D(500), discount: D(0), net: D(500), tax: D(0), total: D(500) } },
    },
  });

  // Draft: the current cards, read live, with the buyer identity issue will use.
  let d = await getInvoice(draft.id);
  assert.equal(d.issueSnapshot, null);
  assert.equal(d.current?.buyer?.phone, "0100-111");
  assert.equal(d.current?.buyerIdentity?.ok, true);
  assert.equal(d.current?.seller?.phone, `${TAG}-0222`);
  const cur = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  await updateCustomer(c.id, { phone: "0100-222", expected_version: cur.version }, sales);
  d = await getInvoice(draft.id);
  assert.equal(d.current?.buyer?.phone, "0100-222", "an approved master-data change shows on the draft at once");

  // Draft notes: edited by the invoice manager only, audited with the previous and new text.
  await assert.rejects(updateDraftInvoice(draft.id, { notes: "x", expected_version: d.version }, salesViewer as never), status(403));
  await updateDraftInvoice(draft.id, { notes: `${TAG} تسليم الصبح`, expected_version: d.version }, sales);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: draft.id, action: "invoice_draft_edited" } });
  assert.deepEqual([audit.fieldChanged, audit.oldValue, audit.newValue], ["notes", null, `${TAG} تسليم الصبح`]);

  // Issue: refused without the permission; once by the manager.
  await assert.rejects(issueInvoice(draft.id, {}, salesViewer as never), status(403));
  const before = await customerReceivable(prisma, c.id);
  const issued = await issueInvoice(draft.id, {}, sales);
  assert.equal(issued.status, "issued");
  assert.equal(await journals("sales_invoice", draft.id), 1, "the receivable and revenue are posted once");
  const afterIssue = await customerReceivable(prisma, c.id);
  assert.equal(afterIssue.minus(before).toFixed(2), "500.00", "the customer's balance rises by the invoice once");
  const ar = await prisma.journalLine.aggregate({ where: { partyType: "customer", partyId: c.id }, _sum: { debit: true, credit: true } });
  assert.equal(D(ar._sum.debit ?? 0).minus(ar._sum.credit ?? 0).toFixed(2), "500.00", "the ledger agrees with the sub-ledger");
  await assert.rejects(issueInvoice(draft.id, {}, sales), status(409));
  assert.equal(await journals("sales_invoice", draft.id), 1, "a second issue posts nothing");
  await assert.rejects(updateDraftInvoice(draft.id, { notes: "late", expected_version: issued.version }, sales), status(409));

  const frozen = (await getInvoice(draft.id)).issueSnapshot!;
  assert.deepEqual([frozen.seller?.phone, frozen.seller?.address, frozen.buyer.code, frozen.buyer.phone, frozen.lines["1"].productCode], [`${TAG}-0222`, `${TAG} 6 أكتوبر`, c.code, "0100-222", `${TAG}-MNG`]);
  assert.equal((await getInvoice(draft.id)).current, null, "an issued invoice no longer reads the live cards");

  // Later changes: company, customer card and product code. None reaches the issued invoice.
  await prisma.company.update({ where: { id: companyId }, data: { phone: `${TAG}-9999`, address: `${TAG} عنوان جديد` } });
  const cur2 = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  await updateCustomer(c.id, { phone: "0100-333", name: `${TAG} فندق النيل الجديد`, expected_version: cur2.version }, sales);
  await prisma.stockProduct.update({ where: { id: product.id }, data: { sku: `${TAG}-MNG2` } });
  const again = await getInvoice(draft.id);
  assert.deepEqual(again.issueSnapshot, frozen);
  const doc = invoiceDocument({ invoice: { ...again, payments: again.payments }, snapshot: again.issueSnapshot, company: null, eta: null, lang: "ar" });
  assert.deepEqual([doc.seller?.phone, doc.seller?.address, doc.buyer.phone, doc.lines[0].code, doc.title], [`${TAG}-0222`, `${TAG} 6 أكتوبر`, "0100-222", `${TAG}-MNG`, "فاتورة مبيعات"]);
  assert.equal(doc.buyer.name, issued.buyerName, "the buyer's legal name stays the one issued");
  // …and the database refuses to touch the issued row at all.
  await assert.rejects(prisma.salesInvoice.update({ where: { id: draft.id }, data: { issueSnapshot: {} } }));
});

async function receipt(supplierId: string, productId: string, kg: number, price: string) {
  const po = await createPurchaseOrder({ supplier_id: supplierId, lines: [{ product_id: productId, quantity: kg, unit_price: price }] }, buyer);
  await submitPurchaseOrder(po.id, buyer);
  await sendPurchaseOrder(po.id, buyer);
  const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { poId: po.id } });
  const intake = await createIntake({ purchase_order_line_id: line.id, received_kg: kg } as never, store);
  return { po, intake };
}

test("supplier bill: recorded against receipts, edited only as a draft, posted once with the supplier frozen; corrected by a debit note", async () => {
  // A fresh tax number each run: the column is unique, so a fixed one fails on a rerun.
  const supplierTaxNo = taxNo();
  const s = await prisma.supplier.create({ data: { code: `SUP-8${String(Date.now()).slice(-6)}`, name: `${TAG} Saif`, nameAr: `${TAG} سيف`, category: "vegetable", phone: "0111-1", taxRegistrationNo: supplierTaxNo, paymentTermsDays: 14 } });
  const product = await prisma.stockProduct.create({ data: { name: `${TAG} Tomato`, unit: "KG", sku: `${TAG}-TOM` } });
  const first = await receipt(s.id, product.id, 100, "8");
  const second = await receipt(s.id, product.id, 40, "8");

  // Recording: the bills manager only; against the receipt; draft shows the current cards.
  await assert.rejects(createBill({ supplier_id: s.id, supplier_invoice_no: `${TAG}-F1`, bill_date: today, lines: [{ intake_id: first.intake.id, unit_price: "8" }] }, billViewer as never), status(403));
  const bill = await createBill({ supplier_id: s.id, supplier_invoice_no: `${TAG}-F0`, bill_date: today, lines: [{ intake_id: first.intake.id, unit_price: "8" }] }, billing);
  let b = await getBill(bill.id);
  assert.deepEqual([b.status, b.postSnapshot, b.current?.supplier.phone, b.lines[0].productCode, b.lines[0].poNumber], ["draft", null, "0111-1", `${TAG}-TOM`, first.po.number]);

  // Draft edit (the supplier's invoice number was typed wrong): audited with the old value.
  await updateBill(bill.id, { supplier_id: s.id, supplier_invoice_no: `${TAG}-F1`, bill_date: today, lines: [{ intake_id: first.intake.id, unit_price: "8" }], expected_version: b.version }, billing);
  const edit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: bill.id, action: "supplier_bill_edited" } });
  assert.ok(edit.oldValue?.includes(`${TAG}-F0`) && edit.newValue?.includes(`${TAG}-F1`), `${edit.oldValue} → ${edit.newValue}`);

  // The same supplier invoice number twice is refused, even for another receipt.
  await assert.rejects(createBill({ supplier_id: s.id, supplier_invoice_no: `${TAG}-F1`, bill_date: today, lines: [{ intake_id: second.intake.id, unit_price: "8" }] }, billing), status(409));
  // Partial billing: the second receipt is still billable, the first is not.
  const billable = (await billableReceipts(s.id)).map((r: any) => r.intakeId);
  assert.ok(billable.includes(second.intake.id) && !billable.includes(first.intake.id));

  // Posting: refused without the permission; once; AP up by the bill total exactly; no payment made.
  await assert.rejects(postBill(bill.id, billViewer as never), status(403));
  const owedBefore = D((await supplierPayable(prisma, s.id)).toString());
  const posted = await postBill(bill.id, billing);
  assert.equal(posted.status, "posted");
  assert.equal(await journals("supplier_bill", bill.id), 1);
  assert.equal(D((await supplierPayable(prisma, s.id)).toString()).minus(owedBefore).toFixed(2), posted.total.toFixed(2));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierId: s.id } }), 0, "a bill never creates a payment");
  await assert.rejects(postBill(bill.id, billing), status(409));
  assert.equal(await journals("supplier_bill", bill.id), 1);

  b = await getBill(bill.id);
  const frozen = b.postSnapshot!;
  assert.deepEqual([frozen.supplier.code, frozen.supplier.phone, frozen.supplier.taxRegistrationNo, frozen.lines["1"].productCode, frozen.lines["1"].poNumber, frozen.lines["1"].receiptNumber], [s.code, "0111-1", supplierTaxNo, `${TAG}-TOM`, first.po.number, first.intake.receiptNumber]);
  assert.equal(b.current, null);

  // A posted bill is not edited or cancelled — it is corrected with a debit note.
  await assert.rejects(updateBill(bill.id, { supplier_id: s.id, supplier_invoice_no: `${TAG}-F9`, bill_date: today, lines: [{ intake_id: first.intake.id, unit_price: "7" }], expected_version: b.version }, billing), status(409));
  await assert.rejects(cancelBill(bill.id, { reason: "غلط" }, billing), status(409));
  await assert.rejects(prisma.supplierBill.update({ where: { id: bill.id }, data: { postSnapshot: {} } }));
  const dn = await createDebitNote(bill.id, { reason: `${TAG} 10 كيلو بايظة`, lines: [{ bill_line_id: b.lines[0].id, quantity: "10" }], idempotency_key: `${TAG}-dn1` }, billing);
  assert.equal(D((await supplierPayable(prisma, s.id)).toString()).minus(owedBefore).toFixed(2), posted.total.minus(dn.total).toFixed(2));

  // The supplier's card changes later; the posted bill and its print keep the card it posted with.
  await prisma.supplier.update({ where: { id: s.id }, data: { phone: "0111-9", nameAr: `${TAG} سيف الجديد` } });
  const later = await getBill(bill.id);
  assert.deepEqual(later.postSnapshot, frozen);
  const doc = billDocument({ bill: later, snapshot: later.postSnapshot, current: later.current, attachments: [], lang: "ar" });
  assert.deepEqual([doc.supplier?.phone, doc.supplier?.name, doc.meta.supplierInvoiceNo, doc.status.final, doc.settlement.debited], ["0111-1", `${TAG} سيف`, `${TAG}-F1`, true, dn.total.toFixed(2)]);
});
