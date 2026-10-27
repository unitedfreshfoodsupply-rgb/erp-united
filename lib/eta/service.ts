import { createHash } from "crypto";
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
import { EtaTransportError, externalSigner, httpGateway, type EtaGateway, type EtaSigner } from "./gateway";
import { ETA_DOCUMENT_VERSION } from "./mapper";
import { hasBlockingIssues, validateEtaSource } from "./validate";
import type { AddressSource, EtaSource, EtaStatus } from "./types";

/**
 * ETA submission of UNITED invoices and of the credit notes against them. The document
 * itself is only read; everything ETA returns is kept on EtaDocument (one per invoice or
 * credit note) with an append-only event history. A credit note references its invoice's
 * ETA UUID, so it can only go once ETA has accepted that invoice.
 *
 * Never twice: the claim (status → submitting) happens under a lock in its own
 * transaction BEFORE any network call, and only a state that proves nothing is
 * registered at ETA may be sent again. A timeout after the request left is `unknown`
 * and can only be resolved by checking ETA (refresh / reconcile), never by resending.
 */

export type EtaDeps = { gateway: EtaGateway; signer: EtaSigner };

export function defaultEtaDeps(): EtaDeps {
  const c = loadEtaConfig(); // 503 when the server is not configured
  return { gateway: httpGateway(c), signer: externalSigner(c) };
}

/** States from which sending again cannot create a second registered document. */
const RESENDABLE: readonly EtaStatus[] = ["pending", "failed", "rejected", "invalid"];
const STATUS_LABEL: Record<EtaStatus, string> = {
  pending: "لسه ما اتبعتتش",
  submitting: "جاري الإرسال",
  submitted: "اتبعتت — مستنية التحقق",
  valid: "مقبولة",
  invalid: "مرفوضة بعد التحقق",
  rejected: "مرفوضة عند الاستلام",
  failed: "الإرسال فشل قبل ما يوصل",
  unknown: "مش معروف وصلت ولا لأ — لازم مراجعة",
  cancelled: "ملغية",
};

const SOURCE = "sales_invoice";
type EtaKind = "sales_invoice" | "credit_note";
const loadSource = (db: Tx | typeof prisma, kind: EtaKind, id: string) => (kind === "credit_note" ? loadEtaCreditNoteSource(db, id) : loadEtaSource(db, id));
const addr = (a: Partial<Record<keyof AddressSource, string | null>> | null): AddressSource => ({
  country: a?.country ?? null, governate: a?.governate ?? null, regionCity: a?.regionCity ?? null, street: a?.street ?? null,
  buildingNumber: a?.buildingNumber ?? null, postalCode: a?.postalCode ?? null, floor: a?.floor ?? null, room: a?.room ?? null,
  landmark: a?.landmark ?? null, additionalInformation: a?.additionalInformation ?? null,
});

// ---------------------------------------------------------------------------
// Reading UNITED's data (no writes)
// ---------------------------------------------------------------------------

export async function loadEtaSource(db: Tx | typeof prisma, invoiceId: string): Promise<EtaSource> {
  const inv = await db.salesInvoice.findUnique({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: "asc" } }, order: { select: { orderNumber: true } }, customer: { include: { legalEntity: true } } } });
  if (!inv) throw new ApiError(404, "الفاتورة مش موجودة");
  const company = await db.company.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" }, include: { etaIssuerProfile: true } });
  const legacy = await db.etaReceiverProfile.findUnique({ where: { customerId: inv.customerId } });
  // Receiver identity: a linked legal entity owns the billing/e-invoice receiver
  // details; the legacy per-customer EtaReceiverProfile remains the fallback.
  const le = inv.customer?.legalEntity ?? null;
  const receiver = le
    ? { type: (le.receiverType as "B" | "P" | "F" | null) ?? null, personalId: le.receiverId ?? null, address: addr(le) }
    : { type: (legacy?.receiverType as "B" | "P" | "F" | null) ?? null, personalId: legacy?.receiverId ?? null, address: addr(legacy) };
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
      id: inv.id, number: inv.number, status: inv.status, issuedAt: inv.issuedAt?.toISOString() ?? null, currencyCode: inv.currencyCode,
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
 * and a reference to the invoice's ETA UUID once ETA accepted it.
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
      id: cn.id, number: cn.number, status: "issued", issuedAt: cn.createdAt.toISOString(), currencyCode: cn.currencyCode,
      gross: cn.gross.toString(), discountTotal: cn.discountTotal.toString(), net: cn.net.toString(), taxTotal: cn.taxTotal.toString(), total: cn.total.toString(),
      orderNumber: null,
    },
    lines,
  };
}

const present = (d: Prisma.EtaDocumentGetPayload<{ include: { events: true } }> | null) =>
  d && {
    id: d.id, internalId: d.internalId, documentType: d.documentType, documentTypeVersion: d.documentTypeVersion,
    status: d.status, statusLabel: STATUS_LABEL[d.status as EtaStatus] ?? d.status,
    submissionId: d.submissionId, uuid: d.uuid, longId: d.longId, attempts: d.attempts,
    submittedAt: d.submittedAt, acceptedAt: d.acceptedAt, rejectedAt: d.rejectedAt, cancelledAt: d.cancelledAt,
    lastError: d.lastError, lastResponse: d.lastResponse, updatedAt: d.updatedAt,
    events: d.events.map((e) => ({ action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, actorName: e.actorName, createdAt: e.createdAt, detail: e.detail })),
  };

async function etaState(kind: EtaKind, id: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.view");
  const src = await loadSource(prisma, kind, id);
  const { issues, document } = validateEtaSource(src);
  const doc = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } }, include: { events: { orderBy: { createdAt: "asc" } } } });
  return { number: src.invoice.number, ready: !hasBlockingIssues(issues), issues, document, eta: present(doc) };
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
  const d = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: SOURCE, sourceId: invoiceId } }, select: { status: true, uuid: true, longId: true, submittedAt: true, acceptedAt: true } });
  return d && { status: d.status, statusLabel: STATUS_LABEL[d.status as EtaStatus] ?? d.status, uuid: d.uuid, longId: d.longId, submittedAt: d.submittedAt, acceptedAt: d.acceptedAt };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

type Doc = Prisma.EtaDocumentGetPayload<object>;

async function transition(tx: Tx, doc: Doc, to: EtaStatus, data: Prisma.EtaDocumentUpdateInput, action: string, detail: unknown, actor: ServiceActor) {
  const updated = await tx.etaDocument.update({ where: { id: doc.id }, data: { ...data, status: to, version: { increment: 1 } } });
  await tx.etaDocumentEvent.create({ data: { etaDocumentId: doc.id, action, fromStatus: doc.status, toStatus: to, detail: (detail ?? undefined) as Prisma.InputJsonValue, actorId: actor.id, actorName: actor.name } });
  await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: `eta_${action}`, entityType: "eta_document", entityId: doc.id, fieldChanged: "status", oldValue: doc.status, newValue: `${to} · ${doc.internalId}`, source: "user", deviceId: actor.deviceId }, tx);
  return updated;
}

const lockKey = (kind: EtaKind, id: string) => `eta:${kind}:${id}`;
const getDoc = (tx: Tx, kind: EtaKind, id: string) => tx.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } } });

export async function submitInvoiceToEta(invoiceId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return submitToEta("sales_invoice", invoiceId, actor, deps);
}

/** Sends a credit note once; refused (422) until ETA has accepted the invoice it credits. */
export async function submitCreditNoteToEta(creditNoteId: string, actor: ServiceActor, deps: () => EtaDeps = defaultEtaDeps) {
  return submitToEta("credit_note", creditNoteId, actor, deps);
}

async function submitToEta(kind: EtaKind, id: string, actor: ServiceActor, deps: () => EtaDeps) {
  assertPermission(actor, "accounting.eta.manage");

  // Already registered (or possibly registered): report, never resend.
  const existing = await prisma.etaDocument.findUnique({ where: { sourceType_sourceId: { sourceType: kind, sourceId: id } } });
  if (existing && !RESENDABLE.includes(existing.status as EtaStatus)) return { submitted: false, eta: existing };

  const src = await loadSource(prisma, kind, id);
  const { issues, document } = validateEtaSource(src);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    const first = errors.slice(0, 3).map((e) => e.message).join(" · ");
    throw new ApiError(422, kind === "credit_note" ? `الإشعار الدائن مش جاهز للإرسال (${errors.length} نقص): ${first}` : `الفاتورة مش جاهزة للإرسال (${errors.length} نقص): ${first}`);
  }

  const { gateway, signer } = deps(); // 503 before anything is recorded when not configured
  const payloadHash = createHash("sha256").update(JSON.stringify(document)).digest("hex");

  // Claim, in its own committed transaction, before the network.
  const claim = await inTx(async (tx) => {
    await advisoryXactLock(tx, lockKey(kind, id));
    let doc = await getDoc(tx, kind, id);
    if (doc && !RESENDABLE.includes(doc.status as EtaStatus)) return { proceed: false as const, doc };
    if (!doc) doc = await tx.etaDocument.create({ data: { sourceType: kind, sourceId: id, internalId: document.internalID, documentType: document.documentType, documentTypeVersion: ETA_DOCUMENT_VERSION } });
    const claimed = await transition(tx, doc, "submitting", { attempts: { increment: 1 }, payloadHash, lastError: Prisma.DbNull }, "claim", { attempt: doc.attempts + 1, payloadHash }, actor);
    return { proceed: true as const, doc: claimed };
  });
  if (!claim.proceed) return { submitted: false, eta: claim.doc };

  let stage: "sign" | "send" = "sign";
  try {
    const signed = await signer.sign(document);
    stage = "send";
    const result = await gateway.submit([signed]);
    const ok = result.accepted.find((a) => a.internalId === document.internalID);
    const no = result.rejected.find((r) => r.internalId === document.internalID);
    const eta = await inTx(async (tx) => {
      const doc = (await getDoc(tx, kind, id))!;
      if (ok) return transition(tx, doc, "submitted", { submissionId: result.submissionId, uuid: ok.uuid, longId: ok.longId, hashKey: ok.hashKey, submittedAt: new Date(), lastResponse: result.raw as Prisma.InputJsonValue }, "submit_ok", { submissionId: result.submissionId, uuid: ok.uuid }, actor);
      if (no) return transition(tx, doc, "rejected", { submissionId: result.submissionId, rejectedAt: new Date(), lastError: no.error as Prisma.InputJsonValue, lastResponse: result.raw as Prisma.InputJsonValue }, "submit_rejected", no.error, actor);
      return transition(tx, doc, "unknown", { submissionId: result.submissionId, lastResponse: result.raw as Prisma.InputJsonValue, lastError: { message: "الرد مافيهوش المستند" } }, "submit_unknown", result.raw, actor);
    });
    return { submitted: !!ok, eta };
  } catch (e) {
    // Nothing reached ETA (signing, login) → failed, safe to retry. The request may have
    // reached ETA → unknown, resolved only by refresh / reconcile.
    const reached = e instanceof EtaTransportError ? e.reachedEta : stage === "send";
    const message = (e as Error).message;
    await inTx(async (tx) => {
      const doc = (await getDoc(tx, kind, id))!;
      await transition(tx, doc, reached ? "unknown" : "failed", { lastError: { message, stage, detail: (e as EtaTransportError).detail ?? null } as Prisma.InputJsonValue }, reached ? "submit_unknown" : "submit_failed", { message, stage }, actor);
    });
    throw new ApiError(502, reached ? `مش مؤكد إن الفاتورة وصلت للمنظومة (${message}) — اعمل "تحديث الحالة" قبل أي إرسال تاني` : `الإرسال فشل قبل ما يوصل للمنظومة: ${message}`);
  }
}

const REMOTE_STATUS: Record<string, EtaStatus> = { valid: "valid", invalid: "invalid", rejected: "rejected", cancelled: "cancelled", submitted: "submitted" };

/** Reads the document's state at ETA (needs its UUID). */
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
  if (!doc.uuid) throw new ApiError(409, "مفيش رقم مستند من المنظومة — راجع بوابة الضرائب واستخدم \"مطابقة يدوية\"");
  const remote = await deps().gateway.getDocument(doc.uuid).catch((e) => {
    throw new ApiError(502, `قراءة الحالة من المنظومة فشلت: ${(e as Error).message}`);
  });
  const to = REMOTE_STATUS[remote.status.toLowerCase()];
  if (!to) throw new ApiError(502, `حالة غير معروفة من المنظومة: ${remote.status}`);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, lockKey(kind, id));
    const cur = (await getDoc(tx, kind, id))!;
    const now = new Date();
    return transition(tx, cur, to, {
      longId: remote.longId ?? cur.longId,
      lastResponse: remote.raw as Prisma.InputJsonValue,
      ...(to === "valid" ? { acceptedAt: cur.acceptedAt ?? now, lastError: Prisma.DbNull } : {}),
      ...(to === "invalid" || to === "rejected" ? { rejectedAt: now, lastError: ((remote.raw as any)?.validationResults ?? remote.raw) as Prisma.InputJsonValue } : {}),
      ...(to === "cancelled" ? { cancelledAt: now } : {}),
    }, "refresh", { remoteStatus: remote.status }, actor);
  });
}

/**
 * For a document stuck in `unknown` (or a `submitting` claim whose process died): the
 * accountant checked the ETA portal and records what is there — its UUID, or that ETA
 * has no such document (which makes sending again safe).
 */
export async function reconcileInvoiceEta(invoiceId: string, input: unknown, actor: ServiceActor) {
  return reconcileEta("sales_invoice", invoiceId, input, actor);
}

export async function reconcileCreditNoteEta(creditNoteId: string, input: unknown, actor: ServiceActor) {
  return reconcileEta("credit_note", creditNoteId, input, actor);
}

async function reconcileEta(kind: EtaKind, id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.manage");
  const v = parse(z.union([
    z.object({ uuid: z.string().trim().min(10).max(100) }),
    z.object({ not_received: z.literal(true), reason: z.string().trim().min(3).max(500) }),
  ]), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, lockKey(kind, id));
    const doc = await getDoc(tx, kind, id);
    if (!doc) throw new ApiError(404, "الفاتورة ما اتبعتتش للمنظومة");
    const stuck = doc.status === "unknown" || (doc.status === "submitting" && Date.now() - doc.updatedAt.getTime() > 5 * 60_000);
    if (!stuck) throw new ApiError(409, `المطابقة اليدوية لحالة "مش معروف" بس (الحالة دلوقتي: ${STATUS_LABEL[doc.status as EtaStatus] ?? doc.status})`);
    if ("uuid" in v) return transition(tx, doc, "submitted", { uuid: v.uuid, submittedAt: doc.submittedAt ?? new Date() }, "reconcile", { uuid: v.uuid }, actor);
    return transition(tx, doc, "failed", { lastError: { message: `مش موجودة في المنظومة: ${v.reason}` } }, "reconcile", { notReceived: true, reason: v.reason }, actor);
  });
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
    const data = { etaBranchId: v.eta_branch_id ?? null, activityCode: v.activity_code ?? null, ...Object.fromEntries(Object.keys(addressInput).map((k) => [k, (v as any)[k] ?? null])), updatedById: actor.id, updatedBy: actor.name };
    const row = await tx.etaIssuerProfile.upsert({ where: { companyId: company.id }, create: { companyId: company.id, ...data }, update: { ...data, version: { increment: 1 } } });
    await auditSetup(tx, actor, row.id, "issuer", `${data.etaBranchId ?? "—"} · ${data.activityCode ?? "—"}`);
    return row;
  });
}

export async function saveReceiverProfile(customerId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.eta.manage");
  const v = parse(z.object({ receiver_type: z.enum(["B", "P", "F"]).nullable().optional(), receiver_id: optText("رقم الهوية", 50).optional(), ...addressInput }), input);
  return inTx(async (tx) => {
    const c = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, code: true } });
    if (!c) throw new ApiError(404, "العميل مش موجود");
    const data = { receiverType: v.receiver_type ?? null, receiverId: v.receiver_id ?? null, ...Object.fromEntries(Object.keys(addressInput).map((k) => [k, (v as any)[k] ?? null])), updatedById: actor.id, updatedBy: actor.name };
    const row = await tx.etaReceiverProfile.upsert({ where: { customerId }, create: { customerId, ...data }, update: { ...data, version: { increment: 1 } } });
    await auditSetup(tx, actor, row.id, "receiver", `${c.code} · ${data.receiverType ?? "تلقائي"}`);
    return row;
  });
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
  const states = await prisma.etaDocument.findMany({ where: { sourceType: SOURCE, sourceId: { in: invoices.map((i) => i.id) } }, select: { sourceId: true, status: true, uuid: true } });
  const creditNotes = await prisma.creditNote.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { id: true, number: true, issueDate: true, total: true, invoiceId: true, invoice: { select: { number: true, buyerName: true } } } });
  const cnStates = await prisma.etaDocument.findMany({ where: { sourceType: "credit_note", sourceId: { in: creditNotes.map((c) => c.id) } }, select: { sourceId: true, status: true, uuid: true } });
  // Products and customers actually invoiced that still lack ETA data.
  const lines = await prisma.salesInvoiceLine.findMany({ where: { invoice: { status: "issued" }, productId: { not: null } }, distinct: ["productId"], select: { productId: true } });
  const products = await prisma.stockProduct.findMany({ where: { id: { in: lines.map((l) => l.productId!) } }, select: { id: true, name: true, nameAr: true, sku: true, unit: true, etaItemCode: { select: { itemType: true, itemCode: true } } }, orderBy: { name: "asc" } });
  const customers = await prisma.customer.findMany({ where: { id: { in: [...new Set(invoices.map((i) => i.customerId))] } }, select: { id: true, code: true, name: true, taxRegistrationNo: true, etaReceiverProfile: true }, orderBy: { name: "asc" } });
  const ip = company?.etaIssuerProfile;
  return {
    config: etaConfigStatus(),
    issuer: {
      name: company?.legalName ?? null,
      registrationNumber: company?.taxRegistrationNumber ?? null,
      profile: ip ? { eta_branch_id: ip.etaBranchId, activity_code: ip.activityCode, country: ip.country, governate: ip.governate, regionCity: ip.regionCity, street: ip.street, buildingNumber: ip.buildingNumber, postalCode: ip.postalCode, floor: ip.floor, room: ip.room, landmark: ip.landmark, additionalInformation: ip.additionalInformation } : null,
    },
    units: units.map((u) => ({ code: u.code, name: u.nameAr ?? u.name, nameAr: u.nameAr, nameEn: u.name, etaUnitType: u.etaUnitType?.etaUnitType ?? null })),
    taxes: taxes.map((t) => ({ ...t, rate: t.rate.toString() })),
    products: products.map((p) => ({ id: p.id, name: p.nameAr ?? p.name, nameAr: p.nameAr, nameEn: p.name, sku: p.sku, unit: p.unit, itemType: p.etaItemCode?.itemType ?? null, itemCode: p.etaItemCode?.itemCode ?? null })),
    customers: customers.map((c) => ({ id: c.id, code: c.code, name: c.name, taxRegistrationNo: c.taxRegistrationNo, profile: c.etaReceiverProfile })),
    counts: Object.fromEntries(docs.map((d) => [d.status, d._count._all])),
    invoices: invoices.map((i) => {
      const s = states.find((x) => x.sourceId === i.id);
      return { ...i, total: i.total.toString(), etaStatus: s?.status ?? null, etaStatusLabel: s ? STATUS_LABEL[s.status as EtaStatus] : "لسه ما اتبعتتش", uuid: s?.uuid ?? null };
    }),
    creditNotes: creditNotes.map((c) => {
      const s = cnStates.find((x) => x.sourceId === c.id);
      return { id: c.id, number: c.number, issueDate: c.issueDate, total: c.total.toString(), invoiceId: c.invoiceId, invoiceNumber: c.invoice.number, buyerName: c.invoice.buyerName, etaStatus: s?.status ?? null, etaStatusLabel: s ? STATUS_LABEL[s.status as EtaStatus] : "لسه ما اتبعتتش", uuid: s?.uuid ?? null };
    }),
  };
}
