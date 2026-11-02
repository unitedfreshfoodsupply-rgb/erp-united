import { createHash, verify as cryptoVerify, X509Certificate } from "crypto";

/**
 * Checks on what the external signing bridge returns, BEFORE anything is sent to ETA.
 * The e-seal lives next to the bridge, never in this app; the app only refuses a
 * signature that cannot be the one ETA expects, so a broken or wrong bridge produces a
 * `failed` attempt (nothing sent, safe to retry) instead of an "invalid" ETA document on
 * an immutable invoice.
 *
 * Checked here (CMS / CAdES-BES, RFC 5652 + ETSI EN 319 122):
 *   - exactly one issuer signature (type "I"); every entry typed "I" or "S";
 *   - the value is strict base64 of a DER CMS ContentInfo of type signedData;
 *   - it carries the signer certificate, the signed attributes messageDigest (= SHA-256 of
 *     the canonical document this app serialized) and signingCertificateV2 (CAdES-BES);
 *   - the signature over the signed attributes verifies with the certificate's public key;
 *   - the certificate is within its validity period now;
 *   - when ETA_SIGNER_CERT_SHA256 is configured, the certificate is that exact certificate.
 *
 * NOT checked here (needs the real e-seal and ETA): the certificate chain up to the Egyptian
 * root / ITIDA-licensed CA, revocation, and that ETA itself accepts the signature.
 */

export type EtaSignature = { signatureType: string; value: string };
export type SignerCertificate = { subject: string; issuer: string; serialNumber: string; fingerprint256: string; validFrom: string; validTo: string };
export type SignatureCheck = { ok: true; certificate: SignerCertificate } | { ok: false; problems: string[]; certificate?: SignerCertificate };

// ---------------------------------------------------------------------------
// Minimal DER reader (definite lengths only, which DER requires)
// ---------------------------------------------------------------------------

type Tlv = { tag: number; start: number; header: number; len: number; end: number; buf: Buffer };

function tlv(buf: Buffer, at: number): Tlv {
  if (at + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[at];
  if ((tag & 0x1f) === 0x1f) throw new Error("high tag numbers are not used in CMS");
  let len = buf[at + 1];
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("unsupported DER length");
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[at + 2 + k];
    header += n;
  }
  const end = at + header + len;
  if (end > buf.length) throw new Error("truncated DER");
  return { tag, start: at, header, len, end, buf };
}

function children(t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = t.start + t.header; at < t.end; ) {
    const c = tlv(t.buf, at);
    out.push(c);
    at = c.end;
  }
  return out;
}

const content = (t: Tlv) => t.buf.subarray(t.start + t.header, t.end);
const whole = (t: Tlv) => t.buf.subarray(t.start, t.end);
const oidHex = (t: Tlv) => (t.tag === 0x06 ? content(t).toString("hex") : null);

const OID = {
  signedData: "2a864886f70d010702", // 1.2.840.113549.1.7.2
  messageDigest: "2a864886f70d010904", // 1.2.840.113549.1.9.4
  signingCertificateV2: "2a864886f70d010910022f", // 1.2.840.113549.1.9.16.2.47
  sha256: "608648016503040201", // 2.16.840.1.101.3.4.2.1
  sha384: "608648016503040202",
  sha512: "608648016503040203",
};
const DIGEST: Record<string, string> = { [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const normFp = (s: string) => s.replace(/[^0-9a-f]/gi, "").toUpperCase();

function describe(c: X509Certificate): SignerCertificate {
  return { subject: c.subject, issuer: c.issuer, serialNumber: c.serialNumber, fingerprint256: c.fingerprint256, validFrom: c.validFrom, validTo: c.validTo };
}

/** Verifies one CAdES value against the canonical document text that was signed. */
export function checkCades(value: string, serialized: string, opts: { certSha256?: string | null; now?: Date } = {}): SignatureCheck {
  const problems: string[] = [];
  if (!value || !BASE64.test(value)) return { ok: false, problems: ["the signature value is not base64"] };
  const der = Buffer.from(value, "base64");
  let certificate: SignerCertificate | undefined;
  try {
    const ci = tlv(der, 0);
    if (ci.tag !== 0x30 || ci.end !== der.length) return { ok: false, problems: ["the signature is not a single DER structure"] };
    const [type, explicit] = children(ci);
    if (!type || oidHex(type) !== OID.signedData || explicit?.tag !== 0xa0) return { ok: false, problems: ["the signature is not a CMS signedData"] };
    const sd = children(explicit)[0];
    const parts = sd && sd.tag === 0x30 ? children(sd) : [];
    const certsTlv = parts.find((p) => p.tag === 0xa0);
    const signerInfos = parts[parts.length - 1];
    if (!certsTlv) return { ok: false, problems: ["the signature carries no signer certificate"] };
    if (!signerInfos || signerInfos.tag !== 0x31) return { ok: false, problems: ["the signature has no signer"] };
    const infos = children(signerInfos);
    if (infos.length !== 1) return { ok: false, problems: [`expected one signer, found ${infos.length}`] };
    const si = children(infos[0]);
    // SignerInfo: version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature
    const [, sid, digestAlg] = si;
    const signedAttrs = si.find((p) => p.tag === 0xa0);
    const signature = si.find((p) => p.tag === 0x04);
    if (!sid || !digestAlg || !signedAttrs || !signature) return { ok: false, problems: ["the signer info is incomplete (no signed attributes: not CAdES-BES)"] };

    const certs = children(certsTlv).filter((c) => c.tag === 0x30).map((c) => new X509Certificate(whole(c)));
    // The signer is named by issuer + serial number; match the serial to pick its certificate.
    let signerCert = certs[0];
    if (sid.tag === 0x30) {
      const serial = children(sid)[1];
      const hex = serial ? content(serial).toString("hex").replace(/^(00)+(?=.)/, "").toUpperCase() : "";
      signerCert = certs.find((c) => c.serialNumber.replace(/^0+(?=.)/, "").toUpperCase() === hex.replace(/^0+(?=.)/, "")) ?? signerCert;
    }
    if (!signerCert) return { ok: false, problems: ["the signer certificate is missing"] };
    certificate = describe(signerCert);

    const digestName = DIGEST[oidHex(children(digestAlg)[0]) ?? ""];
    if (!digestName) problems.push("unsupported digest algorithm (SHA-256 expected)");

    // Signed attributes: messageDigest must be the hash of what this app serialized.
    const attrs = children(signedAttrs).map((a) => {
      const [t, set] = children(a);
      return { oid: oidHex(t), values: set ? children(set) : [] };
    });
    const md = attrs.find((a) => a.oid === OID.messageDigest)?.values[0];
    if (!md || md.tag !== 0x04) problems.push("no messageDigest signed attribute");
    else if (digestName && !content(md).equals(createHash(digestName).update(serialized, "utf8").digest())) problems.push("the signature was made over a different document (messageDigest ≠ hash of the canonical document)");
    if (!attrs.some((a) => a.oid === OID.signingCertificateV2)) problems.push("no signingCertificateV2 attribute (not CAdES-BES)");

    // The signature covers the DER of the signed attributes as a SET (tag 0x31).
    if (digestName) {
      const signedBytes = Buffer.concat([Buffer.from([0x31]), whole(signedAttrs).subarray(1)]);
      let good = false;
      try {
        good = cryptoVerify(digestName, signedBytes, signerCert.publicKey, content(signature));
      } catch {
        good = false;
      }
      if (!good) problems.push("the signature does not verify with the signer certificate");
    }

    const now = opts.now ?? new Date();
    if (now < new Date(signerCert.validFrom) || now > new Date(signerCert.validTo)) problems.push(`the signer certificate is not valid now (${signerCert.validFrom} – ${signerCert.validTo})`);
    if (opts.certSha256 && normFp(opts.certSha256) !== normFp(signerCert.fingerprint256)) problems.push("the signer certificate is not the configured e-seal certificate (ETA_SIGNER_CERT_SHA256)");
  } catch (e) {
    return { ok: false, problems: [`the signature is not valid DER/CMS: ${(e as Error).message}`], certificate };
  }
  return problems.length ? { ok: false, problems, certificate } : { ok: true, certificate: certificate! };
}

/** The bridge's answer as a whole: one issuer signature, every entry well-formed. */
export function checkEtaSignatures(signatures: unknown, serialized: string, opts: { certSha256?: string | null; now?: Date } = {}): SignatureCheck {
  if (!Array.isArray(signatures) || signatures.length === 0) return { ok: false, problems: ["no signatures"] };
  const problems: string[] = [];
  for (const s of signatures as EtaSignature[]) {
    if (!s || typeof s !== "object" || !["I", "S"].includes(s.signatureType)) problems.push(`unexpected signature type ${JSON.stringify((s as EtaSignature)?.signatureType)}`);
    if (typeof s?.value !== "string" || !s.value.trim()) problems.push("an empty signature value");
  }
  const issuer = (signatures as EtaSignature[]).filter((s) => s?.signatureType === "I");
  if (issuer.length !== 1) problems.push(`expected one issuer signature (type I), found ${issuer.length}`);
  if (problems.length) return { ok: false, problems };
  return checkCades(issuer[0].value, serialized, opts);
}
