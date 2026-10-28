import type { EtaConfig } from "./config";
import type { EtaDocumentV1 } from "./types";

/**
 * The only code that talks to ETA. Two narrow interfaces so the service can be tested
 * with fakes and the real transport can be replaced without touching anything else:
 *
 *   EtaSigner  — adds the issuer signature. ETA requires a CAdES signature made with
 *                UNITED's e-seal (USB token / HSM), which cannot live in this app; a
 *                signing bridge next to the token does it (contract below).
 *   EtaGateway — OAuth client-credentials token, document submission, document state.
 *
 * Endpoint paths follow the published ETA API (⚠ verify against the SDK before the
 * first pre-production run; see docs/erp/ETA_EINVOICE.md).
 */

export type EtaAccepted = { uuid: string; longId: string | null; internalId: string; hashKey: string | null };
export type EtaRejected = { internalId: string; error: unknown };
export type EtaSubmitResult = { submissionId: string | null; accepted: EtaAccepted[]; rejected: EtaRejected[]; raw: unknown };
export type EtaRemoteState = { uuid: string; longId: string | null; internalId: string | null; status: string; raw: unknown };

export interface EtaSigner {
  sign(document: EtaDocumentV1): Promise<EtaDocumentV1>;
}

export interface EtaGateway {
  submit(documents: EtaDocumentV1[]): Promise<EtaSubmitResult>;
  getDocument(uuid: string): Promise<EtaRemoteState>;
}

/**
 * A transport failure. `reachedEta` decides what is safe next: false — nothing was
 * submitted, sending again is safe; true — the request may have been processed, so the
 * state must be checked (refresh / reconcile) before anything is sent again.
 */
export class EtaTransportError extends Error {
  constructor(message: string, readonly reachedEta: boolean, readonly detail?: unknown) {
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

const body = async (res: Response) => {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { text: text.slice(0, 2000) };
  }
};

/**
 * Signing bridge contract (UNITED-defined, implemented next to the e-seal):
 *   POST {ETA_SIGNER_URL}   Authorization: Bearer {ETA_SIGNER_TOKEN}   body: { document }
 *   → 200 { signatures: [{ signatureType: "I", value: "<CAdES-BES base64>" }] }
 */
export function externalSigner(config: Pick<EtaConfig, "signerUrl" | "signerToken">, fetchImpl: Fetch = fetch): EtaSigner {
  return {
    async sign(document) {
      const res = await call(fetchImpl, config.signerUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.signerToken ? { authorization: `Bearer ${config.signerToken}` } : {}) },
        body: JSON.stringify({ document }),
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
    token = { value: b.access_token, until: Date.now() + Math.max(0, Number(b.expires_in ?? 0) - 60) * 1000 };
    return token.value;
  }

  return {
    async submit(documents) {
      const auth = await accessToken();
      const res = await call(fetchImpl, `${config.apiBaseUrl}/api/v1/documentsubmissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
        body: JSON.stringify({ documents }),
      }, true);
      const b = await body(res);
      // A 4xx is ETA refusing the whole submission (nothing registered); a 5xx is
      // ambiguous — it may or may not have been processed.
      if (res.status >= 500) throw new EtaTransportError(`منظومة الضرائب ردّت بخطأ ${res.status}`, true, b);
      if (!res.ok) return { submissionId: null, accepted: [], rejected: documents.map((d) => ({ internalId: d.internalID, error: b })), raw: b };
      return {
        submissionId: b?.submissionId ?? null,
        accepted: (b?.acceptedDocuments ?? []).map((a: EtaAcceptedDoc) => ({ uuid: String(a.uuid), longId: a.longId ?? null, internalId: String(a.internalId), hashKey: a.hashKey ?? null })),
        rejected: (b?.rejectedDocuments ?? []).map((r: EtaRejectedDoc) => ({ internalId: String(r.internalId), error: r.error ?? r })),
        raw: b,
      };
    },
    async getDocument(uuid) {
      const auth = await accessToken();
      const res = await call(fetchImpl, `${config.apiBaseUrl}/api/v1/documents/${encodeURIComponent(uuid)}/details`, { headers: { authorization: `Bearer ${auth}` } }, true);
      const b = await body(res);
      if (!res.ok) throw new EtaTransportError(`قراءة حالة المستند فشلت (${res.status})`, true, b);
      return { uuid: String(b?.uuid ?? uuid), longId: b?.longId ?? null, internalId: b?.internalId ?? null, status: String(b?.status ?? ""), raw: b };
    },
  };
}
