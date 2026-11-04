/* The e-invoice receiver comes from the customer's master record (lib/eta/receiver.ts):
   the active legal entity first, the retired ETA-screen copy only as a fallback, nothing
   invented, and every missing field named. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { customerTaxId, receiverGaps, resolveEtaReceiver } from "@/lib/eta/receiver";
import { mapInvoiceToEta } from "@/lib/eta/mapper";
import type { EtaSource } from "@/lib/eta/types";

const address = { country: "EG", governate: "Cairo", regionCity: "Nasr City", street: "Abbas El Akkad", buildingNumber: "12" };
const le = (over: Record<string, unknown> = {}) => ({ id: "le1", active: true, taxRegistrationNo: "123456789", receiverType: null, receiverId: null, ...address, ...over });
const legacy = { receiverType: "B", receiverId: null, country: "EG", governate: "Giza", regionCity: "Dokki", street: "Old", buildingNumber: "9" };

test("the active legal entity is the source; the retired ETA-screen copy is ignored then", () => {
  const r = resolveEtaReceiver({ customer: { taxRegistrationNo: null }, legalEntity: le(), legacyProfile: legacy });
  assert.equal(r.origin, "legal_entity");
  assert.equal(r.address.governate, "Cairo");
  assert.equal(r.address.street, "Abbas El Akkad");
});

test("an inactive legal entity is not used (the issue rule already ignores it)", () => {
  const r = resolveEtaReceiver({ customer: { taxRegistrationNo: null }, legalEntity: le({ active: false }), legacyProfile: null });
  assert.equal(r.origin, "none");
  assert.equal(r.address.country, null);
  assert.equal(customerTaxId({ customer: { taxRegistrationNo: null }, legalEntity: le({ active: false }), legacyProfile: null }), null);
});

test("with no legal entity, data typed earlier on the ETA screen is still read (not lost)", () => {
  const r = resolveEtaReceiver({ customer: { taxRegistrationNo: "123456789" }, legalEntity: null, legacyProfile: legacy });
  assert.equal(r.origin, "eta_profile_legacy");
  assert.equal(r.address.regionCity, "Dokki");
  // ...but it is flagged: a company receiver's address must move to a legal entity.
  assert.ok(receiverGaps({ customer: { taxRegistrationNo: "123456789" }, legalEntity: null, legacyProfile: legacy }).gaps.includes("legal_entity"));
});

test("tax number: the card's first, else the active legal entity's — never invented", () => {
  assert.equal(customerTaxId({ customer: { taxRegistrationNo: "111111111" }, legalEntity: le(), legacyProfile: null }), "111111111");
  assert.equal(customerTaxId({ customer: { taxRegistrationNo: "  " }, legalEntity: le(), legacyProfile: null }), "123456789");
  assert.equal(customerTaxId({ customer: { taxRegistrationNo: null }, legalEntity: null, legacyProfile: legacy }), null);
});

test("a complete company receiver has no gaps; each missing address part is named", () => {
  assert.deepEqual(receiverGaps({ customer: { taxRegistrationNo: null }, legalEntity: le(), legacyProfile: null }).gaps, []);
  const g = receiverGaps({ customer: { taxRegistrationNo: null }, legalEntity: le({ street: "", buildingNumber: null }), legacyProfile: null });
  assert.equal(g.effectiveType, "B");
  assert.deepEqual(g.gaps, ["street", "buildingNumber"]);
});

test("a company with no tax number and no legal entity: both are named, nothing filled in", () => {
  const g = receiverGaps({ customer: { taxRegistrationNo: null }, legalEntity: null, legacyProfile: { receiverType: "B" } });
  assert.deepEqual(g.gaps, ["tax_registration_no", "legal_entity", "country", "governate", "regionCity", "street", "buildingNumber"]);
});

test("an individual needs no address; the national id is a threshold rule, not a gap", () => {
  const g = receiverGaps({ customer: { taxRegistrationNo: null }, legalEntity: null, legacyProfile: null });
  assert.equal(g.effectiveType, "P");
  assert.deepEqual(g.gaps, []);
  assert.equal(g.personIdOnlyAbove, true);
});

test("a foreign receiver needs an id and a country", () => {
  const g = receiverGaps({ customer: { taxRegistrationNo: null }, legalEntity: le({ receiverType: "F", taxRegistrationNo: null, country: null }), legacyProfile: null });
  assert.equal(g.effectiveType, "F");
  assert.deepEqual(g.gaps, ["receiver_id", "country"]);
});

test("the ETA payload carries the canonical receiver: legal-entity address, invoice's frozen name and tax id", () => {
  const r = resolveEtaReceiver({ customer: { taxRegistrationNo: "123456789" }, legalEntity: le(), legacyProfile: legacy });
  const src = {
    kind: "sales_invoice",
    invoice: { id: "i", number: "INV-1", status: "issued", issuedAt: "2026-11-04T10:00:00.000Z", issueDate: "2026-11-04", currencyCode: "EGP", buyerName: "فندق النيل", buyerTaxId: "123456789", gross: "100", discountTotal: "0", net: "100", taxTotal: "0", total: "100", orderNumber: null },
    issuer: { name: "UNITED", registrationNumber: "999999999", etaBranchId: "0", activityCode: "4630", address: { ...r.address } },
    receiver: { type: r.type, personalId: r.personalId, address: r.address },
    lines: [],
    personIdThreshold: "50000",
  } as unknown as EtaSource;
  const doc = mapInvoiceToEta(src) as { receiver: { type: string; id: string; name: string; address: { governate: string; street: string } } };
  assert.equal(doc.receiver.type, "B");
  assert.equal(doc.receiver.id, "123456789");
  assert.equal(doc.receiver.name, "فندق النيل");
  assert.equal(doc.receiver.address.governate, "Cairo");
  assert.equal(doc.receiver.address.street, "Abbas El Akkad");
});
