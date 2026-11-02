import { createHash } from "crypto";
import type { EtaConfig } from "./config";
import type { EtaDocumentV1 } from "./types";

/**
 * The only code that talks to ETA. Two narrow interfaces so the service can be tested
 * with fakes and the real transport can be replaced without touching anything else:
 *
 *   EtaSigner  — adds the issuer signature. ETA requires a CAdES signature made with
 *                UNITED's e-seal (USB token / HSM), which cannot live in this app; a
 *                signing bridge next to the token does it (contract below).
 *   EtaGateway — OAuth client-credentials token, document submission, and the three
 *                read paths used to find out what ETA holds: Get Submission (by the
 *                submission UUID), Search Documents (by internalID, over a date range)
 *                and Get Document Details (by document UUID).
 *
 * Paths and fields follow the SDK pages (https://sdk.invoicing.eta.gov.eg/einvoicingapi/):
 *   POST /api/v1.0/documentsubmissions/            → submissionUUID, acceptedDocuments, rejectedDocuments
 *   GET  /api/v1.0/documentsubmissions/{uuid}       → overallStatus, documentSummary[uuid,longId,internalId,status,total,issuerId]
 *   GET  /api/v1.0/documents/search?internalID=…    → result[…], metadata.continuationToken
 *   GET  /api/v1.0/documents/{uuid}/details         → submissionUUID, longId, status, document, validationResults
 * ⚠ Not verifiable from the SDK pages, read defensively and to be confirmed in pre-production:
 *   the error body shape ({ error: { code } } vs { code }); whether Get Document Details
 *   returns `document` as an object or a JSON string; `hashKey` (not documented, kept if present);
 *   `submissionId` (older field name, accepted as a fallback for submissionUUID).
 */

export type EtaAccepted = { uuid: string; longId: string | null; internalId: string; hashKey: string | null };
export type EtaRejected = { internalId: string; error: unknown };
export type EtaSubmitResult = { submissionId: string | null; accepted: EtaAccepted[]; rejected: EtaRejected[]; raw: unknown };
/** One document as ETA reports it, from any of the read paths. */
export type EtaRemoteDoc = {
  uuid: string;
  longId: string | null;
  internalId: string | null;
  status: string;
  /** Document total as ETA holds it (decimal string), when the path returns it. */
  total: string | null;
  issuerId: string | null;
  submissionId: string | null;
  raw: unknown;
};
/** Kept for the callers that only need the state. */
export type EtaRemoteState = EtaRemoteDoc;
export type EtaSubmissionState = { submissionId: string; overallStatus: string; documents: EtaRemoteDoc[]; raw: unknown };
export type EtaSearchQuery = { internalId: string; submittedFrom: Date; submittedTo: Date };
export type EtaSearchResult = { documents: EtaRemoteDoc[]; query: Record<string, string>; raw: unknown };
/** A document ready to send: its exact signed JSON text (the bytes that are hashed and kept). */
export type EtaPreparedDocument = { internalID: string; json: string };
/** What the signer is given: the document, its canonical form and that form's SHA-256. */
export type EtaSigningInput = { serialized: string; sha256: string };

export interface EtaSigner {
  sign(document: EtaDocumentV1, input?: EtaSigningInput): Promise<EtaDocumentV1>;
}

export interface EtaGateway {
  submit(documents: EtaPreparedDocument[]): Promise<EtaSubmitResult>;
  getDocument(uuid: string): Promise<EtaRemoteDoc>;
  getSubmission(submissionId: string): Promise<EtaSubmissionState>;
  searchDocuments(query: EtaSearchQuery): Promise<EtaSearchResult>;
}

/**
 * A transport failure. `reachedEta` decides what is safe next: false — nothing was
 * submitted, sending again is safe; true — the request may have been processed, so the
 * state must be checked (lookup / reconcile) before anything is sent again.
 */
export class EtaTransportError extends Error {
  constructor(
    message: string,
    readonly reachedEta: boolean,
    readonly detail?: unknown,
    readonly info: { httpStatus?: number; code?: string | null; retryAfter?: number | null } = {}
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 30_000;

async function call(fetchImpl: Fetch, url: string, init: RequestInit, reachedOnFailure: boolean) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new EtaTransportError(`تعذّر الاتصال: ${(e as Error).message}`, reachedOnFailure);
  } finally {
    clearTimeout(t);
  }
}

/** ETA's per-document entries in a submission response (only the fields read here). */
type EtaAcceptedDoc = { uuid: unknown; longId?: string | null; internalId: unknown; hashKey?: string | null };
type EtaRejectedDoc = { internalId: unknown; error?: unknown };
type Raw = Record<string, unknown> | null;

const body = async (res: Response) => {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { text: text.slice(0, 2000) };
  }
};

const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
const errorCode = (b: Raw) => str((b?.error as Raw)?.code ?? b?.code ?? (b?.error as Raw)?.errorCode);
const retryAfter = (res: Response) => {
  const v = Number(res.headers.get("retry-after"));
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** The document inside Get Document Details: an object, or a JSON string (⚠ unverified). */
function innerDocument(b: Raw): Raw {
  const d = b?.document;
  if (typeof d === "string") {
    try {
      return JSON.parse(d);
    } catch {
      return null;
    }
  }
  return d && typeof d === "object" ? (d as Raw) : null;
}

function remoteDoc(x: Raw, fallback: { uuid?: string; submissionId?: string | null } = {}): EtaRemoteDoc {
  const doc = innerDocument(x);
  return {
    uuid: String(x?.uuid ?? fallback.uuid ?? ""),
    longId: str(x?.longId),
    internalId: str(x?.internalId ?? x?.internalID ?? doc?.internalID ?? doc?.internalId),
    status: String(x?.status ?? ""),
    total: str(x?.total ?? doc?.totalAmount),
    issuerId: str(x?.issuerId ?? (doc?.issuer as Raw)?.id),
    submissionId: str(x?.submissionUUID ?? x?.submissionId ?? fallback.submissionId),
    raw: x,
  };
}

/** ETA date-time in UTC without milliseconds. */
const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Signing bridge contract (UNITED-defined, implemented next to the e-seal):
 *   POST {ETA_SIGNER_URL}   Authorization: Bearer {ETA_SIGNER_TOKEN}
 *   body: { document, serialized, sha256 }
 *     document   — the ETA document (unsigned) as JSON;
 *     serialized — its ETA canonical form, exactly as the app computed it;
 *     sha256     — hex SHA-256 of `serialized` (UTF-8).
 *   → 200 { signatures: [{ signatureType: "I", value: "<CAdES-BES base64, detached, over `serialized`>" }] }
 * The bridge signs `serialized` as given; it must not re-serialize. The app checks the
 * answer (lib/eta/signature.ts) before anything is sent to ETA.
 */
export function externalSigner(config: Pick<EtaConfig, "signerUrl" | "signerToken">, fetchImpl: Fetch = fetch): EtaSigner {
  return {
    async sign(document, input) {
      const res = await call(fetchImpl, config.signerUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.signerToken ? { authorization: `Bearer ${config.signerToken}` } : {}) },
        body: JSON.stringify({ document, ...(input ? { serialized: input.serialized, sha256: input.sha256 } : {}) }),
      }, false);
      const b = await body(res);
      if (!res.ok || !Array.isArray(b?.signatures) || !b.signatures.length) throw new EtaTransportError(`خدمة التوقيع رفضت (${res.status})`, false, b);
      return { ...document, signatures: b.signatures };
    },
  };
}

export function httpGateway(config: Pick<EtaConfig, "apiBaseUrl" | "idServerUrl" | "clientId" | "clientSecret">, fetchImpl: Fetch = fetch): EtaGateway {
  let token: { value: string; until: number } | null = null;

  async function accessToken() {
    if (token && token.until > Date.now()) return token.value;
    const res = await call(fetchImpl, `${config.idServerUrl}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret, scope: "InvoicingAPI" }).toString(),
    }, false);
    const b = await body(res);
    // The response is never passed on: it carries the token.
    if (!res.ok || typeof b?.access_token !== "string") throw new EtaTransportError(`تسجيل الدخول لمنظومة الضرائب فشل (${res.status})`, false, { status: res.status, error: b?.error ?? null });
    // Renewed a minute before ETA's expiry (expires_in, 3600 s by default).
    token = { value: b.access_token, until: Date.now() + Math.max(0, Number(b.expires_in ?? 0) - 60) * 1000 };
    return token.value;
  }

  /** A read: any failure is a transport error; nothing was submitted by it. */
  async function read(path: string, what: string) {
    const auth = await accessToken();
    const res = await call(fetchImpl, `${config.apiBaseUrl}${path}`, { headers: { authorization: `Bearer ${auth}` } }, true);
    const b = await body(res);
    if (res.status === 401) token = null;
    if (!res.ok) throw new EtaTransportError(`${what} من المنظومة فشلت (${res.status})`, true, b, { httpStatus: res.status, code: errorCode(b), retryAfter: retryAfter(res) });
    return b as Raw;
  }

  return {
    async submit(documents) {
      const auth = await accessToken();
      const res = await call(fetchImpl, `${config.apiBaseUrl}/api/v1.0/documentsubmissions/`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
        // The signed JSON text of each document goes out byte for byte as it was hashed and kept.
        body: `{"documents":[${documents.map((d) => d.json).join(",")}]}`,
      }, true);
      const b = await body(res);
      const info = { httpStatus: res.status, code: errorCode(b), retryAfter: retryAfter(res) };
      if (res.ok) {
        return {
          submissionId: str(b?.submissionUUID ?? b?.submissionId),
          accepted: (b?.acceptedDocuments ?? []).map((a: EtaAcceptedDoc) => ({ uuid: String(a.uuid), longId: a.longId ?? null, internalId: String(a.internalId), hashKey: a.hashKey ?? null })),
          rejected: (b?.rejectedDocuments ?? []).map((r: EtaRejectedDoc) => ({ internalId: String(r.internalId), error: r.error ?? r })),
          raw: b,
        };
      }
      // 5xx: may or may not have been processed.
      if (res.status >= 500) throw new EtaTransportError(`منظومة الضرائب ردّت بخطأ ${res.status}`, true, b, info);
      // 401: the token was refused before the submission was read — nothing processed.
      if (res.status === 401) {
        token = null;
        throw new EtaTransportError("منظومة الضرائب رفضت تسجيل الدخول (401) — مااتبعتش حاجة", false, b, info);
      }
      // 429: throttled, nothing processed; try again after Retry-After.
      if (res.status === 429) throw new EtaTransportError(`منظومة الضرائب طلبت الانتظار (429) — حاول بعد ${info.retryAfter ?? "شوية"} ثانية`, false, b, info);
      // 400 BadStructure / MaximumSizeExceeded, 403 IncorrectSubmitter / Forbidden: the
      // whole submission was refused, nothing registered.
      if (res.status === 400 || res.status === 403) return { submissionId: null, accepted: [], rejected: documents.map((d) => ({ internalId: d.internalID, error: { httpStatus: res.status, code: info.code, body: b } })), raw: b };
      // 422 DuplicateSubmission: ETA already holds an identical submission (within 10
      // minutes). Never a rejection: the first one may be registered → unknown, look it up.
      // Any other 4xx is not documented for this call: treated the same way (fail closed).
      throw new EtaTransportError(
        info.code === "DuplicateSubmission" ? "المنظومة بتقول إن نفس الإرسال اتبعت قبل كده (DuplicateSubmission) — لازم نتأكد من المنظومة قبل أي حاجة" : `رد غير متوقع من المنظومة (${res.status}) — لازم نتأكد من المنظومة قبل أي حاجة`,
        true, b, info
      );
    },
    async getDocument(uuid) {
      const b = await read(`/api/v1.0/documents/${encodeURIComponent(uuid)}/details`, "قراءة حالة المستند");
      return remoteDoc(b, { uuid });
    },
    async getSubmission(submissionId) {
      const b = await read(`/api/v1.0/documentsubmissions/${encodeURIComponent(submissionId)}?pageNo=1&pageSize=100`, "قراءة الإرسال");
      const docs = Array.isArray(b?.documentSummary) ? (b!.documentSummary as Raw[]) : [];
      return { submissionId: String(b?.submissionUUID ?? b?.uuid ?? submissionId), overallStatus: String(b?.overallStatus ?? ""), documents: docs.map((d) => remoteDoc(d, { submissionId })), raw: b };
    },
    async searchDocuments(q) {
      const query = { submissionDateFrom: utc(q.submittedFrom), submissionDateTo: utc(q.submittedTo), direction: "Sent", internalID: q.internalId, pageSize: "100" };
      const documents: EtaRemoteDoc[] = [];
      const pages: unknown[] = [];
      let continuationToken = "";
      // Few documents ever share an internalID; a handful of pages is plenty, and the
      // search is throttled (one call per 2 s per taxpayer by default).
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ ...query, ...(continuationToken ? { continuationToken } : {}) });
        const b = await read(`/api/v1.0/documents/search?${params}`, "البحث في المنظومة");
        pages.push(b);
        for (const d of Array.isArray(b?.result) ? (b!.result as Raw[]) : []) documents.push(remoteDoc(d));
        continuationToken = String((b?.metadata as Raw)?.continuationToken ?? "");
        if (!continuationToken || continuationToken === "EndofResultSet") break;
      }
      return { documents, query, raw: pages.length === 1 ? pages[0] : pages };
    },
  };
}

/**
 * One gateway per configuration for the life of the server process, so the OAuth token
 * is reused until it expires instead of being requested on every click (ETA-10). A
 * changed configuration (rotated secret, other environment) gets a fresh gateway.
 */
let shared: { key: string; gateway: EtaGateway } | null = null;
export function sharedHttpGateway(config: Pick<EtaConfig, "apiBaseUrl" | "idServerUrl" | "clientId" | "clientSecret">, fetchImpl: Fetch = fetch): EtaGateway {
  const key = createHash("sha256").update([config.apiBaseUrl, config.idServerUrl, config.clientId, config.clientSecret].join("\n")).digest("hex");
  if (shared?.key !== key) shared = { key, gateway: httpGateway(config, fetchImpl) };
  return shared.gateway;
}
