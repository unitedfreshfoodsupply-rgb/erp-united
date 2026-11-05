/* One customer record, read everywhere (Nov 2026): the e-invoice receiver comes from the
   customer's master record (its legal entity), is edited only there, under the customer
   permission, with field-level audit; new ETA drafts follow an edit at once, while issued
   invoices and documents already signed for ETA keep what they were issued with. The old
   per-customer ETA-screen copy takes no new edits. Synthetic data on the test database. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, taxNo } from "./_db";
import { createCustomer, createLegalEntityForCustomer, customerEtaIdentity, updateCustomer, updateCustomerLegalEntity } from "@/lib/sales/customers";
import { issueInvoice } from "@/lib/sales/invoicing";
import { updateSetting } from "@/lib/core/settings-service";
import type { EtaGateway, EtaSigner } from "@/lib/eta/gateway";
import { etaInvoiceState, etaOverview, saveIssuerProfile, saveReceiverProfile, setItemCode, setUnitType, submitInvoiceToEta } from "@/lib/eta/service";

const TAG = `ZZMDM${Date.now()}`;
const D = (v: number) => new Prisma.Decimal(v);
const sales = actor("مدير مبيعات", ["sales.customers.view", "sales.customers.manage", "sales.invoices.manage", "sales.invoices.view"], "mdm-sales");
const eta = actor("محاسب ضرائب", ["sales.customers.view", "accounting.eta.view", "accounting.eta.manage"], "mdm-eta");
const etaOnly = actor("مراجع ضرائب", ["accounting.eta.view"], "mdm-eta-view");
const clerk = actor("كاتب", ["sales.invoices.view"], "mdm-clerk");
const admin = actor("مدير", ["settings.manage"], null, "SUPER_ADMIN");
const address = { country: "EG", governate: "Cairo", region_city: "Nasr City", street: "Abbas El Akkad", building_number: "12" };
let productId = "";
let companyId = "";
let originalRegNo: string | null = null;

async function issued(customerId: string) {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  const inv = await prisma.salesInvoice.create({
    data: {
      customerId, buyerName: c.name, gross: D(500), discountTotal: D(0), net: D(500), taxTotal: D(0), total: D(500), createdBy: "test",
      lines: { create: { lineNo: 1, productId, description: "Mango", uomCode: "KG", quantity: D(10), unitPrice: D(50), taxCode: "EXEMPT", taxRate: D(0), gross: D(500), discount: D(0), net: D(500), tax: D(0), total: D(500) } },
    },
  });
  await issueInvoice(inv.id, {}, sales);
  return prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
}

/** A fake ETA that accepts and a signer that adds a signature: nothing leaves the machine. */
const fakeDeps = (uuid: string) => {
  const signer: EtaSigner = { async sign(d) { return { ...d, signatures: [{ signatureType: "I", value: "fake" }] }; } };
  const gateway: EtaGateway = {
    async submit(docs) { return { submissionId: `${TAG}-S`, accepted: docs.map((d) => ({ uuid, longId: "L", internalId: d.internalID, hashKey: "H" })), rejected: [], raw: {} }; },
    async getDocument() { throw new Error("not used"); },
    async getSubmission() { throw new Error("not used"); },
    async searchDocuments() { throw new Error("not used"); },
  };
  return () => ({ gateway, signer, checkSignatures: () => ({ ok: true as const, certificate: { subject: "CN=T", issuer: "CN=T", serialNumber: "1", fingerprint256: "A", validFrom: "", validTo: "" } }) });
};

before(async () => {
  const company = await prisma.company.findFirstOrThrow({ where: { active: true }, orderBy: { createdAt: "asc" } });
  companyId = company.id;
  originalRegNo = company.taxRegistrationNumber;
  if (!originalRegNo || !/^\d{9}$/.test(originalRegNo)) await prisma.company.update({ where: { id: companyId }, data: { taxRegistrationNumber: "999999999" } });
  await saveIssuerProfile({ eta_branch_id: "0", activity_code: "4630", country: "EG", governate: "Cairo", regionCity: "Nasr City", street: "St", buildingNumber: "1" }, eta);
  productId = (await prisma.stockProduct.create({ data: { name: `${TAG} Mango` } })).id;
  await setItemCode(productId, { item_type: "EGS", item_code: `EG-999999999-${TAG}` }, eta);
  await setUnitType("KG", { eta_unit_type: "KGM" }, eta);
  await updateSetting("accounting.eta_api_submission_from", "2000-01-01", admin, { reason: TAG });
});

after(async () => {
  await updateSetting("accounting.eta_api_submission_from", null, admin, { reason: TAG });
  if (originalRegNo !== (await prisma.company.findUniqueOrThrow({ where: { id: companyId } })).taxRegistrationNumber) await prisma.company.update({ where: { id: companyId }, data: { taxRegistrationNumber: originalRegNo } });
  await prisma.$disconnect();
});

test("a company customer with no legal entity: ETA names every missing field and points to the customer record", async () => {
  const c = await createCustomer({ name: `${TAG} فندق النيل`, tax_registration_no: taxNo() }, sales);
  const inv = await issued(c.id);
  const s = await etaInvoiceState(inv.id, etaOnly);
  const fields = s.issues.filter((i) => i.level === "error").map((i) => i.field);
  for (const f of ["country", "governate", "regionCity", "street", "buildingNumber"]) assert.ok(fields.includes(`receiver.address.${f}`), f);
  assert.equal(s.ready, false);
  assert.equal(s.receiverEditHref, `/sales/customers/${c.id}?tab=overview#eta-identity`);
  const id = await customerEtaIdentity(c.id, etaOnly);
  assert.equal(id.effectiveType, "B");
  assert.deepEqual(id.gaps, ["legal_entity", "country", "governate", "regionCity", "street", "buildingNumber"]);
  assert.equal(id.canEdit, false);
});

test("the ETA screen no longer edits a separate copy: refused, nothing written", async () => {
  const c = await createCustomer({ name: `${TAG} مطعم`, tax_registration_no: taxNo() }, sales);
  await assert.rejects(saveReceiverProfile(c.id, { country: "EG" }, eta), (e: any) => e.status === 409 && e.code === "eta.receiver-profile-retired" && e.details?.editHref?.includes(c.id));
  assert.equal(await prisma.etaReceiverProfile.count({ where: { customerId: c.id } }), 0);
});

test("only the customer permission edits the identity; the ETA role can read it, a clerk cannot", async () => {
  const c = await createCustomer({ name: `${TAG} شركة`, tax_registration_no: taxNo() }, sales);
  await assert.rejects(createLegalEntityForCustomer(c.id, address, eta), (e: any) => e.status === 403);
  await assert.rejects(customerEtaIdentity(c.id, clerk), (e: any) => e.status === 403);
  const le = await createLegalEntityForCustomer(c.id, address, sales);
  await assert.rejects(updateCustomerLegalEntity(le!.id, { street: "X" }, eta), (e: any) => e.status === 403);
  // A second legal entity cannot be created over the linked one.
  await assert.rejects(createLegalEntityForCustomer(c.id, address, sales), (e: any) => e.status === 409);
});

test("create-and-link takes the name and tax number from the card, links it, and audits both", async () => {
  const reg = taxNo();
  const c = await createCustomer({ name: `${TAG} نادي`, legal_name: `${TAG} نادي ش.م.م`, tax_registration_no: reg }, sales);
  const le = await createLegalEntityForCustomer(c.id, address, sales);
  assert.equal(le!.name, `${TAG} نادي ش.م.م`);
  assert.equal(le!.taxRegistrationNo, reg);
  assert.equal(le!.code, `LE-${c.code}`);
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).legalEntityId, le!.id);
  const audits = await prisma.auditLog.findMany({ where: { entityId: { in: [c.id, le!.id] } }, select: { action: true, fieldChanged: true } });
  assert.ok(audits.some((a) => a.action === "customer_legal_entity_created"));
  assert.ok(audits.some((a) => a.action === "customer_edited" && a.fieldChanged === "legalEntityId"));
  const id = await customerEtaIdentity(c.id, sales);
  assert.deepEqual(id.gaps, []);
  assert.equal(id.receiver.origin, "legal_entity");
  assert.equal(id.canEdit, true);
});

test("editing the customer's tax address changes the next ETA draft at once — and only the draft", async () => {
  const c = await createCustomer({ name: `${TAG} فندق الأهرام`, tax_registration_no: taxNo() }, sales);
  const le = await createLegalEntityForCustomer(c.id, address, sales);
  const first = await issued(c.id);
  const second = await issued(c.id);
  // The first invoice goes to (a fake) ETA and is signed with the address of the day.
  const sent = await submitInvoiceToEta(first.id, eta, fakeDeps(`${TAG}UUID0000001`));
  assert.ok(sent);
  const signedBefore = await etaInvoiceState(first.id, etaOnly);
  assert.equal(signedBefore.documentSource, "signed");
  assert.equal((signedBefore.document as any).receiver.address.street, "Abbas El Akkad");

  // One edit, in the customer record, with field-level audit.
  await updateCustomerLegalEntity(le!.id, { street: "El Merghany", expected_version: le!.version }, sales);
  const audit = await prisma.auditLog.findFirst({ where: { entityId: le!.id, fieldChanged: "street" }, orderBy: { timestamp: "desc" } });
  assert.deepEqual([audit?.oldValue, audit?.newValue], ["Abbas El Akkad", "El Merghany"]);

  // The unsent invoice's draft follows it...
  const draft = await etaInvoiceState(second.id, etaOnly);
  assert.equal(draft.documentSource, "draft");
  assert.equal((draft.document as any).receiver.address.street, "El Merghany");
  // ...the signed document does not: it is shown exactly as it was signed and sent.
  const signedAfter = await etaInvoiceState(first.id, etaOnly);
  assert.equal((signedAfter.document as any).receiver.address.street, "Abbas El Akkad");
  assert.equal((await prisma.etaDocument.findFirstOrThrow({ where: { sourceId: first.id } })).signedPayload?.includes("Abbas El Akkad"), true);
  // The ETA screen shows the same current value, read-only.
  const ov = await etaOverview(etaOnly);
  const row = ov.customers.find((x) => x.id === c.id);
  assert.equal(row?.receiver.address.street, "El Merghany");
  assert.equal(row?.receiver.origin, "legal_entity");
});

test("a rename reaches current views; the legal name follows the legal record; issued invoices never change", async () => {
  const c = await createCustomer({ name: `${TAG} كافيه`, tax_registration_no: taxNo() }, sales);
  await createLegalEntityForCustomer(c.id, address, sales);
  const inv = await issued(c.id);
  const frozen = { buyerName: inv.buyerName, buyerTaxId: inv.buyerTaxId, buyerAddress: inv.buyerAddress };
  const cur = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  await updateCustomer(c.id, { name: `${TAG} كافيه الجديد`, expected_version: cur.version }, sales);
  // The issued invoice keeps the name, tax number and address it was issued with.
  const after = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.deepEqual({ buyerName: after.buyerName, buyerTaxId: after.buyerTaxId, buyerAddress: after.buyerAddress }, frozen);
  assert.equal(after.customerId, c.id);
  // The database itself refuses to rewrite it.
  await assert.rejects(prisma.salesInvoice.update({ where: { id: inv.id }, data: { buyerName: "X" } }));
  // Current views read the customer record: the ETA list and the identity show the new name.
  const ov = await etaOverview(etaOnly);
  assert.equal(ov.customers.find((x) => x.id === c.id)?.name, `${TAG} كافيه الجديد`);
  // A new invoice references the same canonical customer. Its legal buyer name is the legal
  // record's (the card's legal name, else the legal entity's), not the display name...
  const le = await prisma.customerLegalEntity.findFirstOrThrow({ where: { customers: { some: { id: c.id } } } });
  const next = await issued(c.id);
  assert.equal(next.customerId, c.id);
  assert.equal(next.buyerName, le.name);
  // ...so a change of legal name, made once in the customer record, is what new invoices take.
  const cur2 = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  await updateCustomer(c.id, { legal_name: `${TAG} كافيه الجديد ش.م.م`, expected_version: cur2.version }, sales);
  const third = await issued(c.id);
  assert.equal(third.buyerName, `${TAG} كافيه الجديد ش.م.م`);
  // Every earlier invoice is untouched.
  assert.equal((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).buyerName, frozen.buyerName);
  assert.equal((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: next.id } })).buyerName, le.name);
});

test("an inactive legal entity is not used for ETA (the same rule as invoice issue)", async () => {
  const c = await createCustomer({ name: `${TAG} فندق قديم`, tax_registration_no: taxNo() }, sales);
  const le = await createLegalEntityForCustomer(c.id, address, sales);
  await updateCustomerLegalEntity(le!.id, { active: false, expected_version: le!.version }, sales);
  const id = await customerEtaIdentity(c.id, sales);
  assert.equal(id.receiver.origin, "none");
  assert.ok(id.gaps.includes("legal_entity"));
});
