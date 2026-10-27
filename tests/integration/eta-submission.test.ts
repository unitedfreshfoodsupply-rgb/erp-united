/* ETA submission against PostgreSQL with a fake ETA: one UNITED invoice can never create
   two ETA submissions — not on a double click, not on concurrent requests, not after a
   timeout whose outcome is unknown. The invoice, its numbering and its accounting are
   never touched by any of it. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor } from "./_db";
import { createCustomer } from "@/lib/sales/customers";
import { createCreditNote, issueInvoice } from "@/lib/sales/invoicing";
import { EtaTransportError, type EtaGateway, type EtaSigner, type EtaSubmitResult } from "@/lib/eta/gateway";
import { etaCreditNoteState, etaInvoiceState, reconcileCreditNoteEta, reconcileInvoiceEta, refreshCreditNoteEta, refreshInvoiceEta, saveIssuerProfile, saveReceiverProfile, setItemCode, setUnitType, submitCreditNoteToEta, submitInvoiceToEta, type EtaDeps } from "@/lib/eta/service";

const TAG = `ZZETA${Date.now()}`;
const acct = actor("محاسب", ["sales.invoices.manage", "sales.invoices.view", "sales.customers.manage", "accounting.eta.view", "accounting.eta.manage"]);
const viewer = actor("مشرف", ["accounting.eta.view"]);
const D = (v: number) => new Prisma.Decimal(v);
let companyId = "";
let originalRegNo: string | null = null;
let originalProfile: Prisma.EtaIssuerProfileGetPayload<object> | null = null;
let customerId = "";
let productId = "";

/** A fake ETA that counts submissions and answers as told. */
function fakeEta(answer: (n: number) => EtaSubmitResult | Promise<EtaSubmitResult>, remoteStatus = "Valid") {
  const state = { submits: 0, signs: 0 };
  const signer: EtaSigner = { async sign(d) { state.signs++; return { ...d, signatures: [{ signatureType: "I", value: "fake" }] }; } };
  const gateway: EtaGateway = {
    async submit() { state.submits++; await new Promise((r) => setTimeout(r, 30)); return answer(state.submits); },
    async getDocument(uuid) { return { uuid, longId: "LONG-1", internalId: null, status: remoteStatus, raw: { status: remoteStatus, validationResults: { status: remoteStatus } } }; },
  };
  return { state, deps: (): EtaDeps => ({ gateway, signer }) };
}
const accepted = (internalId: string, uuid = `${TAG}-U`): EtaSubmitResult => ({ submissionId: `${TAG}-S`, accepted: [{ uuid, longId: "LONG-1", internalId, hashKey: "H" }], rejected: [], raw: { ok: true } });

async function issuedInvoice(qty = 10) {
  const inv = await prisma.salesInvoice.create({
    data: {
      customerId, buyerName: `${TAG} فندق`, gross: D(qty * 50), discountTotal: D(0), net: D(qty * 50), taxTotal: D(0), total: D(qty * 50), createdBy: "test",
      lines: { create: { lineNo: 1, productId, description: "Mango", uomCode: "KG", quantity: D(qty), unitPrice: D(50), taxCode: "EXEMPT", taxRate: D(0), gross: D(qty * 50), discount: D(0), net: D(qty * 50), tax: D(0), total: D(qty * 50) } },
    },
  });
  await issueInvoice(inv.id, {}, acct);
  return prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
}

before(async () => {
  const company = await prisma.company.findFirstOrThrow({ where: { active: true }, orderBy: { createdAt: "asc" }, include: { etaIssuerProfile: true } });
  companyId = company.id;
  originalRegNo = company.taxRegistrationNumber;
  originalProfile = company.etaIssuerProfile;
  if (!originalRegNo || !/^\d{9}$/.test(originalRegNo)) await prisma.company.update({ where: { id: companyId }, data: { taxRegistrationNumber: "999999999" } });
  const addr = { country: "EG", governate: "Cairo", regionCity: "Nasr City", street: "St", buildingNumber: "1" };
  await saveIssuerProfile({ eta_branch_id: "0", activity_code: "4630", ...addr }, acct);
  const reg = String(Date.now()).slice(-9);
  customerId = (await createCustomer({ name: `${TAG} فندق`, tax_registration_no: reg }, acct)).id;
  await saveReceiverProfile(customerId, addr, acct);
  productId = (await prisma.stockProduct.create({ data: { name: `${TAG} Mango` } })).id;
  await setItemCode(productId, { item_type: "EGS", item_code: `EG-999999999-${TAG}` }, acct);
  await setUnitType("KG", { eta_unit_type: "KGM" }, acct);
  await prisma.taxRate.findFirstOrThrow({ where: { code: "EXEMPT", etaType: { not: null }, etaSubtype: { not: null } } });
});

after(async () => {
  // Leave the shared test database as it was for the other suites.
  if (originalRegNo !== (await prisma.company.findUniqueOrThrow({ where: { id: companyId } })).taxRegistrationNumber) await prisma.company.update({ where: { id: companyId }, data: { taxRegistrationNumber: originalRegNo } });
  if (originalProfile) await prisma.etaIssuerProfile.update({ where: { companyId }, data: { etaBranchId: originalProfile.etaBranchId, activityCode: originalProfile.activityCode } });
  else await prisma.etaIssuerProfile.deleteMany({ where: { companyId } });
  await prisma.etaUnitType.deleteMany({ where: { uomCode: "KG", etaUnitType: "KGM" } });
  await prisma.$disconnect();
});

test("a complete invoice is ready; the state is visible to a viewer with no submission yet", async () => {
  const inv = await issuedInvoice();
  const s = await etaInvoiceState(inv.id, viewer);
  assert.equal(s.ready, true, JSON.stringify(s.issues));
  assert.equal(s.eta, null);
  assert.equal(s.document.internalID, inv.number);
  await assert.rejects(submitInvoiceToEta(inv.id, viewer, fakeEta(() => accepted(inv.number!)).deps), (e: any) => e.status === 403);
});

test("three simultaneous submits of one invoice reach ETA once", async () => {
  const inv = await issuedInvoice();
  const eta = fakeEta(() => accepted(inv.number!, `${TAG}-U1`));
  const results = await Promise.all([1, 2, 3].map(() => submitInvoiceToEta(inv.id, acct, eta.deps)));
  assert.equal(eta.state.submits, 1);
  assert.equal(results.filter((r) => r.submitted).length, 1);
  const docs = await prisma.etaDocument.findMany({ where: { sourceType: "sales_invoice", sourceId: inv.id } });
  assert.equal(docs.length, 1);
  assert.deepEqual([docs[0].status, docs[0].uuid, docs[0].longId, docs[0].submissionId, docs[0].attempts], ["submitted", `${TAG}-U1`, "LONG-1", `${TAG}-S`, 1]);
  assert.ok(docs[0].submittedAt && docs[0].payloadHash);
  // Later clicks do nothing either.
  const again = await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(again.submitted, false);
  assert.equal(eta.state.submits, 1);
});

test("refresh records ETA's validation result (valid → acceptedAt)", async () => {
  const inv = await issuedInvoice();
  await submitInvoiceToEta(inv.id, acct, fakeEta(() => accepted(inv.number!, `${TAG}-U2`)).deps);
  const r = await refreshInvoiceEta(inv.id, acct, fakeEta(() => accepted(inv.number!), "Valid").deps);
  assert.equal(r.status, "valid");
  assert.ok(r.acceptedAt);
});

test("a timeout after sending is 'unknown': never resent until reconciled", async () => {
  const inv = await issuedInvoice();
  const lost = fakeEta(() => { throw new EtaTransportError("timeout", true); });
  await assert.rejects(submitInvoiceToEta(inv.id, acct, lost.deps), (e: any) => e.status === 502);
  let doc = await prisma.etaDocument.findFirstOrThrow({ where: { sourceId: inv.id } });
  assert.equal(doc.status, "unknown");
  const retry = fakeEta(() => accepted(inv.number!));
  const r = await submitInvoiceToEta(inv.id, acct, retry.deps);
  assert.equal(r.submitted, false);
  assert.equal(retry.state.submits, 0, "an unknown outcome is never resent");
  // The accountant checks the portal: not there → safe to send again.
  await reconcileInvoiceEta(inv.id, { not_received: true, reason: "مش موجودة على البوابة" }, acct);
  doc = await prisma.etaDocument.findFirstOrThrow({ where: { sourceId: inv.id } });
  assert.equal(doc.status, "failed");
  await submitInvoiceToEta(inv.id, acct, retry.deps);
  assert.equal(retry.state.submits, 1);
  assert.equal((await prisma.etaDocument.findFirstOrThrow({ where: { sourceId: inv.id } })).attempts, 2);
  await assert.rejects(reconcileInvoiceEta(inv.id, { uuid: "x".repeat(20) }, acct), (e: any) => e.status === 409, "reconcile only for unknown states");
});

test("a signing failure never reached ETA: 'failed', safe to retry; a rejection may be resent", async () => {
  const inv = await issuedInvoice();
  const eta = fakeEta(() => accepted(inv.number!));
  const broken: EtaDeps = { gateway: eta.deps().gateway, signer: { async sign() { throw new EtaTransportError("token not inserted", false); } } };
  await assert.rejects(submitInvoiceToEta(inv.id, acct, () => broken), (e: any) => e.status === 502);
  assert.equal((await prisma.etaDocument.findFirstOrThrow({ where: { sourceId: inv.id } })).status, "failed");
  assert.equal(eta.state.submits, 0);

  const inv2 = await issuedInvoice();
  const rejecting = fakeEta((n) => (n === 1 ? { submissionId: null, accepted: [], rejected: [{ internalId: inv2.number!, error: { message: "bad receiver" } }], raw: {} } : accepted(inv2.number!, `${TAG}-U3`)));
  const r1 = await submitInvoiceToEta(inv2.id, acct, rejecting.deps);
  assert.equal(r1.eta.status, "rejected");
  assert.deepEqual(r1.eta.lastError, { message: "bad receiver" });
  const r2 = await submitInvoiceToEta(inv2.id, acct, rejecting.deps);
  assert.equal(r2.eta.status, "submitted");
  const events = await prisma.etaDocumentEvent.findMany({ where: { etaDocument: { sourceId: inv2.id } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(events.map((e) => e.action), ["claim", "submit_rejected", "claim", "submit_ok"]);
});

test("an incomplete invoice is refused before anything is recorded or sent", async () => {
  const bare = await prisma.stockProduct.create({ data: { name: `${TAG} Okra` } });
  const draft = await prisma.salesInvoice.create({
    data: { customerId, buyerName: "x", gross: D(10), discountTotal: D(0), net: D(10), taxTotal: D(0), total: D(10), createdBy: "test", lines: { create: { lineNo: 1, productId: bare.id, description: "Okra", uomCode: "KG", quantity: D(1), unitPrice: D(10), taxCode: "EXEMPT", taxRate: D(0), gross: D(10), discount: D(0), net: D(10), tax: D(0), total: D(10) } } },
  });
  await issueInvoice(draft.id, {}, acct);
  const eta = fakeEta(() => accepted("x"));
  await assert.rejects(submitInvoiceToEta(draft.id, acct, eta.deps), (e: any) => e.status === 422 && /كود الصنف/.test(e.message));
  assert.equal(await prisma.etaDocument.count({ where: { sourceId: draft.id } }), 0);
  assert.equal(eta.state.submits + eta.state.signs, 0);
});

test("ETA state is permanent and the invoice and its accounting are untouched", async () => {
  const inv = await issuedInvoice();
  const before = { inv: await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } }), journals: await prisma.journalEntry.count({ where: { sourceId: inv.id } }) };
  await submitInvoiceToEta(inv.id, acct, fakeEta(() => accepted(inv.number!, `${TAG}-U4`)).deps);
  const after = { inv: await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } }), journals: await prisma.journalEntry.count({ where: { sourceId: inv.id } }) };
  assert.deepEqual(after, before);
  await assert.rejects(prisma.etaDocument.deleteMany({ where: { sourceId: inv.id } }), /permanent/);
  await assert.rejects(prisma.etaDocumentEvent.deleteMany({ where: { etaDocument: { sourceId: inv.id } } }));
  await assert.rejects(prisma.etaDocument.create({ data: { sourceType: "sales_invoice", sourceId: inv.id, internalId: inv.number!, documentType: "i", documentTypeVersion: "1.0" } }), /Unique constraint/);
});

// ---------------------------------------------------------------------------
// Credit notes: type "c", referencing the invoice's ETA UUID, only after ETA accepted it.
// ---------------------------------------------------------------------------

/** An invoice ETA has accepted (submitted, then refreshed to valid) with its UUID. */
async function acceptedInvoice(uuid: string, qty = 10) {
  const inv = await issuedInvoice(qty);
  await submitInvoiceToEta(inv.id, acct, fakeEta(() => accepted(inv.number!, uuid)).deps);
  await refreshInvoiceEta(inv.id, acct, fakeEta(() => accepted(inv.number!), "Valid").deps);
  return inv;
}
const creditOf = async (invoiceId: string, quantity: number) => {
  const line = await prisma.salesInvoiceLine.findFirstOrThrow({ where: { invoiceId } });
  return createCreditNote(invoiceId, { reason: `${TAG} مرتجع`, lines: [{ invoice_line_id: line.id, quantity }] }, acct);
};

test("a credit note waits until ETA accepted its invoice; then maps as type c with the reference", async () => {
  const inv = await issuedInvoice();
  const cn = await creditOf(inv.id, 2);
  const early = await etaCreditNoteState(cn.id, viewer);
  assert.equal(early.ready, false);
  assert.ok(early.issues.some((i) => i.field === "references"), JSON.stringify(early.issues));
  const eta = fakeEta(() => accepted(cn.number, `${TAG}-C0`));
  await assert.rejects(submitCreditNoteToEta(cn.id, acct, eta.deps), (e: any) => e.status === 422);
  assert.equal(eta.state.submits + eta.state.signs, 0, "nothing signed or sent before the invoice is accepted");
  assert.equal(await prisma.etaDocument.count({ where: { sourceType: "credit_note", sourceId: cn.id } }), 0);

  const ok = await acceptedInvoice(`${TAG}-INV-OK`);
  const cn2 = await creditOf(ok.id, 3);
  const s = await etaCreditNoteState(cn2.id, viewer);
  assert.equal(s.ready, true, JSON.stringify(s.issues));
  assert.equal(s.document.documentType, "c");
  assert.deepEqual(s.document.references, [`${TAG}-INV-OK`]);
  assert.equal(s.document.internalID, cn2.number);
  assert.equal(s.document.invoiceLines.length, 1);
  assert.equal(s.document.invoiceLines[0].quantity, 3);
  assert.equal(s.document.totalAmount, 150);
  await assert.rejects(submitCreditNoteToEta(cn2.id, viewer, eta.deps), (e: any) => e.status === 403);
});

test("a credit note reaches ETA once, refreshes and reconciles like an invoice", async () => {
  const inv = await acceptedInvoice(`${TAG}-INV-2`);
  const cn = await creditOf(inv.id, 10);
  const eta = fakeEta(() => accepted(cn.number, `${TAG}-C1`));
  const results = await Promise.all([1, 2, 3].map(() => submitCreditNoteToEta(cn.id, acct, eta.deps)));
  assert.equal(eta.state.submits, 1);
  assert.equal(results.filter((r) => r.submitted).length, 1);
  const doc = await prisma.etaDocument.findFirstOrThrow({ where: { sourceType: "credit_note", sourceId: cn.id } });
  assert.deepEqual([doc.documentType, doc.status, doc.uuid], ["c", "submitted", `${TAG}-C1`]);
  const r = await refreshCreditNoteEta(cn.id, acct, fakeEta(() => accepted(cn.number), "Valid").deps);
  assert.equal(r.status, "valid");
  // The invoice's own ETA document is untouched by its credit note's.
  assert.equal((await prisma.etaDocument.findFirstOrThrow({ where: { sourceType: "sales_invoice", sourceId: inv.id } })).uuid, `${TAG}-INV-2`);

  const inv3 = await acceptedInvoice(`${TAG}-INV-3`);
  const lostCn = await creditOf(inv3.id, 1);
  await assert.rejects(submitCreditNoteToEta(lostCn.id, acct, fakeEta(() => { throw new EtaTransportError("timeout", true); }).deps), (e: any) => e.status === 502);
  assert.equal((await prisma.etaDocument.findFirstOrThrow({ where: { sourceType: "credit_note", sourceId: lostCn.id } })).status, "unknown");
  const rec = await reconcileCreditNoteEta(lostCn.id, { uuid: `${TAG}-C-PORTAL` }, acct);
  assert.deepEqual([rec.status, rec.uuid], ["submitted", `${TAG}-C-PORTAL`]);
});
