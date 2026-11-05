import { NextRequest } from "next/server";
import { normalizeNumerals } from "@/lib/numerals";
import { ApiError } from "@/lib/rbac";

/**
 * A parsed JSON request body. Values stay loosely typed on purpose: every route reads
 * fields from it through the validators below (`optionalText`, `parseKg`, …), which do
 * the runtime checks; typing them as `unknown` would only move casts into 100+ routes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonBody = Record<string, any>;

/**
 * The largest JSON body an endpoint reads unless it says otherwise (SEC-3, Nov 2026). Far
 * above what the screens send — the biggest batches the schemas allow (an opening-balance
 * sheet of 5,000 rows, 2,000 batch lines, 1,000 attendance events) stay under it even with
 * long names — yet small enough that a flood of huge bodies cannot fill the server's memory.
 */
export const JSON_BODY_LIMIT = 4_000_000;

/** "4 ميجا" / "16 KB": the limit as people say it, for the 413 message. */
function sizeLabel(bytes: number, loc: "ar" | "en") {
  if (bytes >= 1_000_000) return `${Number((bytes / 1_000_000).toFixed(1))} ${loc === "en" ? "MB" : "ميجا"}`;
  return `${Math.ceil(bytes / 1024)} ${loc === "en" ? "KB" : "كيلوبايت"}`;
}

/**
 * Reads a JSON request body, or fails with 400 (413 when it is larger than `maxBytes`).
 *
 * `req.json()` throws a SyntaxError on a malformed or empty body, which the route's
 * catch-all turned into a 500 "server error" — telling an integration that retrying
 * might help, when the request itself is wrong. A body that is not a JSON object is
 * refused the same way: every endpoint here takes named fields.
 *
 * The body is read with a real streaming limit (readLimitedBody), not `req.json()`, which
 * buffered whatever arrived: a declared Content-Length over the limit is refused before
 * reading, and a body without one stops at the limit.
 */
export async function readJson(req: NextRequest, maxBytes: number = JSON_BODY_LIMIT): Promise<JsonBody> {
  let body: unknown;
  const loc = req.headers.get("accept-language") === "en" ? "en" : "ar";
  const tooLarge = loc === "en" ? `The request is larger than the allowed size (${sizeLabel(maxBytes, loc)})` : `حجم الطلب أكبر من الحد المسموح (${sizeLabel(maxBytes, loc)})`;
  if (Number(req.headers.get("content-length")) > maxBytes) throw new ApiError(413, tooLarge);
  const bytes = await readLimitedBody(req, maxBytes, tooLarge);
  try {
    // UTF-8 with a leading BOM dropped, as req.json() decoded it.
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, loc === "en" ? "Request body is not valid JSON" : "جسم الطلب مش JSON صالح");
  }
  return jsonObject(body);
}

/** Read an upload body with an actual streaming limit, even when Content-Length is
 * missing or false. */
export async function readLimitedBody(req: NextRequest, maxBytes: number, label?: string): Promise<Uint8Array> {
  const loc = req.headers.get("accept-language") === "en" ? "en" : "ar";
  const defaultLabel = loc === "en" ? "Request body exceeds the size limit" : "حجم الطلب أكبر من الحد المسموح";
  const labelText = label ?? defaultLabel;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, labelText);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, loc === "en" ? "Failed to read request body" : "تعذر قراءة جسم الطلب");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * A multipart form read under `maxBytes` — a declared Content-Length over it is refused
 * before reading, an undeclared body stops at it (413 `tooLarge`) — then parsed; 400
 * `notAForm` when it is not one. `req.formData()` would buffer the whole upload first.
 */
export async function readFormLimited(req: NextRequest, maxBytes: number, tooLarge: string, notAForm: string): Promise<FormData> {
  if (Number(req.headers.get("content-length")) > maxBytes) throw new ApiError(413, tooLarge);
  const bytes = await readLimitedBody(req, maxBytes, tooLarge);
  try {
    // readLimitedBody's bytes own their whole ArrayBuffer.
    return await new Request(req.url, { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: bytes as Uint8Array<ArrayBuffer> }).formData();
  } catch {
    throw new ApiError(400, notAForm);
  }
}

export async function readJsonLimited(req: NextRequest, maxBytes: number): Promise<JsonBody> {
  let body: unknown;
  try {
    const bytes = await readLimitedBody(req, maxBytes, "جسم ملف الاستيراد أكبر من 2 ميجابايت");
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "جسم الطلب مش JSON صالح");
  }
  return jsonObject(body);
}

function jsonObject(body: unknown): JsonBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "جسم الطلب لازم يكون كائن JSON");
  }
  if (hasNul(body)) throw new ApiError(400, "النص فيه حرف غير مسموح (NUL)");
  // I18N-02: a number typed with Arabic-Indic digits means the same number.
  return normalizeNumerals(body) as JsonBody;
}

/**
 * A client-supplied text field: undefined/null stay absent, a string passes through,
 * anything else (a number, an object, an array) is a 400 — not a TypeError on `.trim()`
 * that the catch-all would report as a server error.
 */
export function asText(value: unknown, label = "حقل نصي"): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ApiError(400, `${label}: لازم يكون نص`);
  return value;
}

/** PostgreSQL text can't hold U+0000; refuse it at the door rather than fail at the insert. */
function hasNul(v: unknown, depth = 0): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (depth > 20 || v === null || typeof v !== "object") return false;
  for (const [k, x] of Object.entries(v)) if (k.includes("\u0000") || hasNul(x, depth + 1)) return true;
  return false;
}
