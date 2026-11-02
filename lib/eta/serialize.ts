import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import type { EtaDocumentV1 } from "./types";

/**
 * ETA canonical serialization (https://sdk.invoicing.eta.gov.eg/document-serialization-approach/).
 * Pure: no database, no clock, no network.
 *
 * ETA hashes (SHA-256) and the issuer signs a canonical form of the document, not its JSON:
 *   - recursive from the document object (not the submission envelope);
 *   - every property name upper-cased and wrapped in double quotes;
 *   - every simple value wrapped in double quotes and kept EXACTLY as written in the JSON
 *     text ("947.00" stays "947.00", never "947");
 *   - an array is announced by its name once, then each element is preceded by the
 *     array's name again ("TAXABLEITEMS""TAXABLEITEMS"{…}"TAXABLEITEMS"{…}).
 *
 * "Exactly as written" is why this works on the JSON TEXT and never on a parsed object:
 * a parsed number has already lost its lexical form. The app therefore writes the JSON
 * text itself (`etaJson`), serializes that same text for the hash/signature, and sends
 * those same bytes (plus the signatures) to ETA.
 *
 * Checked against the SDK's published sample (tests/fixtures/eta/sdk-one-doc*.{json,txt}).
 */

type Cursor = { s: string; i: number };

const fail = (c: Cursor, what: string): never => {
  throw new Error(`ETA serialization: ${what} at offset ${c.i}`);
};

function ws(c: Cursor) {
  while (c.i < c.s.length && " \t\n\r".includes(c.s[c.i])) c.i++;
}

/** The raw text of a JSON string between its quotes (escapes left as written). */
function rawString(c: Cursor): string {
  if (c.s[c.i] !== '"') fail(c, "expected a string");
  const start = ++c.i;
  while (c.i < c.s.length && c.s[c.i] !== '"') c.i += c.s[c.i] === "\\" ? 2 : 1;
  if (c.i >= c.s.length) fail(c, "unterminated string");
  return c.s.slice(start, c.i++);
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function rawScalar(c: Cursor): string {
  if (c.s[c.i] === '"') return rawString(c);
  for (const lit of ["true", "false", "null"]) {
    if (c.s.startsWith(lit, c.i)) {
      c.i += lit.length;
      return lit;
    }
  }
  NUMBER.lastIndex = c.i;
  const m = NUMBER.exec(c.s);
  if (!m) return fail(c, "unexpected token");
  c.i += m[0].length;
  return m[0];
}

function value(c: Cursor): string {
  ws(c);
  if (c.s[c.i] === "{") return object(c);
  if (c.s[c.i] === "[") return fail(c, "an array may only appear as a named property");
  return `"${rawScalar(c)}"`;
}

function object(c: Cursor): string {
  c.i++; // {
  let out = "";
  ws(c);
  if (c.s[c.i] === "}") {
    c.i++;
    return out;
  }
  for (;;) {
    ws(c);
    const name = `"${rawString(c).toUpperCase()}"`;
    ws(c);
    if (c.s[c.i++] !== ":") fail(c, "expected ':'");
    ws(c);
    if (c.s[c.i] === "[") {
      c.i++;
      out += name;
      ws(c);
      if (c.s[c.i] === "]") c.i++;
      else
        for (;;) {
          out += name + value(c);
          ws(c);
          const sep = c.s[c.i++];
          if (sep === "]") break;
          if (sep !== ",") fail(c, "expected ',' or ']'");
        }
    } else out += name + value(c);
    ws(c);
    const sep = c.s[c.i++];
    if (sep === "}") return out;
    if (sep !== ",") fail(c, "expected ',' or '}'");
  }
}

/** The canonical form ETA hashes, from the document's JSON text. */
export function canonicalSerialize(jsonText: string): string {
  const c: Cursor = { s: jsonText, i: 0 };
  ws(c);
  if (c.s[c.i] !== "{") fail(c, "the document must be a JSON object");
  const out = object(c);
  ws(c);
  if (c.i !== c.s.length) fail(c, "trailing content");
  return out;
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** ETA's document hash: SHA-256 over the UTF-8 canonical form. */
export const etaDocumentHash = (jsonText: string) => sha256Hex(canonicalSerialize(jsonText));

/**
 * ETA amounts carry at most 5 decimals. Every number is written with exactly 5, from its
 * decimal value, so the text, the canonical form and the hash never depend on how
 * JavaScript happens to print a float ("513" vs "513.00000" is decided here, once).
 */
const n5text = (n: number) => {
  if (!Number.isFinite(n)) throw new Error(`ETA serialization: non-finite number ${n}`);
  return new Prisma.Decimal(n).toDecimalPlaces(5, Prisma.Decimal.ROUND_HALF_UP).toFixed(5);
};

function write(v: unknown): string {
  if (v === null) throw new Error("ETA serialization: null is never sent (omit the field)");
  if (typeof v === "number") return n5text(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(write).join(",")}]`;
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}:${write(x)}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`ETA serialization: unsupported value ${typeof v}`);
}

/** The exact JSON text of an ETA document (property order as built by the mapper). */
export function etaJson(document: EtaDocumentV1 | Record<string, unknown>): string {
  return write(document);
}

/**
 * Strings whose canonical form is not settled by the SDK: a quote, a backslash or a
 * control character is written escaped in JSON, and the SDK does not say whether ETA
 * hashes the escaped or the decoded form. Such a document is refused before signing
 * rather than risk an "invalid" signature on an immutable invoice.
 */
export function unsettledStrings(document: unknown, path = ""): string[] {
  if (typeof document === "string") return /["\\\u0000-\u001f]/.test(document) ? [path || "(root)"] : [];
  if (Array.isArray(document)) return document.flatMap((x, i) => unsettledStrings(x, `${path}[${i}]`));
  if (document && typeof document === "object") return Object.entries(document).flatMap(([k, x]) => unsettledStrings(x, path ? `${path}.${k}` : k));
  return [];
}
