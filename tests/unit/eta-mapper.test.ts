/* ETA mapper and validator: a complete UNITED invoice maps to a consistent Invoice v1.0
   document; every missing piece of ETA data is reported (never invented); UNITED's own
   arithmetic and the ETA totals are both recomputed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapInvoiceToEta, receiverType } from "../../lib/eta/mapper";
import { validateEtaSource, hasBlockingIssues } from "../../lib/eta/validate";
import type { EtaSource } from "../../lib/eta/types";

const address = { country: "EG", governate: "Cairo", regionCity: "Nasr City", street: "Abbas El Akkad", buildingNumber: "12", postalCode: null, floor: null, room: null, landmark: null, additionalInformation: null };
const none = { country: null, governate: null, regionCity: null, street: null, buildingNumber: null, postalCode: null, floor: null, room: null, landmark: null, additionalInformation: null };

/** 10 kg mango at 50, 10% off, VAT 14% → gross 500, discount 50, net 450, tax 63, total 513.
 *  20 kg tomato at 7.25, exempt → 145. Invoice: gross 645, discount 50, net 595, tax 63, total 658. */
function source(over: Partial<EtaSource> = {}): EtaSource {
  return {
    kind: "sales_invoice",
    invoice: { id: "inv1", number: "INV-2026-00042", status: "issued", issuedAt: "2026-10-08T09:30:15.123Z", currencyCode: "EGP", buyerName: "Hotel Nile", buyerTaxId: "123456789", gross: "645", discountTotal: "50", net: "595", taxTotal: "63", total: "658", orderNumber: "UN-20261008-0007" },
    issuer: { name: "UNITED Fresh Food Supply", registrationNumber: "987654321", etaBranchId: "0", activityCode: "4630", address },
    receiver: { type: null, personalId: null, address },
    lines: [
      { lineNo: 1, description: "Mango", productId: "p1", internalCode: "MNG", itemType: "EGS", itemCode: "EG-987654321-MNG", uomCode: "KG", etaUnitType: "KGM", quantity: "10", unitPrice: "50", discountPct: "10", gross: "500", discount: "50", net: "450", taxCode: "VAT14", taxRate: "14", etaTaxType: "T1", etaTaxSubtype: "V009", tax: "63", total: "513" },
      { lineNo: 2, description: "Tomato", productId: "p2", internalCode: "p2", itemType: "EGS", itemCode: "EG-987654321-TOM", uomCode: "KG", etaUnitType: "KGM", quantity: "20", unitPrice: "7.25", discountPct: "0", gross: "145", discount: "0", net: "145", taxCode: "EXEMPT", taxRate: "0", etaTaxType: "T1", etaTaxSubtype: "V003", tax: "0", total: "145" },
    ],
    personIdThreshold: 50000,
    ...over,
  };
}
const errorsOf = (s: EtaSource) => validateEtaSource(s).issues.filter((i) => i.level === "error");
const has = (s: EtaSource, field: string) => errorsOf(s).some((e) => e.field.startsWith(field));

test("a complete invoice maps to Invoice v1.0 with no blocking issue", () => {
  const { issues, document: d } = validateEtaSource(source());
  assert.equal(hasBlockingIssues(issues), false, JSON.stringify(issues));
  assert.equal(d.documentType, "i");
  assert.equal(d.documentTypeVersion, "1.0");
  assert.equal(d.internalID, "INV-2026-00042");
  assert.equal(d.dateTimeIssued, "2026-10-08T09:30:15Z");
  assert.equal(d.taxpayerActivityCode, "4630");
  assert.deepEqual([d.issuer.type, d.issuer.id, d.issuer.address.branchID], ["B", "987654321", "0"]);
  assert.deepEqual([d.receiver.type, d.receiver.id, d.receiver.name], ["B", "123456789", "Hotel Nile"]);
  assert.equal(d.salesOrderReference, "UN-20261008-0007");
});

test("lines carry codes, unit value, discount and tax exactly as invoiced", () => {
  const d = mapInvoiceToEta(source());
  const [m, t] = d.invoiceLines;
  assert.deepEqual([m.itemType, m.itemCode, m.unitType, m.internalCode], ["EGS", "EG-987654321-MNG", "KGM", "MNG"]);
  assert.deepEqual([m.quantity, m.unitValue.amountEGP, m.unitValue.currencySold], [10, 50, "EGP"]);
  assert.deepEqual([m.salesTotal, m.discount.rate, m.discount.amount, m.netTotal, m.total], [500, 10, 50, 450, 513]);
  assert.deepEqual(m.taxableItems, [{ taxType: "T1", subType: "V009", rate: 14, amount: 63 }]);
  // An exempt line still carries its classification, at zero.
  assert.deepEqual(t.taxableItems, [{ taxType: "T1", subType: "V003", rate: 0, amount: 0 }]);
});

test("document totals are consistent: sums of lines, total = net + taxes", () => {
  const d = mapInvoiceToEta(source());
  assert.deepEqual([d.totalSalesAmount, d.totalDiscountAmount, d.netAmount, d.totalAmount], [645, 50, 595, 658]);
  assert.deepEqual(d.taxTotals, [{ taxType: "T1", amount: 63 }]);
  assert.equal(d.extraDiscountAmount, 0);
  assert.equal(d.totalItemsDiscountAmount, 0);
});

test("an internally inconsistent invoice is refused, never corrected", () => {
  const s = source();
  s.lines[0] = { ...s.lines[0], net: "451", total: "514" };
  assert.ok(has(s, "invoiceLines[1].net"));
  const h = source();
  h.invoice = { ...h.invoice, total: "659" };
  assert.ok(has(h, "totals.total") && has(h, "totalAmount"));
});

test("a rounded line (qty × price ≠ 2-dp gross) is a warning, not silently changed", () => {
  const s = source();
  // 3.333 kg × 7.5 = 24.9975 → invoiced 25.00
  s.lines = [{ ...s.lines[1], quantity: "3.333", unitPrice: "7.5", gross: "25", net: "25", total: "25" }];
  s.invoice = { ...s.invoice, gross: "25", discountTotal: "0", net: "25", taxTotal: "0", total: "25" };
  const { issues, document } = validateEtaSource(s);
  assert.equal(hasBlockingIssues(issues), false, JSON.stringify(issues));
  assert.ok(issues.some((i) => i.level === "warning" && i.field.endsWith("salesTotal")));
  assert.equal(document.invoiceLines[0].salesTotal, 25);
});

test("missing ETA data is reported field by field — nothing is invented", () => {
  const s = source({ issuer: { name: "UNITED", registrationNumber: null, etaBranchId: null, activityCode: null, address: none } });
  s.lines[0] = { ...s.lines[0], itemType: null, itemCode: null, etaUnitType: null, etaTaxType: null, etaTaxSubtype: null };
  for (const f of ["issuer.id", "issuer.address.branchID", "taxpayerActivityCode", "issuer.address.governate", "invoiceLines[1].itemCode", "invoiceLines[1].unitType", "invoiceLines[1].taxableItems"]) assert.ok(has(s, f), f);
  const d = mapInvoiceToEta(s);
  // Empty, never a default or a guess.
  assert.deepEqual([d.issuer.id, d.issuer.address.branchID, d.taxpayerActivityCode, d.invoiceLines[0].itemCode, d.invoiceLines[0].unitType, d.invoiceLines[0].taxableItems[0].subType], ["", "", "", "", "", ""]);
});

test("receiver rules: B needs a registration number and address; P needs an id above the threshold; F needs id and country", () => {
  assert.ok(has(source({ receiver: { type: null, personalId: null, address: none } }), "receiver.address"));
  const bad = source();
  bad.invoice = { ...bad.invoice, buyerTaxId: "12345" };
  assert.ok(has(bad, "receiver.id"));

  const person = source({ receiver: { type: null, personalId: null, address: none } });
  person.invoice = { ...person.invoice, buyerTaxId: null };
  assert.equal(receiverType(person), "P");
  assert.equal(has(person, "receiver"), false, "below the threshold a person needs no id");
  assert.ok(has({ ...person, personIdThreshold: 500 }, "receiver.id"), "at or above the threshold the national id is required");

  const foreign = source({ receiver: { type: "F", personalId: null, address: none } });
  assert.ok(has(foreign, "receiver.id") && has(foreign, "receiver.address.country"));
});

test("document-level refusals: draft, no number, foreign currency, no lines, unlinked line", () => {
  const s = source();
  s.invoice = { ...s.invoice, status: "draft", number: null, currencyCode: "USD" };
  for (const f of ["invoice.status", "internalID", "unitValue.currencySold"]) assert.ok(has(s, f), f);
  assert.ok(has({ ...source(), lines: [] }, "invoiceLines"));
  const u = source();
  u.lines[0] = { ...u.lines[0], productId: null, internalCode: null };
  assert.ok(has(u, "invoiceLines[1].itemCode") && has(u, "invoiceLines[1].internalCode"));
  const z = source();
  z.lines[0] = { ...z.lines[0], quantity: "0" };
  assert.ok(has(z, "invoiceLines[1].quantity"));
});

test("a credit note maps as type c, carries the invoice reference, and is refused without it", () => {
  const credit: EtaSource = { ...source(), kind: "credit_note", references: ["INV-UUID-1"] };
  const { issues, document } = validateEtaSource(credit);
  assert.equal(document.documentType, "c");
  assert.deepEqual(document.references, ["INV-UUID-1"]);
  assert.ok(!issues.some((i) => i.field === "references"));
  const orphan = validateEtaSource({ ...credit, references: [] });
  assert.ok(orphan.issues.some((i) => i.level === "error" && i.field === "references"));
  // An invoice never carries references.
  assert.equal(validateEtaSource(source()).document.references, undefined);
});

