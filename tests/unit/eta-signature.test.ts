/* What the signing bridge returns is checked before anything goes to ETA: one issuer
   signature, base64 CMS signedData, CAdES-BES attributes, made over THIS document's canonical
   form, verifying with its certificate, the certificate valid now and — when configured —
   the pinned e-seal certificate.

   Fixture: a TEST-ONLY self-signed seal (tests/fixtures/eta/test-seal-cert.pem; its private
   key was never committed) signed the canonical form '"ISSUER""TYPE""B"' with
   `openssl cms -sign -binary -cades -md sha256` (detached). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { checkCades, checkEtaSignatures } from "../../lib/eta/signature";
import { canonicalSerialize } from "../../lib/eta/serialize";

const FIX = join(__dirname, "../fixtures/eta");
const value = readFileSync(join(FIX, "test-seal-cades.b64"), "utf8").trim();
const cert = new X509Certificate(readFileSync(join(FIX, "test-seal-cert.pem")));
const serialized = canonicalSerialize('{"issuer":{"type":"B"}}');
const now = new Date(new Date(cert.validFrom).getTime() + 86_400_000);

test("a real CAdES-BES signature over this document's canonical form passes, with the signer certificate reported", () => {
  const r = checkEtaSignatures([{ signatureType: "I", value }], serialized, { now });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.certificate?.fingerprint256, cert.fingerprint256);
  assert.equal(r.certificate?.serialNumber, cert.serialNumber);
  // Pinned to that exact certificate (any fingerprint notation).
  assert.equal(checkEtaSignatures([{ signatureType: "I", value }], serialized, { now, certSha256: cert.fingerprint256.replace(/:/g, "").toLowerCase() }).ok, true);
});

test("a signature made over a different document is refused (messageDigest mismatch)", () => {
  const r = checkCades(value, canonicalSerialize('{"issuer":{"type":"P"}}'), { now });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problems.some((p) => /different document/.test(p)), JSON.stringify(r));
});

test("a tampered signature does not verify", () => {
  const der = Buffer.from(value, "base64");
  der[der.length - 10] ^= 0xff; // inside the RSA signature octets
  const r = checkCades(der.toString("base64"), serialized, { now });
  assert.ok(!r.ok && r.problems.some((p) => /does not verify/.test(p)), JSON.stringify(r));
});

test("a different pinned certificate, or a certificate outside its validity, is refused", () => {
  const pinned = checkCades(value, serialized, { now, certSha256: "AA".repeat(32) });
  assert.ok(!pinned.ok && pinned.problems.some((p) => /ETA_SIGNER_CERT_SHA256/.test(p)));
  const early = checkCades(value, serialized, { now: new Date(new Date(cert.validFrom).getTime() - 86_400_000) });
  assert.ok(!early.ok && early.problems.some((p) => /not valid now/.test(p)));
});

test("structural refusals: no issuer signature, wrong type, empty, not base64, not CMS", () => {
  const bad = (sigs: unknown, re: RegExp) => {
    const r = checkEtaSignatures(sigs, serialized, { now });
    assert.ok(!r.ok && r.problems.some((p) => re.test(p)), JSON.stringify(r));
  };
  bad([], /no signatures/);
  bad(null, /no signatures/);
  bad([{ signatureType: "S", value }], /one issuer signature/);
  bad([{ signatureType: "I", value }, { signatureType: "I", value }], /one issuer signature/);
  bad([{ signatureType: "X", value }], /unexpected signature type/);
  bad([{ signatureType: "I", value: "" }], /empty signature/);
  bad([{ signatureType: "I", value: "sig" }], /not base64/);
  bad([{ signatureType: "I", value: "fake" }], /not valid DER|not a single DER|not a CMS/);
  bad([{ signatureType: "I", value: Buffer.from("hello world!").toString("base64") }], /DER|CMS/);
});
