/**
 * Server-side locale detection from an incoming NextRequest.
 *
 * Reads `accept-language` header set by the client (see lib/api-client.ts)
 * and returns the resolved locale. Backward-compatible: when no header is
 * present, defaults to "ar" (existing behaviour).
 */
import { type NextRequest } from "next/server";
import { type Locale } from "./context";


export function getLocale(req: NextRequest): Locale {
  const header = req.headers.get("accept-language");
  if (header === "en") return "en";
  return "ar";
}

/**
 * Convenience: get locale from a ReadonlyRequestHeaders-like object (used in
 * server components / route handlers that don't have the full NextRequest).
 */
export function getLocaleFromHeaders(headers: { get(name: string): string | null }): Locale {
  const h = headers.get("accept-language");
  if (h === "en") return "en";
  return "ar";
}

/**
 * Wrap a user-facing error message so it can be returned in either language.
 * The caller provides both versions; the locale-aware resolver picks one.
 *
 * Usage in route handlers:
 *   import { tError } from "@/lib/locale/server";
 *   return Response.json({ error: tError(req, "هذا الحقل إجباري", "This field is required") }, { status: 400 });
 */
export function tError(reqOrHeaders: NextRequest | { get(name: string): string | null }, ar: string, en: string): string {
  const locale = "get" in reqOrHeaders
    ? getLocaleFromHeaders(reqOrHeaders)
    : getLocale(reqOrHeaders as NextRequest);
  return locale === "en" ? en : ar;
}