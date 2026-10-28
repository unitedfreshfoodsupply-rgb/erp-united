import { NextRequest } from "next/server";
import { ApiError } from "@/lib/rbac";

/**
 * A parsed JSON request body. Values stay loosely typed on purpose: every route reads
 * fields from it through the validators below (`optionalText`, `parseKg`, …), which do
 * the runtime checks; typing them as `unknown` would only move casts into 100+ routes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonBody = Record<string, any>;

/**
 * Reads a JSON request body, or fails with 400.
 *
 * `req.json()` throws a SyntaxError on a malformed or empty body, which the route's
 * catch-all turned into a 500 "server error" — telling an integration that retrying
 * might help, when the request itself is wrong. A body that is not a JSON object is
 * refused the same way: every endpoint here takes named fields.
 */
export async function readJson(req: NextRequest): Promise<JsonBody> {
  let body: unknown;
  const loc = req.headers.get("accept-language") === "en" ? "en" : "ar";
  try {
    body = await req.json();
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
  return body as JsonBody;
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
