import { ApiError } from "@/lib/rbac";

/**
 * ETA credentials and endpoints — from the server environment only. Never hardcoded,
 * never defaulted (a wrong default URL would send real tax documents to the wrong
 * place), never returned by an API: callers get the NAMES of missing variables at most.
 *
 * Environment guard (fails closed): ETA_ENV must say which ETA environment this server
 * talks to, and both ETA URLs must be that environment's known https hosts — so a
 * pre-production client id can never be pointed at production (or the reverse) by a
 * copy-paste. The signing bridge must be https; plain http only on this machine
 * (localhost) and never in production. In production the bridge token and the pinned
 * e-seal certificate fingerprint are required as well.
 *
 * This module is server-only; nothing under components/ may import it.
 */

export const ETA_ENV_VARS = ["ETA_ENV", "ETA_API_BASE_URL", "ETA_ID_SERVER_URL", "ETA_CLIENT_ID", "ETA_CLIENT_SECRET", "ETA_SIGNER_URL"] as const;

export const ETA_ENVIRONMENTS = ["preprod", "production"] as const;
export type EtaEnvironment = (typeof ETA_ENVIRONMENTS)[number];

/**
 * The known ETA hosts per environment, as listed in the ETA SDK FAQ (sdk.invoicing.eta.gov.eg,
 * checked November 2026 — see the maturity research note). Still confirm against the ERP
 * registration e-mail before the first pre-production run; a change here is a reviewed
 * code change, never an environment variable.
 */
export const ETA_KNOWN_HOSTS: Record<EtaEnvironment, { api: string; id: string }> = {
  preprod: { api: "api.preprod.invoicing.eta.gov.eg", id: "id.preprod.eta.gov.eg" },
  production: { api: "api.invoicing.eta.gov.eg", id: "id.eta.gov.eg" },
};

export type EtaConfig = {
  environment: EtaEnvironment;
  apiBaseUrl: string;
  idServerUrl: string;
  clientId: string;
  clientSecret: string;
  signerUrl: string;
  signerToken: string | null;
  /** SHA-256 fingerprint of the e-seal certificate the bridge must sign with (optional in preprod). */
  signerCertSha256: string | null;
};

type Env = Record<string, string | undefined>;

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function url(v: string | undefined) {
  try {
    return v ? new URL(v.trim()) : null;
  } catch {
    return null;
  }
}

/** Names of variables that are set but unsafe or inconsistent (values never echoed). */
function invalidVars(env: Env): string[] {
  const bad = new Set<string>();
  const e = env.ETA_ENV?.trim();
  if (e && !ETA_ENVIRONMENTS.includes(e as EtaEnvironment)) bad.add("ETA_ENV");
  const known = ETA_KNOWN_HOSTS[e as EtaEnvironment];
  const api = url(env.ETA_API_BASE_URL);
  const id = url(env.ETA_ID_SERVER_URL);
  const signer = url(env.ETA_SIGNER_URL);
  if (env.ETA_API_BASE_URL?.trim() && (!api || api.protocol !== "https:" || (known && api.hostname !== known.api) || (!known && e))) bad.add("ETA_API_BASE_URL");
  if (env.ETA_ID_SERVER_URL?.trim() && (!id || id.protocol !== "https:" || (known && id.hostname !== known.id) || (!known && e))) bad.add("ETA_ID_SERVER_URL");
  if (api && (api.username || api.password)) bad.add("ETA_API_BASE_URL");
  if (id && (id.username || id.password)) bad.add("ETA_ID_SERVER_URL");
  if (env.ETA_SIGNER_URL?.trim()) {
    const plainLocal = signer?.protocol === "http:" && LOCAL.has(signer.hostname) && e !== "production";
    if (!signer || (signer.protocol !== "https:" && !plainLocal)) bad.add("ETA_SIGNER_URL");
  }
  if (e === "production") {
    if (!env.ETA_SIGNER_TOKEN?.trim()) bad.add("ETA_SIGNER_TOKEN");
    if (!env.ETA_SIGNER_CERT_SHA256?.trim()) bad.add("ETA_SIGNER_CERT_SHA256");
  }
  const fp = env.ETA_SIGNER_CERT_SHA256?.trim();
  if (fp && fp.replace(/[^0-9a-f]/gi, "").length !== 64) bad.add("ETA_SIGNER_CERT_SHA256");
  return [...bad];
}

export function etaConfigStatus(env: Env = process.env) {
  const missing = ETA_ENV_VARS.filter((k) => !env[k]?.trim());
  const invalid = invalidVars(env);
  return { configured: missing.length === 0 && invalid.length === 0, missing, invalid, environment: env.ETA_ENV?.trim() || null };
}

export function loadEtaConfig(env: Env = process.env): EtaConfig {
  const s = etaConfigStatus(env);
  if (s.missing.length) throw new ApiError(503, `الربط مع منظومة الفاتورة الإلكترونية مش متظبط على السيرفر (ناقص: ${s.missing.join("، ")})`);
  if (s.invalid.length) throw new ApiError(503, `إعداد الربط مع منظومة الفاتورة الإلكترونية مش متسق مع البيئة (راجع: ${s.invalid.join("، ")})`);
  return {
    environment: s.environment as EtaEnvironment,
    apiBaseUrl: env.ETA_API_BASE_URL!.trim().replace(/\/+$/, ""),
    idServerUrl: env.ETA_ID_SERVER_URL!.trim().replace(/\/+$/, ""),
    clientId: env.ETA_CLIENT_ID!.trim(),
    clientSecret: env.ETA_CLIENT_SECRET!.trim(),
    signerUrl: env.ETA_SIGNER_URL!.trim(),
    signerToken: env.ETA_SIGNER_TOKEN?.trim() || null,
    signerCertSha256: env.ETA_SIGNER_CERT_SHA256?.trim() || null,
  };
}
