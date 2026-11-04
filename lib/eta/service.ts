import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { getSetting } from "@/lib/core/settings-service";
import { optText, parse } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { etaConfigStatus, loadEtaConfig } from "./config";
import { EtaTransportError, externalSigner, sharedHttpGateway, type EtaGateway, type EtaRemoteDoc, type EtaSigner, type EtaSubmitResult } from "./gateway";
import { ETA_DOCUMENT_VERSION } from "./mapper";
import { canonicalSerialize, etaJson, sha256Hex } from "./serialize";
import { checkEtaSignatures, type SignatureCheck } from "./signature";
import { hasBlockingIssues, validateEtaSource } from "./validate";
import { receiverGaps, resolveEtaReceiver } from "./receiver";
import type { AddressSource, EtaSource, EtaStatus } from "./types";

/**
 * ETA submission of UNITED invoices and of the credit notes against them. The document
 * itself is only read; everything ETA returns is kept on EtaDocument (one per invoice or
 * credit note) with an append-only event history. A credit note references its invoice's
 * ETA UUID, so it can only go once ETA has accepted that invoice (through the API or
 * recorded from the portal).
 *
 * Never twice:
 *   - the claim (status → submitting) happens under a lock in its own transaction BEFORE
 *     any network call;
 *   - only a state that proves nothing is registered at ETA may be sent again (pending,
 *     failed, rejected-at-submission), plus `invalid` for an API document — its UUID is kept
 *     in priorUuids (DB-enforced: a stored UUID is never overwritten);
 *   - `submitting` (stale) and `unknown` leave only through an ETA lookup (Get Submission /
 *     Search Documents by internalID) or a two-person decision with portal evidence, both
 *     after a wait window longer than ETA's 10-minute duplicate window;
 *   - a document filed on the ETA portal is recorded with its UUID and never sent by the API;
 *   - API submission is off until `accounting.eta_api_submission_from` is set, and never
 *     applies to documents dated before it.
 */

export type EtaDeps = {
  gateway: EtaGateway;
  signer: EtaSigner;
  /** Checks the bridge's answer against the canonical form (default: lib/eta/signature). */
  checkSignatures?: (signatures: unknown, serialized: string) => SignatureCheck;
};

export function defaultEtaDeps(): EtaDeps {
  const c = loadEtaConfig(); // 503 when the server is not configured or inconsistent
  return { gateway: sharedHttpGateway(c), signer: externalSigner(c), checkSignatures: (s, ser) => checkEtaSignatures(s, ser, { certSha256: c.signerCertSha256 }) };
}

/** Longer than ETA's 10-minute duplicate window; also lets validation and search catch up. */
export const ETA_LOOKUP_MIN_WAIT_MS = 15 * 60_000;
/** A `submitting` claim this old belongs to a process that died. */
const STALE_CLAIM_MS = 5 * 60_000;
/** Nothing is registered at ETA in these states. */
const NOTHING_REGISTERED: readonly EtaStatus[] = ["pending", "failed", "rejected"];
/** ETA document UUID (26 alphanumerics, as the submission UUID — ⚠ confirm in pre-production). */
const ETA_UUID = /^[A-Za-z0-9]{26}$/;

const STATUS_LABEL: Record<EtaStatus, string> = {
  pending: "لسه ما اتبعتتش",
  submitting: "جاري الإرسال",
  submitted: "اتبعتت — مستنية التحقق",
  valid: "مقبولة",
  invalid: "مرفوضة بعد التحقق",
  rejected: "اترفضت عند الإرسال — مااتسجلتش",
  failed: "الإرسال فشل قبل ما يوصل",
  unknown: "مش معروف وصلت ولا لأ — لازم مراجعة",
  cancelled: "ملغية",
  receiver_rejected: "العميل رفضها بعد تسجيلها",
};
const PORTAL_LABEL = "مسجلة من بوابة الضرائب";

type Doc = Prisma.EtaDocumentGetPayload<object>;
const resendable = (d: Pick<Doc, "status" | "origin"> | null) => !d || (d.origin !== "portal" && (NOTHING_REGISTERED.includes(d.status as EtaStatus) || d.status === "invalid"));
const uncertain = (d: Pick<Doc, "status" | "updatedAt">) => d.status === "unknown" || (d.status === "submitting" && Date.now() - d.updatedAt.getTime() > STALE_CLAIM_MS);
const attemptAt = (d: Pick<Doc, "lastAttemptAt" | "updatedAt">) => d.lastAttemptAt ?? d.updatedAt;
const statusLabel = (d: Pick<Doc, "status" | "origin">) => (d.origin === "portal" && d.status === "valid" ? PORTAL_LABEL : STATUS_LABEL[d.status as EtaStatus] ?? d.status);

const SOURCE = "sales_invoice";
type EtaKind = "sales_invoice" | "credit_note";
const loadSource = (db: Tx | typeof prisma, kind: EtaKind, id: string) => (kind === "credit_note" ? loadEtaCreditNoteSource(db, id) : loadEtaSource(db, id));
const addr = (a: Partial<Record<keyof AddressSource, string | null>> | null): AddressSource => ({
  country: a?.country ?? null, governate: a?.governate ?? null, regionCity: a?.regionCity ?? null, street: a?.street ?? null,
  buildingNumber: a?.buildingNumber ?? null, postalCode: a?.postalCode ?? null, floor: a?.floor ?? null, room: a?.room ?? null,
  landmark: a?.landmark ?? null, additionalInformation: a?.additionalInformation ?? null,
});
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

// ---------------------------------------------------------------------------
// Reading UNITED's data (no writes)
// ---------------------------------------------------------------------------

export async function loadEtaSource(db: Tx | typeof prisma, invoiceId: string): Promise<EtaSource> {
  const inv = await db.salesInvoice.findUnique({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: "asc" } }, order: { select: { orderNumber: true } }, customer: { include: { legalEntity: true } } } });
  if (!inv) throw new ApiError(404, "الفاتورة مش موجودة");
  const company = await db.company.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" }, include: { etaIssuerProfile: true } });
  const legacy = await db.etaReceiverProfile.findUnique({ where: { customerId: inv.customerId } });
  // Receiver identity from the canonical customer record (lib/eta/receiver.ts): the ACTIVE
  // linked legal entity; the retired EtaReceiverProfile only when there is none.
  const r = resolveEtaReceiver({ customer: { taxRegistrationNo: inv.customer?.taxRegistrationNo ?? null }, legalEntity: inv.customer?.legalEntity ?? null, legacyProfile: legacy });
  const receiver = { type: r.type, personalId: r.personalId, address: r.address };
  const productIds = [...new Set(inv.lines.map((l) => l.productId).filter((x): x is string => !!x))];
  const [products, codes, units, taxes] = await Promise.all([
    db.stockProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } }),
    db.etaItemCode.findMany({ where: { productId: { in: productIds } } }),
    db.etaUnitType.findMany({ where: { uomCode: { in: [...new Set(inv.lines.map((l) => l.uomCode))] } } }),
    db.taxRate.findMany({ where: { code: { in: [...new Set(inv.lines.map((l) => l.taxCode))] } } }),
  ]);
  const ip = company?.etaIssuerProfile ?? null;
  return {
    kind: "sales_invoice",
    invoice: {
      id: inv.id, number: inv.number, status: inv.status, issuedAt: inv.issuedAt?.toISOString() ?? null, issueDate: inv.issueDate ?? null, currencyCode: inv.currencyCode,
      buyerName: inv.buyerName, buyerTaxId: inv.buyerTaxId,
      gross: inv.gross.toString(), discountTotal: inv.discountTotal.toString(), net: inv.net.toString(), taxTotal: inv.taxTotal.toString(), total: inv.total.toString(),
      orderNumber: inv.order?.orderNumber ?? null,
    },
    issuer: {
      name: company?.legalName ?? null,
      registrationNumber: company?.taxRegistrationNumber ?? null,
      etaBranchId: ip?.etaBranchId ?? null,
      activityCode: ip?.activityCode ?? null,
      address: addr(ip),
    },
    receiver,
    lines: inv.lines.map((l) => {
      const code = codes.find((c) => c.productId === l.productId);
      const tax = taxes.find((t) => t.code === l.taxCode);
      const product = products.find((p) => p.id === l.productId);
      return {
        lineNo: l.lineNo, description: l.description, productId: l.productId,
        // The taxpayer's own item code: the product's SKU, else its permanent id.
        internalCode: product ? product.sku ?? product.id : null,
        itemType: code?.itemType ?? null, itemCode: code?.itemCode ?? null,
        uomCode: l.uomCode, etaUnitType: units.find((u) => u.uomCode === l.uomCode)?.etaUnitType ?? null,
        quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), discountPct: l.discountPct.toString(),
        gross: l.gross.toString(), discount: l.discount.toString(), net: l.net.toString(),
        taxCode: l.taxCode, taxRate: l.taxRate.toString(), etaTaxType: tax?.etaType ?? null, etaTaxSubtype: tax?.etaSubtype ?? null,
        tax: l.tax.toString(), total: l.total.toString(),
      };
    }),
    personIdThreshold: Number(await getSetting("sales.eta_person_id_threshold")),
  };
}

/**
 * A credit note as ETA sees it: the invoice's issuer and receiver, the credited quantities
 * and amounts per line (each line keeps its invoice line's product, unit, price and tax),
 * and a reference to the invoice's ETA UUID once ETA accepted it (API or portal filing).
 */
export async function loadEtaCreditNoteSource(db: Tx | typeof prisma, creditNoteId: string): Promise<EtaSource> {
  const cn = await db.creditNote.findUnique({ where: { id: creditNoteId }, include: { lines: true } });
  if (!cn) throw new ApiError(404, "الإشعار الدائن مش موجود");
  const inv = await loadEtaSource(db, cn.invoiceId);
  const original = await db.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: SOURCE, sourceId: cn.invoiceId } }, select: { status: true, uuid: true } });
  const invoiceLines = await db.salesInvoiceLine.findMany({ where: { id: { in: cn.lines.map((l) => l.invoiceLineId) } }, select: { id: true, lineNo: true } });
  const lineNoOf = new Map(invoiceLines.map((l) => [l.id, l.lineNo]));
  const lines = cn.lines
    .map((l) => {
      const src = inv.lines.find((x) => x.lineNo === lineNoOf.get(l.invoiceLineId));
      if (!src) throw new ApiError(409, "سطر الإشعار مش لاقي سطر الفاتورة بتاعه");
      return { ...src, quantity: l.quantity.toString(), gross: l.gross.toString(), discount: l.discount.toString(), net: l.net.toString(), tax: l.tax.toString(), total: l.total.toString() };
    })
    .sort((a, b) => a.lineNo - b.lineNo);
  return {
    ...inv,
    kind: "credit_note",
    references: original?.status === "valid" && original.uuid ? [original.uuid] : [],
    invoice: {
      ...inv.invoice,
      id: cn.id, number: cn.number, status: "issued", issuedAt: cn.createdAt.toISOString(), issueDate: cn.issueDate, currencyCode: cn.currencyCode,
      gross: cn.gross.toString(), discountTotal: cn.discountTotal.toString(), net: cn.net.toString(), taxTotal: cn.taxTotal.toString(), total: cn.total.toString(),
      orderNumber: null,
    },
    lines,
  };
}

type DocWithEvents = Prisma.EtaDocumentGetPayload<{ include: { events: true } }>;

/** The open "not received" proposal waiting for a second person, if any. */
function openProposal(d: DocWithEvents) {
  if (!uncertain(d)) return null;
  const p = [...d.events].reverse().find((e) => e.action === "not_received_proposed");
  const detail = (p?.detail ?? {}) as { docVersion?: number; reason?: string; portalEvidence?: string };
  if (!p || detail.docVersion !== d.version) return null;
  return { id: p.id, actorId: p.actorId, actorName: p.actorName, createdAt: p.createdAt, reason: detail.reason ?? null, portalEvidence: detail.portalEvidence ?? null };
}

const present = (d: DocWithEvents | null) =>
  d && {
    id: d.id, internalId: d.internalId, documentType: d.documentType, documentTypeVersion: d.documentTypeVersion,
    status: d.status, statusLabel: statusLabel(d), origin: d.origin,
    submissionId: d.submissionId, uuid: d.uuid, longId: d.longId, priorUuids: d.priorUuids, attempts: d.attempts,
    documentHash: d.documentHash, payloadHash: d.payloadHash, lastAttemptAt: d.lastAttemptAt,
    submittedAt: d.submittedAt, acceptedAt: d.acceptedAt, rejectedAt: d.rejectedAt, cancelledAt: d.cancelledAt,
    lastError: d.lastError, lastResponse: d.lastResponse, updatedAt: d.updatedAt,
    resendable: resendable(d), uncertain: uncertain(d),
    /** Earliest moment an ETA lookup may conclude "not there", or a not-received decision be taken. */
    decisionOpensAt: uncertain(d) ? new Date(attemptAt(d).getTime() + ETA_LOOKUP_MIN_WAIT_MS) : null,
    pendingProposal: openProposal(d),
    events: d.events.map((e) => ({ id: e.id, action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, actorName: e.actorName, createdAt: e.createdAt, detail: e.detail })),
  };

/** API submission window: the go-live date setting (empty = API off). */
async function apiWindow() {
  const from = String((await getSetting("accounting.eta_api_submission_from")) ?? "").trim();
  return { enabled: from !== "", from: from || null };
}
const documentDate = (src: EtaSource) => src.invoice.issueDate ?? src.invoice.issuedAt?.slice(0, 10) ?? null;
const apiEligible = (w: { from: string | null }, date: string | null) => !!w.from && !!date && date >= w.from;

async function etaState(kind: EtaKind, id: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.view");
  const src = await loadSource(prisma, kind, id);
  const { issues, document } = validateEtaSource(src);
  const doc = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } }, include: { events: { orderBy: { createdAt: "asc" } } } });
  const w = await apiWindow();
  // Once a document has been signed for ETA, that signed payload is the legal record: show it
  // as stored, never rebuilt from today's customer data. The live build stays only for a draft.
  // The stored payload is the same ETA document shape as the live build, plus its signatures.
  const signed = signedDocument(doc?.signedPayload ?? null) as typeof document | null;
  // Receiver gaps are fixed in the customer record, never on this screen.
  const customerId = kind === "credit_note"
    ? (await prisma.creditNote.findUnique({ where: { id }, select: { invoice: { select: { customerId: true } } } }))?.invoice.customerId
    : (await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true } }))?.customerId;
  return {
    number: src.invoice.number, ready: !hasBlockingIssues(issues), issues,
    receiverEditHref: customerId ? `/sales/customers/${customerId}?tab=overview#eta-identity` : null,
    document: signed ?? document, documentSource: signed ? ("signed" as const) : ("draft" as const),
    eta: present(doc), api: { ...w, eligible: apiEligible(w, documentDate(src)) },
  };
}

function signedDocument(json: string | null): unknown | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { documents?: unknown[] };
    return Array.isArray(parsed?.documents) && parsed.documents.length === 1 ? parsed.documents[0] : parsed;
  } catch {
    return null;
  }
}

/** Readiness + current ETA state of one invoice (finance view). */
export async function etaInvoiceState(invoiceId: string, actor: ServiceActor) {
  return { invoiceId, ...(await etaState("sales_invoice", invoiceId, actor)) };
}

/** Readiness + current ETA state of one credit note. */
export async function etaCreditNoteState(creditNoteId: string, actor: ServiceActor) {
  return { creditNoteId, ...(await etaState("credit_note", creditNoteId, actor)) };
}

/** What the customer-facing invoice may show: identifiers and status, never errors. */
export async function etaPublicState(invoiceId: string) {
  const d = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: SOURCE, sourceId: invoiceId } }, select: { status: true, origin: true, uuid: true, longId: true, submittedAt: true, acceptedAt: true } });
  return d && { status: d.status, statusLabel: statusLabel(d), uuid: d.uuid, longId: d.longId, submittedAt: d.submittedAt, acceptedAt: d.acceptedAt };
}

// ---------------------------------------------------------------------------
// State changes: every one is an event (append-only) and an audit row
// ---------------------------------------------------------------------------

const json = (v: unknown) => (v ?? undefined) as Prisma.InputJsonValue;

async function transition(tx: Tx, doc: Doc, to: EtaStatus, data: Prisma.EtaDocumentUpdateInput, action: string, detail: unknown, actor: ServiceActor) {
  const updated = await tx.etaDocument.update({ where: { id: doc.id }, data: { ...data, status: to, version: { increment: 1 } } });
  await tx.etaDocumentEvent.create({ data: { etaDocumentId: doc.id, action, fromStatus: doc.status, toStatus: to, detail: json(detail), actorId: actor.id, actorName: actor.name } });
  await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: `eta_${action}`, entityType: "eta_document", entityId: doc.id, fieldChanged: "status", oldValue: doc.status, newValue: `${to} · ${doc.internalId}`, source: "user", deviceId: actor.deviceId }, tx);
  return updated;
}

/** An event that changes no status (evidence: a lookup, a proposal, a mismatch). */
async function note(tx: Tx, doc: Doc, action: string, detail: unknown, actor: ServiceActor) {
  const ev = await tx.etaDocumentEvent.create({ data: { etaDocumentId: doc.id, action, fromStatus: doc.status, toStatus: doc.status, detail: json(detail), actorId: actor.id, actorName: actor.name } });
  await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: `eta_${action}`, entityType: "eta_document", entityId: doc.id, fieldChanged: "event", newValue: `${action} · ${doc.internalId}`, source: "user", deviceId: actor.deviceId }, tx);
  return ev;
}

const lockKey = (kind: EtaKind, id: string) => `eta:${kind}:${id}`;
const getDoc = (tx: Tx, kind: EtaKind, id: string) => tx.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } } });

/** A refusal decided inside a transaction whose evidence must still be committed. */
type Outcome = { eta: Doc } | { refuse: number; message: string };
const settle = (o: Outcome) => {
  if ("refuse" in o) throw new ApiError(o.refuse, o.message);
  return o.eta;
};

/** ETA's remote status → local. A receiver's rejection of a registered document is never a submission rejection. */
const REMOTE_STATUS: Record<string, EtaStatus> = { valid: "valid", invalid: "invalid", rejected: "receiver_rejected", cancelled: "cancelled", submitted: "submitted" };
const fromRemote = (s: string): EtaStatus | null => REMOTE_STATUS[s.trim().toLowerCase()] ?? null;

function remoteData(to: EtaStatus, remote: EtaRemoteDoc, cur: Doc): Prisma.EtaDocumentUpdateInput {
  const now = new Date();
  return {
    longId: remote.longId ?? cur.longId,
    lastResponse: json(remote.raw),
    ...(to === "valid" ? { acceptedAt: cur.acceptedAt ?? now, lastError: Prisma.DbNull } : {}),
    ...(to === "invalid" || to === "receiver_rejected" ? { rejectedAt: now, lastError: json((remote.raw as { validationResults?: unknown } | null)?.validationResults ?? remote.raw) } : {}),
    ...(to === "cancelled" ? { cancelledAt: now } : {}),
  };
}

/**
 * The remote document must be this UNITED document (ETA-11): same internalID, same total
 * (when ETA returns it), same issuer (when ETA returns it). Anything else is refused.
 */
function crossCheck(remote: EtaRemoteDoc, expect: { internalId: string; total: string; issuerId: string | null }): string[] {
  const problems: string[] = [];
  if (!remote.internalId) problems.push("المنظومة مارجّعتش الرقم الداخلي للمستند — مينفعش نتأكد إنه بتاعنا");
  else if (remote.internalId !== expect.internalId) problems.push(`المستند في المنظومة رقمه الداخلي ${remote.internalId} مش ${expect.internalId}`);
  if (remote.total !== null) {
    let same = false;
    try {
      same = D(remote.total).toDecimalPlaces(5).equals(D(expect.total));
    } catch {
      same = false;
    }
    if (!same) problems.push(`إجمالي المستند في المنظومة ${remote.total} مش ${D(expect.total).toFixed(2)}`);
  }
  if (remote.issuerId && expect.issuerId && remote.issuerId !== expect.issuerId) problems.push(`المُصدِر في المنظومة ${remote.issuerId} مش ${expect.issuerId}`);
  return problems;
}
const expectOf = (doc: Doc, src: EtaSource) => ({ internalId: doc.internalId, total: src.invoice.total, issuerId: src.issuer.registrationNumber });
const summary = (d: EtaRemoteDoc) => ({ uuid: d.uuid, longId: d.longId, internalId: d.internalId, status: d.status, total: d.total, submissionId: d.submissionId });

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export async function submitInvoiceToEta(invoiceId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return submitToEta("sales_invoice", invoiceId, actor, deps);
}

/** Sends a credit note once; refused (422) until ETA has accepted the invoice it credits. */
export async function submitCreditNoteToEta(creditNoteId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return submitToEta("credit_note", creditNoteId, actor, deps);
}

async function submitToEta(kind: EtaKind, id: string, actor: ServiceActor, deps: () => EtaDeps) {
  assertPermission(actor, "accounting.eta.manage");

  // Already registered (or possibly registered, or filed on the portal): report, never resend.
  const existing = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } } });
  if (existing && !resendable(existing)) return { submitted: false, eta: existing };

  const src = await loadSource(prisma, kind, id);
  const { issues, document } = validateEtaSource(src);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    const first = errors.slice(0, 3).map((e) => e.message).join(" · ");
    throw new ApiError(422, kind === "credit_note" ? `الإشعار الدائن مش جاهز للإرسال (${errors.length} نقص): ${first}` : `الفاتورة مش جاهزة للإرسال (${errors.length} نقص): ${first}`);
  }

  // API submission is off until the go-live date is set, and never for earlier documents
  // (those were filed on the portal and are recorded with their UUID instead).
  const w = await apiWindow();
  if (!w.enabled) throw new ApiError(503, "الإرسال الآلي لمنظومة الضرائب مقفول (إعداد \"بداية الإرسال الآلي\" فاضي) — المستندات بتتسجل برقم البوابة");
  const date = documentDate(src);
  if (!apiEligible(w, date)) throw new ApiError(409, `المستند تاريخه ${date ?? "—"} قبل بداية الإرسال الآلي (${w.from}) — يتسجل برقم البوابة ومايتبعتش آلي`);

  const d = deps(); // 503 before anything is recorded when not configured
  const checkSignatures = d.checkSignatures ?? ((s: unknown, ser: string) => checkEtaSignatures(s, ser));

  // The exact JSON text, its canonical form and ETA's document hash — computed once.
  const unsignedJson = etaJson(document);
  const serialized = canonicalSerialize(unsignedJson);
  const documentHash = sha256Hex(serialized);

  // Claim, in its own committed transaction, before the network.
  const claim = await inTx(async (tx) => {
    await advisoryXactLock(tx, lockKey(kind, id));
    let doc = await getDoc(tx, kind, id);
    if (doc && !resendable(doc)) return { proceed: false as const, doc };
    if (!doc) doc = await tx.etaDocument.create({ data: { sourceType: kind, sourceId: id, internalId: document.internalID, documentType: document.documentType, documentTypeVersion: ETA_DOCUMENT_VERSION } });
    // A resend after `invalid` keeps the old UUID in priorUuids (the DB refuses anything else).
    const superseded = doc.status === "invalid" && doc.uuid ? doc.uuid : null;
    const claimed = await transition(tx, doc, "submitting", {
      attempts: { increment: 1 }, lastAttemptAt: new Date(), documentHash, payloadHash: null, signedPayload: null, lastError: Prisma.DbNull,
      ...(superseded ? { uuid: null, longId: null, submissionId: null, hashKey: null, priorUuids: { push: superseded } } : {}),
    }, "claim", { attempt: doc.attempts + 1, documentHash, ...(superseded ? { supersededUuid: superseded } : {}) }, actor);
    return { proceed: true as const, doc: claimed };
  });
  if (!claim.proceed) return { submitted: false, eta: claim.doc };

  let stage: "sign" | "send" = "sign";
  let result: EtaSubmitResult;
  try {
    const signed = await d.signer.sign(document, { serialized, sha256: documentHash });
    const signatures = (Array.isArray(signed.signatures) ? signed.signatures : []).map((s) => ({ signatureType: s?.signatureType, value: s?.value }));
    const check = checkSignatures(signatures, serialized);
    if (!check.ok) throw new EtaTransportError(`التوقيع اللي رجع من خدمة التوقيع مش سليم: ${check.problems.join(" · ")}`, false, { problems: check.problems, certificate: check.certificate ?? null });
    // Only the signatures are taken from the bridge; the document is this app's own.
    const signedJson = etaJson({ ...document, signatures } as typeof document);
    const payloadHash = sha256Hex(signedJson);
    // Kept BEFORE it leaves: the exact bytes ETA will receive.
    await inTx(async (tx) => {
      const doc = (await getDoc(tx, kind, id))!;
      await tx.etaDocument.update({ where: { id: doc.id }, data: { signedPayload: signedJson, payloadHash } });
      await note(tx, doc, "signed", { payloadHash, documentHash, certificate: check.certificate, signedPayload: signedJson }, actor);
    });
    stage = "send";
    result = await d.gateway.submit([{ internalID: document.internalID, json: signedJson }]);
  } catch (e) {
    // Nothing reached ETA (signing, signature check, login, throttling) → failed, safe to
    // retry. The request may have reached ETA (timeout, 5xx, 422 DuplicateSubmission,
    // undocumented 4xx) → unknown, resolved only by an ETA lookup or a two-person decision.
    const reached = e instanceof EtaTransportError ? e.reachedEta : stage === "send";
    const info = e instanceof EtaTransportError ? e.info : {};
    const message = (e as Error).message;
    const detail = { message, stage, httpStatus: info.httpStatus ?? null, code: info.code ?? null, retryAfter: info.retryAfter ?? null };
    await inTx(async (tx) => {
      const doc = (await getDoc(tx, kind, id))!;
      await transition(tx, doc, reached ? "unknown" : "failed", { lastError: { ...detail, detail: (e as EtaTransportError).detail ?? null } as Prisma.InputJsonValue }, reached ? "submit_unknown" : "submit_failed", detail, actor);
    });
    throw new ApiError(502, reached ? `مش مؤكد إن المستند وصل للمنظومة (${message}) — اعمل "بحث في المنظومة" قبل أي إرسال تاني` : `الإرسال فشل قبل ما يوصل للمنظومة: ${message}`);
  }
  return recordSubmitResult(kind, id, document.internalID, result, actor);
}

/**
 * ETA answered. Its answer is stored first, on its own; then the status. If the status
 * cannot be recorded (e.g. ETA returned a UUID already linked to another document), the
 * document goes to `unknown` with the answer kept; if even that fails, the claim stays
 * `submitting` and a lookup recovers it. Never resendable either way.
 */
async function recordSubmitResult(kind: EtaKind, id: string, internalId: string, result: EtaSubmitResult, actor: ServiceActor) {
  const ok = result.accepted.find((a) => a.internalId === internalId);
  const no = result.rejected.find((r) => r.internalId === internalId);
  try {
    await inTx(async (tx) => {
      const doc = (await getDoc(tx, kind, id))!;
      await tx.etaDocument.update({ where: { id: doc.id }, data: { lastResponse: json(result.raw), submissionId: result.submissionId ?? doc.submissionId } });
      await note(tx, doc, "response_received", { submissionId: result.submissionId, accepted: ok ? { uuid: ok.uuid, longId: ok.longId } : null, rejected: no ? no.error : null }, actor);
    });
  } catch {
    // Carry on: the status transaction below retries the same write.
  }
  try {
    const eta = await inTx(async (tx) => {
      await advisoryXactLock(tx, lockKey(kind, id));
      const doc = (await getDoc(tx, kind, id))!;
      if (ok) return transition(tx, doc, "submitted", { submissionId: result.submissionId, uuid: ok.uuid, longId: ok.longId, hashKey: ok.hashKey, submittedAt: new Date(), lastResponse: json(result.raw) }, "submit_ok", { submissionId: result.submissionId, uuid: ok.uuid }, actor);
      if (no) return transition(tx, doc, "rejected", { submissionId: result.submissionId, rejectedAt: new Date(), lastError: json(no.error), lastResponse: json(result.raw) }, "submit_rejected", no.error, actor);
      return transition(tx, doc, "unknown", { submissionId: result.submissionId, lastResponse: json(result.raw), lastError: { message: "الرد مافيهوش المستند" } }, "submit_unknown", result.raw, actor);
    });
    return { submitted: !!ok, eta };
  } catch (e) {
    const message = (e as Error).message.split("\n").slice(-1)[0].slice(0, 300);
    try {
      await inTx(async (tx) => {
        const doc = (await getDoc(tx, kind, id))!;
        await transition(tx, doc, "unknown", { submissionId: result.submissionId ?? doc.submissionId, lastResponse: json(result.raw), lastError: { message, stage: "record" } }, "submit_unknown", { stage: "record", message, acceptedUuid: ok?.uuid ?? null }, actor);
      });
    } catch {
      // The claim stays `submitting`; a lookup after the wait window recovers it.
    }
    throw new ApiError(502, `المنظومة ردّت بس الرد ماتسجلش (${message}) — اعمل "بحث في المنظومة" قبل أي حاجة`);
  }
}

// ---------------------------------------------------------------------------
// Refresh: the state of a document ETA registered (needs its UUID)
// ---------------------------------------------------------------------------

export async function refreshInvoiceEta(invoiceId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return refreshEta("sales_invoice", invoiceId, actor, deps);
}

export async function refreshCreditNoteEta(creditNoteId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return refreshEta("credit_note", creditNoteId, actor, deps);
}

async function refreshEta(kind: EtaKind, id: string, actor: ServiceActor, deps: () => EtaDeps) {
  assertPermission(actor, "accounting.eta.manage");
  const doc = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } } });
  if (!doc) throw new ApiError(404, "الفاتورة ما اتبعتتش للمنظومة");
  if (!doc.uuid) throw new ApiError(409, "مفيش رقم مستند من المنظومة — استخدم \"بحث في المنظومة\"");
  const src = await loadSource(prisma, kind, id);
  const uuid = doc.uuid;
  const remote = await deps().gateway.getDocument(uuid).catch((e) => {
    throw new ApiError(502, `قراءة الحالة من المنظومة فشلت: ${(e as Error).message}`);
  });
  const to = fromRemote(remote.status);
  if (!to) throw new ApiError(502, `حالة غير معروفة من المنظومة: ${remote.status}`);
  const problems = crossCheck(remote, expectOf(doc, src));
  return settle(await inTx(async (tx): Promise<Outcome> => {
    await advisoryXactLock(tx, lockKey(kind, id));
    const cur = (await getDoc(tx, kind, id))!;
    if (problems.length) {
      await note(tx, cur, "refresh_mismatch", { uuid, remote: summary(remote), problems }, actor);
      return { refuse: 409, message: `المستند اللي في المنظومة مش مطابق: ${problems.join(" · ")}` };
    }
    return { eta: await transition(tx, cur, to, remoteData(to, remote, cur), "refresh", { remoteStatus: remote.status, remote: summary(remote) }, actor) };
  }));
}

// ---------------------------------------------------------------------------
// Uncertain submissions: ETA lookup (ETA-01)
// ---------------------------------------------------------------------------

export async function lookupInvoiceEta(invoiceId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return lookupEta("sales_invoice", invoiceId, actor, deps);
}

export async function lookupCreditNoteEta(creditNoteId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return lookupEta("credit_note", creditNoteId, actor, deps);
}

/**
 * Asks ETA what it holds for an uncertain document: Get Submission when the submission
 * UUID is known, else Search Documents by internalID over the attempt's dates.
 *   one matching document → its UUID and status are recorded (after the cross-check);
 *   several → refused, a person decides;
 *   none, and the attempt is older than the wait window → `failed` (safe to send again);
 *   none, too early → refused; nothing changes.
 * Every lookup, whatever it finds, is kept as an event with the query and the answer.
 */
async function lookupEta(kind: EtaKind, id: string, actor: ServiceActor, deps: () => EtaDeps) {
  assertPermission(actor, "accounting.eta.manage");
  const doc0 = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } } });
  if (!doc0) throw new ApiError(404, "الفاتورة ما اتبعتتش للمنظومة");
  if (!uncertain(doc0)) throw new ApiError(409, `البحث في المنظومة لحالة "مش معروف" بس (الحالة دلوقتي: ${statusLabel(doc0)})`);
  const src = await loadSource(prisma, kind, id);
  const { gateway } = deps();
  const since = attemptAt(doc0);
  const evidence: Record<string, unknown> = { attemptAt: since.toISOString() };
  let candidates: EtaRemoteDoc[] = [];
  let inProgress = false;
  try {
    if (doc0.submissionId) {
      try {
        const sub = await gateway.getSubmission(doc0.submissionId);
        evidence.submission = { submissionId: sub.submissionId, overallStatus: sub.overallStatus, documents: sub.documents.map(summary) };
        inProgress = /progress/i.test(sub.overallStatus);
        candidates = sub.documents.filter((x) => x.internalId === doc0.internalId);
      } catch (e) {
        if (!(e instanceof EtaTransportError && e.info.httpStatus === 404)) throw e;
        evidence.submission = { submissionId: doc0.submissionId, notFound: true };
      }
    }
    if (!candidates.length) {
      const from = new Date(since.getTime() - 86_400_000);
      // ETA allows at most 30 days per search.
      const to = new Date(Math.min(Date.now(), from.getTime() + 30 * 86_400_000));
      const r = await gateway.searchDocuments({ internalId: doc0.internalId, submittedFrom: from, submittedTo: to });
      evidence.search = { query: r.query, results: r.documents.map(summary) };
      candidates = r.documents.filter((x) => x.internalId === doc0.internalId);
    }
  } catch (e) {
    throw new ApiError(502, `البحث في المنظومة فشل: ${(e as Error).message}`);
  }
  // Documents of earlier attempts (resent after `invalid`) are not this attempt's.
  const known = new Set(doc0.priorUuids);
  const found = [...new Map(candidates.filter((c) => c.uuid && !known.has(c.uuid)).map((c) => [c.uuid, c])).values()];

  return settle(await inTx(async (tx): Promise<Outcome> => {
    await advisoryXactLock(tx, lockKey(kind, id));
    const doc = (await getDoc(tx, kind, id))!;
    if (doc.version !== doc0.version) return { refuse: 409, message: "حالة المستند اتغيرت أثناء البحث — حدّث الشاشة" };
    if (found.length > 1) {
      await note(tx, doc, "lookup_ambiguous", evidence, actor);
      return { refuse: 409, message: `المنظومة فيها ${found.length} مستندات بنفس الرقم الداخلي ${doc.internalId} — محتاج قرار من المحاسب` };
    }
    if (found.length === 1) {
      const r = found[0];
      const problems = crossCheck(r, expectOf(doc, src));
      if (problems.length) {
        await note(tx, doc, "lookup_mismatch", { ...evidence, problems }, actor);
        return { refuse: 409, message: `المستند اللي في المنظومة مش مطابق: ${problems.join(" · ")}` };
      }
      // Registered at ETA: whatever its state, it is never sent again.
      const to = fromRemote(r.status) ?? "submitted";
      return { eta: await transition(tx, doc, to, { uuid: r.uuid, submissionId: r.submissionId ?? doc.submissionId, submittedAt: doc.submittedAt ?? new Date(), ...remoteData(to, r, doc) }, "lookup_found", { ...evidence, uuid: r.uuid, remoteStatus: r.status }, actor) };
    }
    const waitedMs = Date.now() - since.getTime();
    if (waitedMs < ETA_LOOKUP_MIN_WAIT_MS || inProgress) {
      await note(tx, doc, "lookup_absent_too_early", { ...evidence, waitedMinutes: Math.floor(waitedMs / 60_000), inProgress }, actor);
      const opens = new Date(since.getTime() + ETA_LOOKUP_MIN_WAIT_MS).toISOString();
      return { refuse: 409, message: inProgress ? "المنظومة لسه بتعالج الإرسال — جرّب البحث تاني بعد شوية" : `لسه بدري نحكم إنها مش في المنظومة — جرّب البحث بعد ${opens}` };
    }
    return { eta: await transition(tx, doc, "failed", { lastError: { message: "المنظومة مافيهاش المستند (بحث بعد فترة الانتظار)" } }, "lookup_absent", { ...evidence, waitedMinutes: Math.floor(waitedMs / 60_000) }, actor) };
  }));
}

// ---------------------------------------------------------------------------
// Uncertain submissions: manual reconciliation (ETA-01 / ETA-11)
// ---------------------------------------------------------------------------

/**
 * For a document stuck in `unknown` (or a stale `submitting` claim):
 *   { uuid }                       — the UUID found on the portal; verified with ETA
 *                                    (Get Document Details + cross-check) before it is kept;
 *   { propose_not_received, reason, portal_evidence }
 *                                  — one person records that the portal has no such document
 *                                    (after the wait window); nothing changes yet;
 *   { confirm_not_received: <proposal id>, portal_evidence }
 *                                  — a DIFFERENT person with accounting.eta.manage confirms
 *                                    with their own portal check → `failed` (resendable).
 * Both people and both pieces of evidence stay in the event history.
 */
export async function reconcileInvoiceEta(invoiceId: string, input: unknown, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return reconcileEta("sales_invoice", invoiceId, input, actor, deps);
}

export async function reconcileCreditNoteEta(creditNoteId: string, input: unknown, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return reconcileEta("credit_note", creditNoteId, input, actor, deps);
}

const evidenceText = (label: string) => z.string({ required_error: `${label} مطلوب` }).trim().min(10, `${label}: اكتب اللي راجعته بالتفصيل (10 حروف على الأقل)`).max(1000);
const uuidInput = z.string({ required_error: "رقم المستند (UUID) مطلوب" }).trim().regex(ETA_UUID, "رقم المستند (UUID) لازم 26 حرف/رقم زي ما هو على البوابة");

async function reconcileEta(kind: EtaKind, id: string, input: unknown, actor: ServiceActor, deps: () => EtaDeps) {
  assertPermission(actor, "accounting.eta.manage");
  const v = parse(z.union([
    z.object({ uuid: uuidInput }),
    z.object({ propose_not_received: z.literal(true), reason: evidenceText("السبب"), portal_evidence: evidenceText("دليل البوابة") }),
    z.object({ confirm_not_received: z.string().trim().min(1).max(100), portal_evidence: evidenceText("دليل البوابة") }),
  ]), input);
  const doc0 = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } } });
  if (!doc0) throw new ApiError(404, "الفاتورة ما اتبعتتش للمنظومة");
  const notStuck = (d: Doc) => ({ refuse: 409, message: `المطابقة اليدوية لحالة "مش معروف" بس (الحالة دلوقتي: ${statusLabel(d)})` });
  if (!uncertain(doc0)) settle(notStuck(doc0));

  if ("uuid" in v) {
    const src = await loadSource(prisma, kind, id);
    const remote = await deps().gateway.getDocument(v.uuid).catch((e) => {
      throw new ApiError(502, `التأكد من رقم المستند في المنظومة فشل: ${(e as Error).message}`);
    });
    const problems = crossCheck(remote, expectOf(doc0, src));
    const to = fromRemote(remote.status) ?? "submitted";
    return settle(await inTx(async (tx): Promise<Outcome> => {
      await advisoryXactLock(tx, lockKey(kind, id));
      const doc = (await getDoc(tx, kind, id))!;
      if (!uncertain(doc)) return notStuck(doc);
      if (problems.length) {
        await note(tx, doc, "reconcile_mismatch", { uuid: v.uuid, remote: summary(remote), problems }, actor);
        return { refuse: 409, message: `المستند اللي في المنظومة مش مطابق: ${problems.join(" · ")}` };
      }
      return { eta: await transition(tx, doc, to, { uuid: v.uuid, submissionId: remote.submissionId ?? doc.submissionId, submittedAt: doc.submittedAt ?? new Date(), ...remoteData(to, remote, doc) }, "reconcile", { uuid: v.uuid, verified: "getDocument", remote: summary(remote) }, actor) };
    }));
  }

  return settle(await inTx(async (tx): Promise<Outcome> => {
    await advisoryXactLock(tx, lockKey(kind, id));
    const doc = (await getDoc(tx, kind, id))!;
    if (!uncertain(doc)) return notStuck(doc);
    const since = attemptAt(doc);
    if (Date.now() - since.getTime() < ETA_LOOKUP_MIN_WAIT_MS) return { refuse: 409, message: `لسه بدري نحكم إنها مش في المنظومة — استنى لحد ${new Date(since.getTime() + ETA_LOOKUP_MIN_WAIT_MS).toISOString()}` };
    if (!actor.id) return { refuse: 403, message: "القرار ده لازم يتاخد من مستخدم باسمه" };

    if ("propose_not_received" in v) {
      const ev = await note(tx, doc, "not_received_proposed", { reason: v.reason, portalEvidence: v.portal_evidence, docVersion: doc.version, proposerId: actor.id }, actor);
      return { eta: { ...doc, proposalId: ev.id } as Doc };
    }

    const proposal = await tx.etaDocumentEvent.findFirst({ where: { id: v.confirm_not_received, etaDocumentId: doc.id, action: "not_received_proposed" } });
    if (!proposal) return { refuse: 404, message: "الاقتراح ده مش موجود" };
    const p = (proposal.detail ?? {}) as { docVersion?: number; reason?: string; portalEvidence?: string };
    if (p.docVersion !== doc.version) return { refuse: 409, message: "الاقتراح ده قديم — حالة المستند اتغيرت بعده" };
    if (!proposal.actorId || proposal.actorId === actor.id) return { refuse: 403, message: "التأكيد لازم يكون من شخص تاني غير اللي اقترح" };
    return {
      eta: await transition(tx, doc, "failed", { lastError: { message: `مش موجودة في المنظومة (قرار شخصين): ${p.reason ?? ""}` } }, "not_received_confirmed", {
        proposalId: proposal.id, proposedBy: { id: proposal.actorId, name: proposal.actorName }, reason: p.reason ?? null, proposerEvidence: p.portalEvidence ?? null, confirmerEvidence: v.portal_evidence,
      }, actor),
    };
  }));
}

// ---------------------------------------------------------------------------
// Portal filings (ETA-14 / ETA-13)
// ---------------------------------------------------------------------------

/**
 * A document filed on the ETA portal (interim procedure, or before the API go-live date)
 * is recorded with the portal's UUID, submission date and evidence: it becomes `valid`
 * (origin "portal"), is never offered for API submission, and credit notes can reference it.
 * Refused when UNITED's record already holds, or may hold, an ETA document for it.
 */
export async function recordInvoicePortalFiling(invoiceId: string, input: unknown, actor: ServiceActor) {
  return recordPortalFiling("sales_invoice", invoiceId, input, actor);
}

export async function recordCreditNotePortalFiling(creditNoteId: string, input: unknown, actor: ServiceActor) {
  return recordPortalFiling("credit_note", creditNoteId, input, actor);
}

async function recordPortalFiling(kind: EtaKind, id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.manage");
  const v = parse(z.object({
    uuid: uuidInput,
    long_id: optText("Long ID", 200).optional(),
    submitted_at: z.string({ required_error: "تاريخ الإرسال على البوابة مطلوب" }).trim().refine((s) => !Number.isNaN(Date.parse(s)), "تاريخ الإرسال على البوابة غير صالح"),
    evidence_note: evidenceText("دليل البوابة"),
  }), input);
  const submittedAt = new Date(v.submitted_at);
  if (submittedAt.getTime() > Date.now() + 60_000) throw new ApiError(400, "تاريخ الإرسال على البوابة في المستقبل");
  const src = await loadSource(prisma, kind, id);
  if (src.invoice.status !== "issued" || !src.invoice.number) throw new ApiError(409, "المستند لازم يكون صادر برقم قبل تسجيله من البوابة");
  try {
    return await inTx(async (tx) => {
      await advisoryXactLock(tx, lockKey(kind, id));
      let doc = await getDoc(tx, kind, id);
      if (doc && (doc.uuid || !NOTHING_REGISTERED.includes(doc.status as EtaStatus))) throw new ApiError(409, `المستند له حالة في المنظومة بالفعل (${statusLabel(doc)}) — استخدم "بحث في المنظومة" أو "مطابقة يدوية"`);
      if (!doc) doc = await tx.etaDocument.create({ data: { sourceType: kind, sourceId: id, internalId: src.invoice.number!, documentType: kind === "credit_note" ? "c" : "i", documentTypeVersion: ETA_DOCUMENT_VERSION } });
      return transition(tx, doc, "valid", { origin: "portal", uuid: v.uuid, longId: v.long_id ?? null, submittedAt, acceptedAt: submittedAt, lastError: Prisma.DbNull }, "portal_recorded", { uuid: v.uuid, longId: v.long_id ?? null, submittedAt: submittedAt.toISOString(), evidenceNote: v.evidence_note }, actor);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ApiError(409, "رقم المستند (UUID) ده متسجل على مستند تاني");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Pending submissions (ETA-15): issued, not registered at ETA — read only
// ---------------------------------------------------------------------------

/** Local states in which a document is not (or not known to be) validly registered at ETA. */
const NOT_REGISTERED_SQL = Prisma.join(["pending", "submitting", "failed", "rejected", "unknown", "invalid"]);

export async function etaPendingSubmissions(actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.view");
  const w = await apiWindow();
  type Row = { id: string; number: string | null; issueDate: string | null; issuedAt: Date | null; buyerName: string | null; total: string; status: string | null };
  const [invoices, creditNotes] = await Promise.all([
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT i.id, i.number, i."issueDate", i."issuedAt", i."buyerName", i.total::text AS total, d.status
      FROM "SalesInvoice" i LEFT JOIN "EtaDocument" d ON d."sourceType" = 'sales_invoice' AND d."sourceId" = i.id
      WHERE i.status = 'issued' AND (d.id IS NULL OR d.status IN (${NOT_REGISTERED_SQL}))
      ORDER BY i."issuedAt" ASC NULLS FIRST LIMIT 500`),
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT c.id, c.number, c."issueDate", c."createdAt" AS "issuedAt", i."buyerName", c.total::text AS total, d.status
      FROM "CreditNote" c JOIN "SalesInvoice" i ON i.id = c."invoiceId"
      LEFT JOIN "EtaDocument" d ON d."sourceType" = 'credit_note' AND d."sourceId" = c.id
      WHERE d.id IS NULL OR d.status IN (${NOT_REGISTERED_SQL})
      ORDER BY c."createdAt" ASC LIMIT 500`),
  ]);
  const now = Date.now();
  const row = (kind: EtaKind) => (r: Row) => ({
    kind, id: r.id, number: r.number, issueDate: r.issueDate, issuedAt: r.issuedAt, buyerName: r.buyerName, total: r.total,
    etaStatus: r.status, etaStatusLabel: r.status ? STATUS_LABEL[r.status as EtaStatus] ?? r.status : STATUS_LABEL.pending,
    ageHours: r.issuedAt ? Math.floor((now - new Date(r.issuedAt).getTime()) / 3_600_000) : null,
    apiEligible: apiEligible(w, r.issueDate ?? (r.issuedAt ? new Date(r.issuedAt).toISOString().slice(0, 10) : null)),
  });
  const rows = [...invoices.map(row("sales_invoice")), ...creditNotes.map(row("credit_note"))].sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0));
  return { api: w, rows };
}

// ---------------------------------------------------------------------------
// Setup: the ETA codes and profiles UNITED's own models do not hold
// ---------------------------------------------------------------------------

const addressInput = {
  country: optText("الدولة", 2).optional(),
  governate: optText("المحافظة", 100).optional(),
  regionCity: optText("المدينة / المنطقة", 100).optional(),
  street: optText("الشارع", 200).optional(),
  buildingNumber: optText("رقم المبنى", 50).optional(),
  postalCode: optText("الرمز البريدي", 20).optional(),
  floor: optText("الدور", 20).optional(),
  room: optText("الشقة / الغرفة", 20).optional(),
  landmark: optText("علامة مميزة", 200).optional(),
  additionalInformation: optText("معلومات إضافية", 300).optional(),
};
const auditSetup = (tx: Tx, actor: ServiceActor, id: string, field: string, value: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "eta_setup_changed", entityType: "eta_setup", entityId: id, fieldChanged: field, newValue: value, source: "user", deviceId: actor.deviceId }, tx);

export async function saveIssuerProfile(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.manage");
  const v = parse(z.object({ eta_branch_id: optText("كود الفرع", 50).optional(), activity_code: optText("كود النشاط", 20).optional(), ...addressInput }), input);
  return inTx(async (tx) => {
    const company = await tx.company.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } });
    if (!company) throw new ApiError(409, "بيانات الشركة مش متسجلة");
    const data = { etaBranchId: v.eta_branch_id ?? null, activityCode: v.activity_code ?? null, ...Object.fromEntries(Object.keys(addressInput).map((k) => [k, (v as Record<string, unknown>)[k] ?? null])), updatedById: actor.id, updatedBy: actor.name };
    const row = await tx.etaIssuerProfile.upsert({ where: { companyId: company.id }, create: { companyId: company.id, ...data }, update: { ...data, version: { increment: 1 } } });
    await auditSetup(tx, actor, row.id, "issuer", `${data.etaBranchId ?? "—"} · ${data.activityCode ?? "—"}`);
    return row;
  });
}

/**
 * Retired (Nov 2026): the ETA receiver is part of the customer's master record (its legal
 * entity), edited with the customer under sales.customers.manage. A separate editable copy
 * here let the two disagree, and was ignored for customers with a legal entity. Kept as a
 * refusal so old clients get a clear answer; existing rows are still read as a fallback.
 */
export async function saveReceiverProfile(customerId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.manage");
  throw new ApiError(409, "بيانات المستلم في الفاتورة الإلكترونية بتتعدل من ملف العميل (الكيان القانوني)، مش من شاشة الضرائب", "eta.receiver-profile-retired", { customerId, editHref: `/sales/customers/${customerId}?tab=overview#eta-identity` });
}

export async function setItemCode(productId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.manage");
  const v = parse(z.object({ item_type: z.enum(["GS1", "EGS"]), item_code: z.string().trim().min(1, "كود الصنف مطلوب").max(100) }), input);
  return inTx(async (tx) => {
    const p = await tx.stockProduct.findUnique({ where: { id: productId }, select: { id: true, name: true } });
    if (!p) throw new ApiError(404, "الصنف مش موجود");
    const row = await tx.etaItemCode.upsert({ where: { productId }, create: { productId, itemType: v.item_type, itemCode: v.item_code, updatedById: actor.id, updatedBy: actor.name }, update: { itemType: v.item_type, itemCode: v.item_code, updatedById: actor.id, updatedBy: actor.name } });
    await auditSetup(tx, actor, row.id, "item_code", `${p.name} · ${v.item_type} ${v.item_code}`);
    return row;
  });
}

export async function setUnitType(uomCode: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.manage");
  const v = parse(z.object({ eta_unit_type: z.string().trim().min(1, "كود الوحدة مطلوب").max(20) }), input);
  return inTx(async (tx) => {
    const u = await tx.unitOfMeasure.findUnique({ where: { code: uomCode } });
    if (!u) throw new ApiError(404, "الوحدة مش موجودة");
    const row = await tx.etaUnitType.upsert({ where: { uomCode }, create: { uomCode, etaUnitType: v.eta_unit_type, updatedById: actor.id, updatedBy: actor.name }, update: { etaUnitType: v.eta_unit_type, updatedById: actor.id, updatedBy: actor.name } });
    await auditSetup(tx, actor, uomCode, "unit_type", `${uomCode} → ${v.eta_unit_type}`);
    return row;
  });
}

/** Everything the e-invoicing screen shows: configuration, setup gaps, invoice states. */
export async function etaOverview(actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.view");
  const company = await prisma.company.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" }, include: { etaIssuerProfile: true } });
  const [units, taxes, invoices, docs] = await Promise.all([
    prisma.unitOfMeasure.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { code: true, name: true, nameAr: true, etaUnitType: { select: { etaUnitType: true } } } }),
    prisma.taxRate.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true, nameAr: true, rate: true, etaType: true, etaSubtype: true } }),
    prisma.salesInvoice.findMany({ where: { status: "issued" }, orderBy: { issuedAt: "desc" }, take: 50, select: { id: true, number: true, issueDate: true, buyerName: true, total: true, customerId: true } }),
    prisma.etaDocument.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const states = await prisma.etaDocument.findMany({ where: { sourceType: SOURCE, sourceId: { in: invoices.map((i) => i.id) } }, select: { sourceId: true, status: true, origin: true, uuid: true } });
  const creditNotes = await prisma.creditNote.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { id: true, number: true, issueDate: true, total: true, invoiceId: true, invoice: { select: { number: true, buyerName: true } } } });
  const cnStates = await prisma.etaDocument.findMany({ where: { sourceType: "credit_note", sourceId: { in: creditNotes.map((c) => c.id) } }, select: { sourceId: true, status: true, origin: true, uuid: true } });
  // Products and customers actually invoiced that still lack ETA data.
  const lines = await prisma.salesInvoiceLine.findMany({ where: { invoice: { status: "issued" }, productId: { not: null } }, distinct: ["productId"], select: { productId: true } });
  const products = await prisma.stockProduct.findMany({ where: { id: { in: lines.map((l) => l.productId!) } }, select: { id: true, name: true, nameAr: true, sku: true, unit: true, etaItemCode: { select: { itemType: true, itemCode: true } } }, orderBy: { name: "asc" } });
  const customers = await prisma.customer.findMany({ where: { id: { in: [...new Set(invoices.map((i) => i.customerId))] } }, select: { id: true, code: true, name: true, nameAr: true, taxRegistrationNo: true, etaReceiverProfile: true, legalEntity: true }, orderBy: { name: "asc" } });
  const ip = company?.etaIssuerProfile;
  const w = await apiWindow();
  return {
    config: etaConfigStatus(),
    api: w,
    issuer: {
      name: company?.legalName ?? null,
      registrationNumber: company?.taxRegistrationNumber ?? null,
      profile: ip ? { eta_branch_id: ip.etaBranchId, activity_code: ip.activityCode, country: ip.country, governate: ip.governate, regionCity: ip.regionCity, street: ip.street, buildingNumber: ip.buildingNumber, postalCode: ip.postalCode, floor: ip.floor, room: ip.room, landmark: ip.landmark, additionalInformation: ip.additionalInformation } : null,
    },
    units: units.map((u) => ({ code: u.code, name: u.nameAr ?? u.name, nameAr: u.nameAr, nameEn: u.name, etaUnitType: u.etaUnitType?.etaUnitType ?? null })),
    taxes: taxes.map((t) => ({ ...t, rate: t.rate.toString() })),
    products: products.map((p) => ({ id: p.id, name: p.nameAr ?? p.name, nameAr: p.nameAr, nameEn: p.name, sku: p.sku, unit: p.unit, itemType: p.etaItemCode?.itemType ?? null, itemCode: p.etaItemCode?.itemCode ?? null })),
    customers: customers.map((c) => {
      // Read-only view of the canonical receiver; it is edited in the customer record.
      const inputs = { customer: { taxRegistrationNo: c.taxRegistrationNo }, legalEntity: c.legalEntity, legacyProfile: c.etaReceiverProfile };
      const receiver = resolveEtaReceiver(inputs);
      const g = receiverGaps(inputs, receiver);
      return {
        id: c.id, code: c.code, name: c.name, nameAr: c.nameAr, taxRegistrationNo: g.taxId,
        legalEntity: c.legalEntity && c.legalEntity.active ? { id: c.legalEntity.id, code: c.legalEntity.code, name: c.legalEntity.name, nameAr: c.legalEntity.nameAr } : null,
        receiver, effectiveType: g.effectiveType, gaps: g.gaps, personIdOnlyAbove: g.personIdOnlyAbove,
        editHref: `/sales/customers/${c.id}?tab=overview#eta-identity`,
      };
    }),
    counts: Object.fromEntries(docs.map((d) => [d.status, d._count._all])),
    invoices: invoices.map((i) => {
      const s = states.find((x) => x.sourceId === i.id);
      return { ...i, total: i.total.toString(), etaStatus: s?.status ?? null, etaStatusLabel: s ? statusLabel(s) : STATUS_LABEL.pending, origin: s?.origin ?? null, uuid: s?.uuid ?? null, apiEligible: apiEligible(w, i.issueDate) };
    }),
    creditNotes: creditNotes.map((c) => {
      const s = cnStates.find((x) => x.sourceId === c.id);
      return { id: c.id, number: c.number, issueDate: c.issueDate, total: c.total.toString(), invoiceId: c.invoiceId, invoiceNumber: c.invoice.number, buyerName: c.invoice.buyerName, etaStatus: s?.status ?? null, etaStatusLabel: s ? statusLabel(s) : STATUS_LABEL.pending, origin: s?.origin ?? null, uuid: s?.uuid ?? null, apiEligible: apiEligible(w, c.issueDate) };
    }),
  };
}
