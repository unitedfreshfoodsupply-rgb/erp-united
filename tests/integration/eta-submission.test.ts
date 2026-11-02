/* ETA submission against PostgreSQL with a fake ETA: one UNITED invoice can never create
   two ETA submissions — not on a double click, not on concurrent requests, not after a
   timeout whose outcome is unknown, not after a 422 DuplicateSubmission, not after a
   portal filing. An uncertain submission leaves `unknown` only through an ETA lookup (after
   the wait window) or a two-person decision with portal evidence. A remote document is
   accepted only if it is this UNITED document. A stored ETA UUID is never overwritten.
   The invoice, its numbering and its accounting are never touched by any of it. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor } from "./_db";
import { createCustomer } from "@/lib/sales/customers";
import { createCreditNote, issueInvoice } from "@/lib/sales/invoicing";
import { updateSetting } from "@/lib/core/settings-service";
import { EtaTransportError, type EtaGateway, type EtaRemoteDoc, type EtaSearchQuery, type EtaSigner, type EtaSubmissionState, type EtaSubmitResult } from "@/lib/eta/gateway";
import {
  ETA_LOOKUP_MIN_WAIT_MS, etaCreditNoteState, etaInvoiceState, etaPendingSubmissions, lookupInvoiceEta, reconcileCreditNoteEta, reconcileInvoiceEta,
  recordCreditNotePortalFiling, recordInvoicePortalFiling, refreshCreditNoteEta, refreshInvoiceEta, saveIssuerProfile, saveReceiverProfile, setItemCode, setUnitType,
  submitCreditNoteToEta, submitInvoiceToEta, type EtaDeps,
} from "@/lib/eta/service";

const TAG = `ZZETA${Date.now()}`; // 18 alphanumerics
let seq = 0;
/** An ETA-shaped document UUID (26 alphanumerics), unique per run. */
const uid = () => `${TAG}${String(++seq).padStart(8, "0")}`;
const acct = actor("محاسب", ["sales.invoices.manage", "sales.invoices.view", "sales.customers.manage", "accounting.eta.view", "accounting.eta.manage"], "ws4-acct-1");
const acct2 = actor("محاسب تاني", ["accounting.eta.view", "accounting.eta.manage"], "ws4-acct-2");
const viewer = actor("مشرف", ["accounting.eta.view"], "ws4-viewer");
const admin = actor("مدير", ["settings.manage"], null, "SUPER_ADMIN");
const D = (v: number) => new Prisma.Decimal(v);
let companyId = "";
let originalRegNo: string | null = null;
let originalProfile: Prisma.EtaIssuerProfileGetPayload<object> | null = null;
let customerId = "";
let productId = "";

/** What the fake ETA holds, by document UUID. */
const registry = new Map<string, { internalId: string | null; total: string | null }>();
const remote = (uuid: string, status = "Valid", over: Partial<EtaRemoteDoc> = {}): EtaRemoteDoc => {
  const r = registry.get(uuid);
  return { uuid, longId: "LONG-1", internalId: r?.internalId ?? null, status, total: r?.total ?? null, issuerId: null, submissionId: null, raw: { status, validationResults: { status } }, ...over };
};
const okSignatures = () => ({ ok: true as const, certificate: { subject: "CN=TEST", issuer: "CN=TEST", serialNumber: "01", fingerprint256: "AA", validFrom: "", validTo: "" } });

/** A fake ETA that counts submissions and answers as told. */
function fakeEta(
  answer: (n: number) => EtaSubmitResult | Promise<EtaSubmitResult>,
  remoteStatus = "Valid",
  opts: { search?: (q: EtaSearchQuery) => EtaRemoteDoc[]; submission?: (id: string) => EtaSubmissionState; realSignatureCheck?: boolean } = {}
) {
  const state = { submits: 0, signs: 0, searches: 0, sent: [] as string[], signedWith: [] as string[] };
  const signer: EtaSigner = { async sign(d, input) { state.signs++; state.signedWith.push(input?.serialized ?? ""); return { ...d, signatures: [{ signatureType: "I", value: "fake" }] }; } };
  const gateway: EtaGateway = {
    async submit(docs) { state.submits++; state.sent.push(...docs.map((d) => d.json)); await new Promise((r) => setTimeout(r, 30)); return answer(state.submits); },
    async getDocument(uuid) {
      if (!registry.has(uuid)) throw new EtaTransportError("not found", true, null, { httpStatus: 404 });
      return remote(uuid, remoteStatus);
    },
    async getSubmission(id) {
      if (opts.submission) return opts.submission(id);
      throw new EtaTransportError("not found", true, null, { httpStatus: 404 });
    },
    async searchDocuments(q) { state.searches++; return { documents: opts.search ? opts.search(q) : [], query: { internalID: q.internalId, submissionDateFrom: q.submittedFrom.toISOString() }, raw: {} }; },
  };
  return { state, deps: (): EtaDeps => ({ gateway, signer, ...(opts.realSignatureCheck ? {} : { checkSignatures: okSignatures }) }) };
}
const accepted = (internalId: string, uuid = `${TAG}-U`, total: string | null = null): EtaSubmitResult => {
  registry.set(uuid, { internalId, total });
  return { submissionId: `${TAG}-S`, accepted: [{ uuid, longId: "LONG-1", internalId, hashKey: "H" }], rejected: [], raw: { ok: true } };
};
const docOf = (sourceId: string) => prisma.etaDocument.findFirstOrThrow({ where: { sourceId } });
const eventsOf = async (sourceId: string) => (await prisma.etaDocumentEvent.findMany({ where: { etaDocument: { sourceId } }, orderBy: { createdAt: "asc" } })).map((e) => e.action);
/** Moves the attempt back in time, past (or within) the lookup wait window. */
const backdate = (sourceId: string, ms = ETA_LOOKUP_MIN_WAIT_MS + 60_000) => prisma.etaDocument.updateMany({ where: { sourceId }, data: { lastAttemptAt: new Date(Date.now() - ms) } });
const timeout = () => fakeEta(() => { throw new EtaTransportError("timeout", true); });

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
  // API submission is off by default; these tests open it from a date in the past.
  await updateSetting("accounting.eta_api_submission_from", "2000-01-01", admin, { reason: TAG });
});

after(async () => {
  // Leave the shared test database as it was for the other suites.
  await updateSetting("accounting.eta_api_submission_from", null, admin, { reason: TAG });
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
  assert.deepEqual([s.api.enabled, s.api.eligible], [true, true]);
  await assert.rejects(submitInvoiceToEta(inv.id, viewer, fakeEta(() => accepted(inv.number!)).deps), (e: any) => e.status === 403);
});

test("API submission is off until the go-live date is set, and never for documents dated before it", async () => {
  const inv = await issuedInvoice();
  const eta = fakeEta(() => accepted(inv.number!, uid()));
  try {
    await updateSetting("accounting.eta_api_submission_from", null, admin, { reason: TAG });
    await assert.rejects(submitInvoiceToEta(inv.id, acct, eta.deps), (e: any) => e.status === 503);
    await updateSetting("accounting.eta_api_submission_from", "2999-01-01", admin, { reason: TAG });
    await assert.rejects(submitInvoiceToEta(inv.id, acct, eta.deps), (e: any) => e.status === 409 && /يتسجل برقم البوابة/.test(e.message));
    assert.equal((await etaInvoiceState(inv.id, viewer)).api.eligible, false);
  } finally {
    await updateSetting("accounting.eta_api_submission_from", "2000-01-01", admin, { reason: TAG });
  }
  assert.equal(eta.state.submits + eta.state.signs, 0);
  assert.equal(await prisma.etaDocument.count({ where: { sourceId: inv.id } }), 0, "nothing recorded");
});

test("three simultaneous submits of one invoice reach ETA once; the signed text is kept before it is sent", async () => {
  const inv = await issuedInvoice();
  const eta = fakeEta(() => accepted(inv.number!, `${TAG}-U1`));
  const results = await Promise.all([1, 2, 3].map(() => submitInvoiceToEta(inv.id, acct, eta.deps)));
  assert.equal(eta.state.submits, 1);
  assert.equal(results.filter((r) => r.submitted).length, 1);
  const docs = await prisma.etaDocument.findMany({ where: { sourceType: "sales_invoice", sourceId: inv.id } });
  assert.equal(docs.length, 1);
  assert.deepEqual([docs[0].status, docs[0].uuid, docs[0].longId, docs[0].submissionId, docs[0].attempts, docs[0].origin], ["submitted", `${TAG}-U1`, "LONG-1", `${TAG}-S`, 1, "api"]);
  assert.ok(docs[0].submittedAt && docs[0].payloadHash && docs[0].documentHash && docs[0].lastAttemptAt);
  // ETA-12: the exact bytes sent are the stored signed payload; the hash signed is ETA's canonical one.
  assert.equal(docs[0].signedPayload, eta.state.sent[0]);
  assert.match(docs[0].signedPayload!, /"totalAmount":500\.00000/);
  assert.match(eta.state.signedWith[0], /^"ISSUER""TYPE""B"/);
  assert.deepEqual(await eventsOf(inv.id), ["claim", "signed", "response_received", "submit_ok"]);
  // Later clicks do nothing either.
  const again = await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(again.submitted, false);
  assert.equal(eta.state.submits, 1);
});

test("refresh records ETA's validation result (valid → acceptedAt) after checking the document is ours", async () => {
  const inv = await issuedInvoice();
  await submitInvoiceToEta(inv.id, acct, fakeEta(() => accepted(inv.number!, `${TAG}-U2`, "500")).deps);
  const r = await refreshInvoiceEta(inv.id, acct, fakeEta(() => accepted(inv.number!), "Valid").deps);
  assert.equal(r.status, "valid");
  assert.ok(r.acceptedAt);
});

test("refresh refuses a remote document that is not this invoice (internalID or total) and changes nothing (ETA-11)", async () => {
  const inv = await issuedInvoice();
  await submitInvoiceToEta(inv.id, acct, fakeEta(() => accepted(inv.number!, `${TAG}-U2X`)).deps);
  registry.set(`${TAG}-U2X`, { internalId: "INV-SOMEONE-ELSE", total: "500" });
  await assert.rejects(refreshInvoiceEta(inv.id, acct, fakeEta(() => accepted("x")).deps), (e: any) => e.status === 409 && /رقمه الداخلي/.test(e.message));
  registry.set(`${TAG}-U2X`, { internalId: inv.number!, total: "499.99" });
  await assert.rejects(refreshInvoiceEta(inv.id, acct, fakeEta(() => accepted("x")).deps), (e: any) => e.status === 409 && /إجمالي/.test(e.message));
  const doc = await docOf(inv.id);
  assert.equal(doc.status, "submitted");
  assert.deepEqual((await eventsOf(inv.id)).filter((a) => a === "refresh_mismatch").length, 2);
});

// Rewritten (ETA-01): this test used to assert that a bare "not received" claim made an
// unknown submission resendable. That path no longer exists: only an ETA lookup after the
// wait window, or a two-person decision, can conclude "not there".
test("a timeout after sending is 'unknown': never resent; a lookup too early changes nothing; after the wait an empty ETA search makes it safe", async () => {
  const inv = await issuedInvoice();
  await assert.rejects(submitInvoiceToEta(inv.id, acct, timeout().deps), (e: any) => e.status === 502);
  let doc = await docOf(inv.id);
  assert.equal(doc.status, "unknown");
  const retry = fakeEta(() => accepted(inv.number!, uid()));
  const r = await submitInvoiceToEta(inv.id, acct, retry.deps);
  assert.equal(r.submitted, false);
  assert.equal(retry.state.submits, 0, "an unknown outcome is never resent");

  // The old shortcut is gone: a single person's "not received" is not accepted.
  await assert.rejects(reconcileInvoiceEta(inv.id, { not_received: true, reason: "مش موجودة على البوابة" }, acct), (e: any) => e.status === 400);
  // Too early: ETA may still be processing; the lookup is recorded, nothing changes.
  await assert.rejects(lookupInvoiceEta(inv.id, acct, retry.deps), (e: any) => e.status === 409 && /بدري/.test(e.message));
  doc = await docOf(inv.id);
  assert.equal(doc.status, "unknown");
  assert.ok((await eventsOf(inv.id)).includes("lookup_absent_too_early"));
  await submitInvoiceToEta(inv.id, acct, retry.deps);
  assert.equal(retry.state.submits, 0);

  // After the wait window ETA's search (by internalID) shows nothing → failed, resendable.
  await backdate(inv.id);
  const found = await lookupInvoiceEta(inv.id, acct, retry.deps);
  assert.equal(found.status, "failed");
  assert.equal(retry.state.searches, 2);
  const ev = await prisma.etaDocumentEvent.findFirstOrThrow({ where: { etaDocument: { sourceId: inv.id }, action: "lookup_absent" } });
  assert.equal((ev.detail as any).search.query.internalID, inv.number, "the query is kept as evidence");
  await submitInvoiceToEta(inv.id, acct, retry.deps);
  assert.equal(retry.state.submits, 1);
  assert.equal((await docOf(inv.id)).attempts, 2);
  await assert.rejects(reconcileInvoiceEta(inv.id, { uuid: uid() }, acct), (e: any) => e.status === 409, "reconcile only for unknown states");
});

test("a lookup that finds the document at ETA records its UUID and status — never resent; a mismatch or two candidates are refused", async () => {
  const inv = await issuedInvoice();
  await assert.rejects(submitInvoiceToEta(inv.id, acct, timeout().deps), (e: any) => e.status === 502);
  await backdate(inv.id);
  const u = uid();
  registry.set(u, { internalId: inv.number!, total: "999" });
  // Wrong total: refused, recorded, unchanged.
  await assert.rejects(lookupInvoiceEta(inv.id, acct, fakeEta(() => accepted("x"), "Valid", { search: () => [remote(u, "Valid")] }).deps), (e: any) => e.status === 409);
  assert.equal((await docOf(inv.id)).status, "unknown");
  // Two documents with this internalID: a person decides.
  const u2 = uid();
  registry.set(u, { internalId: inv.number!, total: "500" });
  registry.set(u2, { internalId: inv.number!, total: "500" });
  await assert.rejects(lookupInvoiceEta(inv.id, acct, fakeEta(() => accepted("x"), "Valid", { search: () => [remote(u, "Valid"), remote(u2, "Invalid")] }).deps), (e: any) => e.status === 409 && /2/.test(e.message));
  // Exactly one, matching: registered.
  const eta = fakeEta(() => accepted(inv.number!, uid()), "Valid", { search: () => [remote(u, "Valid"), remote(u, "Valid")] });
  const r = await lookupInvoiceEta(inv.id, acct, eta.deps);
  assert.deepEqual([r.status, r.uuid], ["valid", u]);
  await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(eta.state.submits, 0);
  const actions = await eventsOf(inv.id);
  assert.ok(["lookup_mismatch", "lookup_ambiguous", "lookup_found"].every((a) => actions.includes(a)), actions.join());
});

test("a not-received decision needs two different people, the wait window, and portal evidence from both", async () => {
  const inv = await issuedInvoice();
  await assert.rejects(submitInvoiceToEta(inv.id, acct, timeout().deps), (e: any) => e.status === 502);
  const propose = { propose_not_received: true, reason: "مش ظاهرة في البحث على البوابة", portal_evidence: "بحث بالرقم الداخلي على البوابة 14:05 — صفر نتائج" };
  await assert.rejects(reconcileInvoiceEta(inv.id, propose, acct), (e: any) => e.status === 409, "not before the wait window");
  await backdate(inv.id);
  await assert.rejects(reconcileInvoiceEta(inv.id, propose, viewer), (e: any) => e.status === 403);
  await assert.rejects(reconcileInvoiceEta(inv.id, { ...propose, portal_evidence: "x" }, acct), (e: any) => e.status === 400, "evidence is required");
  const p = (await reconcileInvoiceEta(inv.id, propose, acct)) as unknown as { status: string; proposalId: string };
  assert.equal(p.status, "unknown", "a proposal alone changes nothing");
  const state = await etaInvoiceState(inv.id, viewer);
  assert.equal(state.eta?.pendingProposal?.id, p.proposalId);
  const eta = fakeEta(() => accepted(inv.number!, uid()));
  await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(eta.state.submits, 0, "still not resendable");

  const confirm = { confirm_not_received: p.proposalId, portal_evidence: "راجعت البوابة تاني 14:20 — مفيش مستند بالرقم ده" };
  await assert.rejects(reconcileInvoiceEta(inv.id, confirm, acct), (e: any) => e.status === 403 && /شخص تاني/.test(e.message), "no self-confirmation");
  const done = await reconcileInvoiceEta(inv.id, confirm, acct2);
  assert.equal(done.status, "failed");
  const ev = await prisma.etaDocumentEvent.findFirstOrThrow({ where: { etaDocument: { sourceId: inv.id }, action: "not_received_confirmed" } });
  assert.deepEqual([ev.actorId, (ev.detail as any).proposedBy.id], ["ws4-acct-2", "ws4-acct-1"]);
  assert.ok((ev.detail as any).proposerEvidence && (ev.detail as any).confirmerEvidence);
  // The proposal cannot be used twice.
  await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(eta.state.submits, 1);
  await assert.rejects(reconcileInvoiceEta(inv.id, confirm, acct2), (e: any) => e.status === 409);
});

test("a 422 DuplicateSubmission is 'unknown', never a rejection; it is not resent (ETA-02)", async () => {
  const inv = await issuedInvoice();
  const dup = fakeEta(() => { throw new EtaTransportError("dup", true, { error: { code: "DuplicateSubmission" } }, { httpStatus: 422, code: "DuplicateSubmission", retryAfter: 600 }); });
  await assert.rejects(submitInvoiceToEta(inv.id, acct, dup.deps), (e: any) => e.status === 502);
  const doc = await docOf(inv.id);
  assert.equal(doc.status, "unknown");
  assert.equal((doc.lastError as any).code, "DuplicateSubmission");
  await submitInvoiceToEta(inv.id, acct, dup.deps);
  assert.equal(dup.state.submits, 1);
});

test("a signing failure, or a signature that fails the checks, never reached ETA: 'failed', safe to retry; a submission rejection may be resent", async () => {
  const inv = await issuedInvoice();
  const eta = fakeEta(() => accepted(inv.number!));
  const broken: EtaDeps = { gateway: eta.deps().gateway, signer: { async sign() { throw new EtaTransportError("token not inserted", false); } } };
  await assert.rejects(submitInvoiceToEta(inv.id, acct, () => broken), (e: any) => e.status === 502);
  assert.equal((await docOf(inv.id)).status, "failed");
  assert.equal(eta.state.submits, 0);
  // The bridge answers, but not with a CAdES signature over this document: checked before sending.
  const fake = fakeEta(() => accepted(inv.number!, uid()), "Valid", { realSignatureCheck: true });
  await assert.rejects(submitInvoiceToEta(inv.id, acct, fake.deps), (e: any) => e.status === 502 && /التوقيع/.test(e.message));
  assert.equal(fake.state.submits, 0, "nothing sent with a bad signature");
  assert.equal((await docOf(inv.id)).status, "failed");

  const inv2 = await issuedInvoice();
  const rejecting = fakeEta((n) => (n === 1 ? { submissionId: null, accepted: [], rejected: [{ internalId: inv2.number!, error: { message: "bad receiver" } }], raw: {} } : accepted(inv2.number!, `${TAG}-U3`)));
  const r1 = await submitInvoiceToEta(inv2.id, acct, rejecting.deps);
  assert.equal(r1.eta.status, "rejected");
  assert.deepEqual(r1.eta.lastError, { message: "bad receiver" });
  const r2 = await submitInvoiceToEta(inv2.id, acct, rejecting.deps);
  assert.equal(r2.eta.status, "submitted");
  assert.deepEqual(await eventsOf(inv2.id), ["claim", "signed", "response_received", "submit_rejected", "claim", "signed", "response_received", "submit_ok"]);
});

test("a registered document the receiver rejected is 'receiver_rejected': kept with its UUID, never resent (ETA-03)", async () => {
  const inv = await issuedInvoice();
  const eta = fakeEta(() => accepted(inv.number!, `${TAG}-U5`));
  await submitInvoiceToEta(inv.id, acct, eta.deps);
  const r = await refreshInvoiceEta(inv.id, acct, fakeEta(() => accepted("x"), "Rejected").deps);
  assert.deepEqual([r.status, r.uuid], ["receiver_rejected", `${TAG}-U5`]);
  const again = await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(again.submitted, false);
  assert.equal(eta.state.submits, 1);
  // The database itself refuses to overwrite or erase a stored UUID.
  await assert.rejects(prisma.etaDocument.update({ where: { id: r.id }, data: { uuid: uid() } }), /permanent/);
  await assert.rejects(prisma.etaDocument.update({ where: { id: r.id }, data: { uuid: null } }), /permanent/);
});

test("a resend after 'invalid' keeps the old UUID in the document's history (never overwritten)", async () => {
  const inv = await issuedInvoice();
  const eta = fakeEta((n) => accepted(inv.number!, `${TAG}-U6-${n}`));
  await submitInvoiceToEta(inv.id, acct, eta.deps);
  await refreshInvoiceEta(inv.id, acct, fakeEta(() => accepted("x"), "Invalid").deps);
  assert.equal((await docOf(inv.id)).status, "invalid");
  const r = await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(r.submitted, true);
  const doc = await docOf(inv.id);
  assert.deepEqual([doc.uuid, doc.priorUuids, doc.attempts], [`${TAG}-U6-2`, [`${TAG}-U6-1`], 2]);
  await assert.rejects(prisma.etaDocument.update({ where: { id: doc.id }, data: { priorUuids: [] } }), /append-only/);
});

test("ETA's answer is stored before the status: when the status cannot be recorded the document is 'unknown' with the answer kept; a lookup by submission UUID recovers (ETA-12)", async () => {
  // The answer names no document of ours → unknown, but the submission UUID is kept.
  const inv = await issuedInvoice();
  const u = uid();
  const odd = fakeEta(() => ({ submissionId: `${TAG}-S-ODD`, accepted: [], rejected: [], raw: { submissionUUID: `${TAG}-S-ODD` } }));
  await submitInvoiceToEta(inv.id, acct, odd.deps);
  let doc = await docOf(inv.id);
  assert.deepEqual([doc.status, doc.submissionId], ["unknown", `${TAG}-S-ODD`]);
  // Get Submission (by that UUID) finds it: no wait needed for a positive answer.
  registry.set(u, { internalId: inv.number!, total: "500" });
  const rec = fakeEta(() => accepted("x"), "Valid", { submission: (id) => ({ submissionId: id, overallStatus: "Valid", documents: [remote(u, "Valid", { submissionId: id })], raw: {} }) });
  const r = await lookupInvoiceEta(inv.id, acct, rec.deps);
  assert.deepEqual([r.status, r.uuid, r.submissionId], ["valid", u, `${TAG}-S-ODD`]);
  assert.equal(rec.state.searches, 0, "found by the submission UUID, no search needed");

  // ETA accepted, but the status write fails (the UUID is already linked to another document).
  const inv2 = await issuedInvoice();
  const clash = fakeEta(() => accepted(inv2.number!, u));
  await assert.rejects(submitInvoiceToEta(inv2.id, acct, clash.deps), (e: any) => e.status === 502 && /ماتسجلش/.test(e.message));
  doc = await docOf(inv2.id);
  assert.equal(doc.status, "unknown");
  assert.equal(doc.uuid, null);
  assert.equal((doc.lastResponse as any).ok, true, "ETA's answer is kept");
  assert.ok(doc.signedPayload);
  assert.deepEqual(await eventsOf(inv2.id), ["claim", "signed", "response_received", "submit_unknown"]);
  await submitInvoiceToEta(inv2.id, acct, clash.deps);
  assert.equal(clash.state.submits, 1, "never resent");
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
// Portal filings (ETA-14 / ETA-13) and the pending list (ETA-15)
// ---------------------------------------------------------------------------

test("a portal-filed invoice is recorded with its UUID, is never sent by the API, and its credit note can reference it", async () => {
  const inv = await issuedInvoice();
  const u = uid();
  const filing = { uuid: u, submitted_at: "2026-11-01T10:00:00Z", evidence_note: "مرفوعة على بوابة الضرائب يدوي — لقطة الشاشة في ملف الشهر" };
  await assert.rejects(recordInvoicePortalFiling(inv.id, filing, viewer), (e: any) => e.status === 403);
  await assert.rejects(recordInvoicePortalFiling(inv.id, { ...filing, uuid: "too-short" }, acct), (e: any) => e.status === 400);
  await assert.rejects(recordInvoicePortalFiling(inv.id, { ...filing, evidence_note: "" }, acct), (e: any) => e.status === 400);
  await assert.rejects(recordInvoicePortalFiling(inv.id, { ...filing, submitted_at: "2999-01-01T00:00:00Z" }, acct), (e: any) => e.status === 400);
  const r = await recordInvoicePortalFiling(inv.id, filing, acct);
  assert.deepEqual([r.status, r.origin, r.uuid, r.attempts], ["valid", "portal", u, 0]);
  const eta = fakeEta(() => accepted(inv.number!, uid()));
  const s = await submitInvoiceToEta(inv.id, acct, eta.deps);
  assert.equal(s.submitted, false);
  assert.equal(eta.state.submits + eta.state.signs, 0, "a portal filing is never sent by the API");
  await assert.rejects(recordInvoicePortalFiling(inv.id, { ...filing, uuid: uid() }, acct), (e: any) => e.status === 409, "recorded once");
  const state = await etaInvoiceState(inv.id, viewer);
  assert.deepEqual([state.eta?.resendable, state.eta?.statusLabel], [false, "مسجلة من بوابة الضرائب"]);
  // The same UUID cannot be recorded for another document.
  const other = await issuedInvoice();
  await assert.rejects(recordInvoicePortalFiling(other.id, filing, acct), (e: any) => e.status === 409 && /UUID/.test(e.message));
  // The database refuses to turn a portal filing into an API document.
  await assert.rejects(prisma.etaDocument.update({ where: { id: r.id }, data: { origin: "api" } }), /portal/);

  // Its credit note references the portal UUID and goes through the API (or the portal too).
  const line = await prisma.salesInvoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } });
  const cn = await createCreditNote(inv.id, { reason: `${TAG} مرتجع`, lines: [{ invoice_line_id: line.id, quantity: 1 }] }, acct);
  const cs = await etaCreditNoteState(cn.id, viewer);
  assert.equal(cs.ready, true, JSON.stringify(cs.issues));
  assert.deepEqual(cs.document.references, [u]);
  const cn2 = await createCreditNote(inv.id, { reason: `${TAG} مرتجع 2`, lines: [{ invoice_line_id: line.id, quantity: 1 }] }, acct);
  const cr = await recordCreditNotePortalFiling(cn2.id, { ...filing, uuid: uid() }, acct);
  assert.deepEqual([cr.status, cr.origin, cr.documentType], ["valid", "portal", "c"]);
});

test("a document whose ETA state is uncertain cannot be recorded as a portal filing (use the lookup)", async () => {
  const inv = await issuedInvoice();
  await assert.rejects(submitInvoiceToEta(inv.id, acct, timeout().deps), (e: any) => e.status === 502);
  await assert.rejects(recordInvoicePortalFiling(inv.id, { uuid: uid(), submitted_at: "2026-11-01T10:00:00Z", evidence_note: "مرفوعة على البوابة يدوي" }, acct), (e: any) => e.status === 409);
});

test("the pending list shows issued documents not registered at ETA, oldest first, with their age; read only", async () => {
  const waiting = await issuedInvoice();
  const done = await issuedInvoice();
  await recordInvoicePortalFiling(done.id, { uuid: uid(), submitted_at: "2026-11-01T10:00:00Z", evidence_note: "مرفوعة على البوابة يدوي" }, acct);
  const p = await etaPendingSubmissions(viewer);
  const row = p.rows.find((r) => r.id === waiting.id);
  assert.ok(row, "the unsent invoice is listed");
  // An issued invoice is immutable, so its age is measured from its real issue time.
  const age = Math.floor((Date.now() - waiting.issuedAt!.getTime()) / 3_600_000);
  assert.deepEqual([row!.kind, row!.etaStatus, row!.ageHours, row!.apiEligible, row!.number], ["sales_invoice", null, age, true, waiting.number]);
  const unknownOne = p.rows.find((r) => r.etaStatus === "unknown");
  assert.ok(unknownOne, "an uncertain submission stays on the list until resolved");
  assert.equal(p.rows.some((r) => r.id === done.id), false, "a registered one is not");
  const ages = p.rows.map((r) => r.ageHours ?? 0);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
  await assert.rejects(etaPendingSubmissions(actor("x", [])), (e: any) => e.status === 403);
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

test("a credit note reaches ETA once, refreshes, and reconciles only with a UUID ETA confirms is this credit note", async () => {
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
  await assert.rejects(submitCreditNoteToEta(lostCn.id, acct, timeout().deps), (e: any) => e.status === 502);
  assert.equal((await prisma.etaDocument.findFirstOrThrow({ where: { sourceType: "credit_note", sourceId: lostCn.id } })).status, "unknown");
  // A UUID ETA does not know, or one that is another document, is refused (ETA-11).
  const unknownUuid = uid();
  await assert.rejects(reconcileCreditNoteEta(lostCn.id, { uuid: unknownUuid }, acct, fakeEta(() => accepted("x")).deps), (e: any) => e.status === 502);
  const someoneElse = uid();
  registry.set(someoneElse, { internalId: inv3.number!, total: "50" });
  await assert.rejects(reconcileCreditNoteEta(lostCn.id, { uuid: someoneElse }, acct, fakeEta(() => accepted("x")).deps), (e: any) => e.status === 409);
  const portal = uid();
  registry.set(portal, { internalId: lostCn.number, total: "50" });
  const rec = await reconcileCreditNoteEta(lostCn.id, { uuid: portal }, acct, fakeEta(() => accepted("x"), "Valid").deps);
  assert.deepEqual([rec.status, rec.uuid], ["valid", portal]);
});
