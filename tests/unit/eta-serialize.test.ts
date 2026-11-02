/* ETA canonical serialization: the SDK's own published sample serializes byte for byte;
   values keep their lexical form; the JSON text the app writes, the text it hashes and the
   text it sends are the same text. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSerialize, etaDocumentHash, etaJson, sha256Hex, unsettledStrings } from "../../lib/eta/serialize";
import { mapInvoiceToEta } from "../../lib/eta/mapper";
import type { EtaSource } from "../../lib/eta/types";

const FIX = join(__dirname, "../fixtures/eta");

test("the SDK's published sample document serializes exactly to the SDK's published canonical form", () => {
  // https://sdk.invoicing.eta.gov.eg/files/one-doc.json and one-doc-serialized.json.txt
  const json = readFileSync(join(FIX, "sdk-one-doc.json"), "utf8");
  const expected = readFileSync(join(FIX, "sdk-one-doc-serialized.txt"), "utf8");
  assert.equal(canonicalSerialize(json), expected);
  assert.equal(etaDocumentHash(json), sha256Hex(expected));
});

test("values are kept exactly as written; names upper-cased; arrays repeat their name per element", () => {
  assert.equal(canonicalSerialize('{"a":0.0,"b":"x y","c":947.00}'), '"A""0.0""B""x y""C""947.00"');
  assert.equal(canonicalSerialize('{ "taxableItems" : [ {"rate":14}, {"rate":0.00} ], "x":{"y":"1"} }'), '"TAXABLEITEMS""TAXABLEITEMS""RATE""14""TAXABLEITEMS""RATE""0.00""X""Y""1"');
  assert.equal(canonicalSerialize('{"refs":[],"e":{}}'), '"REFS""E"');
  assert.equal(canonicalSerialize('{"references":["U1","U2"]}'), '"REFERENCES""REFERENCES""U1""REFERENCES""U2"');
  // Arabic text is UTF-8 in the hash, as written.
  assert.equal(canonicalSerialize('{"name":"فندق النيل"}'), '"NAME""فندق النيل"');
});

test("malformed or non-document JSON is refused, never guessed", () => {
  for (const bad of ["[1]", '{"a":1', '{"a":[[1]]}', '{"a":1} x', '"s"', '{"a":01}']) assert.throws(() => canonicalSerialize(bad), /ETA serialization/, bad);
});

test("the app's JSON text writes every number with exactly 5 decimals, so text, hash and bytes sent agree", () => {
  const text = etaJson({ issuer: { id: "1" }, amount: 513, rate: 14, small: 0.1 + 0.2, list: [{ q: 3.333 }], skipped: undefined } as never);
  assert.equal(text, '{"issuer":{"id":"1"},"amount":513.00000,"rate":14.00000,"small":0.30000,"list":[{"q":3.33300}]}');
  assert.equal(canonicalSerialize(text), '"ISSUER""ID""1""AMOUNT""513.00000""RATE""14.00000""SMALL""0.30000""LIST""LIST""Q""3.33300"');
  assert.deepEqual(JSON.parse(text).amount, 513);
  assert.throws(() => etaJson({ a: null } as never), /null/);
  assert.throws(() => etaJson({ a: Number.NaN } as never), /non-finite/);
});

test("a mapped UNITED invoice round-trips: its JSON text parses back to the same document", () => {
  const address = { country: "EG", governate: "Cairo", regionCity: "Nasr City", street: "St", buildingNumber: "1", postalCode: null, floor: null, room: null, landmark: null, additionalInformation: null };
  const src: EtaSource = {
    kind: "sales_invoice",
    invoice: { id: "i", number: "INV-1", status: "issued", issuedAt: "2026-10-08T09:30:15.123Z", currencyCode: "EGP", buyerName: "Hotel", buyerTaxId: "123456789", gross: "500", discountTotal: "0", net: "500", taxTotal: "0", total: "500", orderNumber: null },
    issuer: { name: "UNITED", registrationNumber: "987654321", etaBranchId: "0", activityCode: "4630", address },
    receiver: { type: null, personalId: null, address },
    lines: [{ lineNo: 1, description: "Mango", productId: "p", internalCode: "M", itemType: "EGS", itemCode: "EG-1", uomCode: "KG", etaUnitType: "KGM", quantity: "10", unitPrice: "50", discountPct: "0", gross: "500", discount: "0", net: "500", taxCode: "EXEMPT", taxRate: "0", etaTaxType: "T1", etaTaxSubtype: "V003", tax: "0", total: "500" }],
    personIdThreshold: 50000,
  };
  const doc = mapInvoiceToEta(src);
  const text = etaJson(doc);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(doc)));
  assert.match(canonicalSerialize(text), /^"ISSUER""TYPE""B""ID""987654321""NAME""UNITED""ADDRESS""BRANCHID""0"/);
  assert.match(canonicalSerialize(text), /"SALESTOTAL""500\.00000"/);
});

test("strings whose canonical form the SDK leaves open (quotes, backslashes, control characters) are reported", () => {
  assert.deepEqual(unsettledStrings({ a: "ok", b: { c: 'say "hi"' }, d: ["x", "a\\b"], e: 1 }), ["b.c", "d[1]"]);
  assert.deepEqual(unsettledStrings({ name: "فندق النيل - Nile (Zamalek)" }), []);
});
