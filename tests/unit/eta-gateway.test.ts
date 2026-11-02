/* ETA transport: credentials only from the environment and never echoed; the environment
   guard refuses a URL that is not the named environment's ETA host; the token is requested
   with client credentials and reused until it expires (across calls of the server process);
   failures say whether ETA may have received the document (the basis of "never submit
   twice") — a 422 DuplicateSubmission is never a rejection; the three read paths (Get
   Submission, Search Documents by internalID, Get Document Details) follow the SDK. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { etaConfigStatus, loadEtaConfig, ETA_ENV_VARS } from "../../lib/eta/config";
import { EtaTransportError, externalSigner, httpGateway, sharedHttpGateway, type EtaPreparedDocument } from "../../lib/eta/gateway";
import type { EtaDocumentV1 } from "../../lib/eta/types";

const env = {
  ETA_ENV: "preprod",
  ETA_API_BASE_URL: "https://api.preprod.invoicing.eta.gov.eg/",
  ETA_ID_SERVER_URL: "https://id.preprod.eta.gov.eg",
  ETA_CLIENT_ID: "cid",
  ETA_CLIENT_SECRET: "top-secret-value",
  ETA_SIGNER_URL: "https://signer.united.test/sign",
};
const API = "https://api.preprod.invoicing.eta.gov.eg";
const doc: EtaPreparedDocument = { internalID: "INV-1", json: '{"internalID":"INV-1","totalAmount":513.00000}' };

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const tok = (u: string) => u.endsWith("/connect/token");
const withToken = (h: (c: Call) => Response) => ({ url, init }: Call) => (tok(url) ? json(200, { access_token: "t", expires_in: 3600 }) : h({ url, init }));

test("configuration: missing variables are reported by name only; a missing one refuses with 503", () => {
  assert.deepEqual(etaConfigStatus({}).missing, [...ETA_ENV_VARS]);
  assert.ok(ETA_ENV_VARS.includes("ETA_ENV"), "the environment must be named explicitly");
  const s = etaConfigStatus(env);
  assert.equal(s.configured, true, JSON.stringify(s));
  assert.equal(JSON.stringify(s).includes("top-secret-value"), false);
  assert.throws(() => loadEtaConfig({ ...env, ETA_CLIENT_SECRET: "" }), (e: any) => e.status === 503 && !e.message.includes("cid") && e.message.includes("ETA_CLIENT_SECRET"));
  assert.equal(loadEtaConfig(env).apiBaseUrl, API);
});

test("environment guard: URLs must be the named environment's ETA hosts over https; fails closed", () => {
  const bad = (over: Record<string, string | undefined>, name: string) => {
    const s = etaConfigStatus({ ...env, ...over });
    assert.equal(s.configured, false, name);
    assert.ok(s.invalid.includes(name), `${name}: ${JSON.stringify(s)}`);
    assert.throws(() => loadEtaConfig({ ...env, ...over }), (e: any) => e.status === 503 && e.message.includes(name) && !e.message.includes("top-secret-value"));
  };
  bad({ ETA_ENV: "sandbox" }, "ETA_ENV");
  // Pre-production credentials pointed at production hosts (and the reverse).
  bad({ ETA_API_BASE_URL: "https://api.invoicing.eta.gov.eg" }, "ETA_API_BASE_URL");
  bad({ ETA_ID_SERVER_URL: "https://id.eta.gov.eg" }, "ETA_ID_SERVER_URL");
  bad({ ETA_ENV: "production", ETA_SIGNER_TOKEN: "s", ETA_SIGNER_CERT_SHA256: "AB".repeat(32) }, "ETA_API_BASE_URL");
  bad({ ETA_API_BASE_URL: "http://api.preprod.invoicing.eta.gov.eg" }, "ETA_API_BASE_URL");
  bad({ ETA_API_BASE_URL: "https://api.preprod.invoicing.eta.gov.eg.evil.test" }, "ETA_API_BASE_URL");
  bad({ ETA_API_BASE_URL: "https://user:pw@api.preprod.invoicing.eta.gov.eg" }, "ETA_API_BASE_URL");
  // The signing bridge: https, or http on this machine outside production only.
  bad({ ETA_SIGNER_URL: "http://signer.lan/sign" }, "ETA_SIGNER_URL");
  assert.equal(etaConfigStatus({ ...env, ETA_SIGNER_URL: "http://localhost:9000/sign" }).configured, true);
  const prod = { ETA_ENV: "production", ETA_API_BASE_URL: "https://api.invoicing.eta.gov.eg", ETA_ID_SERVER_URL: "https://id.eta.gov.eg" };
  // Production also requires the bridge token and the pinned e-seal certificate.
  bad(prod, "ETA_SIGNER_TOKEN");
  bad(prod, "ETA_SIGNER_CERT_SHA256");
  bad({ ...prod, ETA_SIGNER_TOKEN: "s", ETA_SIGNER_CERT_SHA256: "AB".repeat(32), ETA_SIGNER_URL: "http://localhost:9000/sign" }, "ETA_SIGNER_URL");
  bad({ ETA_SIGNER_CERT_SHA256: "not-a-fingerprint" }, "ETA_SIGNER_CERT_SHA256");
  const ok = loadEtaConfig({ ...env, ...prod, ETA_SIGNER_TOKEN: "s", ETA_SIGNER_CERT_SHA256: "AB".repeat(32) });
  assert.deepEqual([ok.environment, ok.signerCertSha256], ["production", "AB".repeat(32)]);
});

test("submit: client-credentials token, bearer auth, token cached, the exact signed text sent, accepted documents parsed", async () => {
  const { f, calls } = fakeFetch(({ url }) =>
    tok(url) ? json(200, { access_token: "tok-1", expires_in: 3600 }) : json(202, { submissionUUID: "S1", acceptedDocuments: [{ uuid: "U1", longId: "L1", internalId: "INV-1" }], rejectedDocuments: [] }));
  const gw = httpGateway(loadEtaConfig(env), f);
  const r1 = await gw.submit([doc]);
  await gw.submit([doc]);
  assert.deepEqual(r1.accepted, [{ uuid: "U1", longId: "L1", internalId: "INV-1", hashKey: null }]);
  assert.equal(r1.submissionId, "S1", "the SDK's submissionUUID");
  assert.equal(calls.filter((c) => tok(c.url)).length, 1, "token reused");
  const tokenBody = new URLSearchParams(String(calls[0].init.body));
  assert.deepEqual([tokenBody.get("grant_type"), tokenBody.get("client_id")], ["client_credentials", "cid"]);
  const submit = calls.find((c) => c.url === `${API}/api/v1.0/documentsubmissions/`)!;
  assert.equal((submit.init.headers as Record<string, string>).authorization, "Bearer tok-1");
  // Byte for byte: the 5-dp number text is not re-printed by JSON.stringify.
  assert.equal(String(submit.init.body), `{"documents":[${doc.json}]}`);
  // The older field name is still read.
  const legacy = httpGateway(loadEtaConfig(env), fakeFetch(withToken(() => json(202, { submissionId: "S0", acceptedDocuments: [], rejectedDocuments: [] }))).f);
  assert.equal((await legacy.submit([doc])).submissionId, "S0");
});

test("the OAuth token is reused across calls of the server process until it expires (ETA-10)", async () => {
  const { f, calls } = fakeFetch(({ url }) => (tok(url) ? json(200, { access_token: "tok", expires_in: 3600 }) : json(202, { submissionUUID: "S", acceptedDocuments: [], rejectedDocuments: [] })));
  const cfg = loadEtaConfig({ ...env, ETA_CLIENT_SECRET: "shared-1" });
  await sharedHttpGateway(cfg, f).submit([doc]);
  await sharedHttpGateway(cfg, f).submit([doc]);
  await sharedHttpGateway(loadEtaConfig({ ...env, ETA_CLIENT_SECRET: "shared-1" }), f).getDocument("U1").catch(() => null);
  assert.equal(calls.filter((c) => tok(c.url)).length, 1, "one token for three calls");
  assert.equal(sharedHttpGateway(cfg, f), sharedHttpGateway(cfg, f));
  // A rotated secret is a different gateway (and a new token).
  assert.notEqual(sharedHttpGateway(loadEtaConfig({ ...env, ETA_CLIENT_SECRET: "shared-2" }), f), sharedHttpGateway(cfg, f));
  // An expiring token is renewed a minute early.
  const short = fakeFetch(({ url }) => (tok(url) ? json(200, { access_token: "t", expires_in: 60 }) : json(202, { submissionUUID: "S", acceptedDocuments: [], rejectedDocuments: [] })));
  const gw = httpGateway(cfg, short.f);
  await gw.submit([doc]);
  await gw.submit([doc]);
  assert.equal(short.calls.filter((c) => tok(c.url)).length, 2);
});

test("failures: what may have reached ETA is never called a rejection", async () => {
  const login = httpGateway(loadEtaConfig(env), fakeFetch(() => json(401, { error: "invalid_client" })).f);
  await assert.rejects(login.submit([doc]), (e: any) => e instanceof EtaTransportError && e.reachedEta === false && !JSON.stringify(e.detail).includes("top-secret-value"));

  const s5 = httpGateway(loadEtaConfig(env), fakeFetch(withToken(() => json(503, {}))).f);
  await assert.rejects(s5.submit([doc]), (e: any) => e instanceof EtaTransportError && e.reachedEta === true);

  const drop = httpGateway(loadEtaConfig(env), fakeFetch(({ url }) => { if (tok(url)) return json(200, { access_token: "t", expires_in: 60 }); throw new Error("socket hang up"); }).f);
  await assert.rejects(drop.submit([doc]), (e: any) => e instanceof EtaTransportError && e.reachedEta === true);

  // 422 DuplicateSubmission: ETA holds an identical submission → may be registered (ETA-02).
  const dup = httpGateway(loadEtaConfig(env), fakeFetch(withToken(() => json(422, { error: { code: "DuplicateSubmission", message: "dup" } }, { "retry-after": "600" }))).f);
  await assert.rejects(dup.submit([doc]), (e: any) => e instanceof EtaTransportError && e.reachedEta === true && e.info.code === "DuplicateSubmission" && e.info.retryAfter === 600 && e.info.httpStatus === 422);
  // An undocumented 4xx is treated the same way (fail closed).
  const odd = httpGateway(loadEtaConfig(env), fakeFetch(withToken(() => json(409, {}))).f);
  await assert.rejects(odd.submit([doc]), (e: any) => e.reachedEta === true);

  // 401 on the API / 429: nothing processed — safe to retry; the token is dropped on 401.
  const { f: f401, calls } = fakeFetch(({ url }) => (tok(url) ? json(200, { access_token: "t", expires_in: 3600 }) : json(401, {})));
  const g401 = httpGateway(loadEtaConfig(env), f401);
  await assert.rejects(g401.submit([doc]), (e: any) => e.reachedEta === false && e.info.httpStatus === 401);
  await assert.rejects(g401.submit([doc]));
  assert.equal(calls.filter((c) => tok(c.url)).length, 2, "a refused token is not reused");
  const busy = httpGateway(loadEtaConfig(env), fakeFetch(withToken(() => json(429, {}, { "retry-after": "5" }))).f);
  await assert.rejects(busy.submit([doc]), (e: any) => e.reachedEta === false && e.info.retryAfter === 5);

  // 400 BadStructure / 403 IncorrectSubmitter: the whole submission refused, nothing registered.
  for (const status of [400, 403]) {
    const bad = httpGateway(loadEtaConfig(env), fakeFetch(withToken(() => json(status, { error: { code: status === 400 ? "BadStructure" : "IncorrectSubmitter" } }))).f);
    const r = await bad.submit([doc]);
    assert.deepEqual([r.accepted.length, r.rejected[0].internalId, (r.rejected[0].error as any).httpStatus], [0, "INV-1", status]);
  }
});

test("read paths: Get Submission, Search Documents by internalID (paged), Get Document Details", async () => {
  const { f, calls } = fakeFetch(withToken(({ url }) => {
    if (url.includes("/documentsubmissions/S1")) return json(200, { submissionUUID: "S1", overallStatus: "Valid", documentSummary: [{ uuid: "U1", longId: "L1", internalId: "INV-1", status: "Valid", total: 513, issuerId: "987654321" }] });
    if (url.includes("/documents/search") && !url.includes("continuationToken")) return json(200, { result: [{ uuid: "U1", submissionUUID: "S1", internalId: "INV-1", status: "Valid", total: 513 }], metadata: { continuationToken: "next" } });
    if (url.includes("/documents/search")) return json(200, { result: [{ uuid: "U2", internalId: "INV-1", status: "Invalid", total: 513 }], metadata: { continuationToken: "EndofResultSet" } });
    if (url.includes("/documents/U1/details")) return json(200, { submissionUUID: "S1", longId: "L1", status: "Valid", document: JSON.stringify({ internalID: "INV-1", totalAmount: 513, issuer: { id: "987654321" } }) });
    return json(404, {});
  }));
  const gw = httpGateway(loadEtaConfig(env), f);
  const sub = await gw.getSubmission("S1");
  assert.deepEqual([sub.overallStatus, sub.documents[0].uuid, sub.documents[0].internalId, sub.documents[0].total, sub.documents[0].submissionId], ["Valid", "U1", "INV-1", "513", "S1"]);
  assert.ok(calls.some((c) => c.url === `${API}/api/v1.0/documentsubmissions/S1?pageNo=1&pageSize=100`));

  const found = await gw.searchDocuments({ internalId: "INV-1", submittedFrom: new Date("2026-11-01T10:00:00.123Z"), submittedTo: new Date("2026-11-02T10:00:00Z") });
  assert.deepEqual(found.documents.map((d) => d.uuid), ["U1", "U2"]);
  const q = new URL(calls.find((c) => c.url.includes("/documents/search"))!.url).searchParams;
  assert.deepEqual([q.get("internalID"), q.get("submissionDateFrom"), q.get("submissionDateTo"), q.get("direction")], ["INV-1", "2026-11-01T10:00:00Z", "2026-11-02T10:00:00Z", "Sent"]);
  assert.equal(new URL(calls.filter((c) => c.url.includes("/documents/search"))[1].url).searchParams.get("continuationToken"), "next");

  const d = await gw.getDocument("U1");
  assert.deepEqual([d.uuid, d.internalId, d.total, d.issuerId, d.submissionId, d.status], ["U1", "INV-1", "513", "987654321", "S1", "Valid"]);
  await assert.rejects(gw.getDocument("NOPE"), (e: any) => e instanceof EtaTransportError && e.info.httpStatus === 404);
});

test("signer: sends the document with its canonical form and hash; refuses an empty answer (nothing reached ETA)", async () => {
  const ok = fakeFetch(() => json(200, { signatures: [{ signatureType: "I", value: "sig" }] }));
  const unsigned = { internalID: "INV-1" } as EtaDocumentV1;
  const signed = await externalSigner({ signerUrl: env.ETA_SIGNER_URL, signerToken: "st" }, ok.f).sign(unsigned, { serialized: '"INTERNALID""INV-1"', sha256: "abc" });
  assert.deepEqual(signed.signatures, [{ signatureType: "I", value: "sig" }]);
  assert.equal((ok.calls[0].init.headers as Record<string, string>).authorization, "Bearer st");
  assert.deepEqual(JSON.parse(String(ok.calls[0].init.body)), { document: unsigned, serialized: '"INTERNALID""INV-1"', sha256: "abc" });
  await assert.rejects(externalSigner({ signerUrl: env.ETA_SIGNER_URL, signerToken: null }, fakeFetch(() => json(200, {})).f).sign(unsigned), (e: any) => e.reachedEta === false);
});

test("no browser code imports the ETA configuration, gateway or service", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) {
        const src = readFileSync(p, "utf8");
        if (/^\s*["']use client["']/.test(src) && /lib\/eta\/(config|gateway|service|signature)/.test(src)) offenders.push(p);
      }
    }
  };
  walk("components");
  walk("app");
  assert.deepEqual(offenders, []);
});
