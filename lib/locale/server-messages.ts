import { SERVER_MESSAGES } from "./server-messages.data";

/**
 * Server and import messages in the request's language.
 *
 * Services throw their messages in Arabic (the business default) and most are built
 * at module load, so a locale cannot be threaded through them. Instead the response
 * boundary — handleApiError, the import route — translates the finished message:
 *
 *   1. an exact catalog match;
 *   2. a template ("الرصيد مش كفاية: \"{}\" في {}…"): the values in the slots (codes,
 *      quantities, names) are carried into the English unchanged, and a slot that is
 *      itself an Arabic message or field label is translated the same way;
 *   3. otherwise the Arabic is returned as-is — never a generic replacement, so the
 *      specific detail is never lost.
 *
 * Arabic responses are untouched, so existing clients and API contracts see no change.
 */

export type MessageLocale = "ar" | "en";

const ARABIC = /[؀-ۿ]/;
const MAX_DEPTH = 4;

type Pattern = { re: RegExp; en: string; strict: boolean };

let exact: Map<string, string> | null = null;
let patterns: Pattern[] | null = null;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function load() {
  if (exact && patterns) return;
  exact = new Map();
  const list: (Pattern & { weight: number })[] = [];
  for (const [rawAr, rawEn] of SERVER_MESSAGES) {
    const ar = rawAr.trim();
    const en = rawEn.trim();
    if (!ar.includes("{}")) {
      exact.set(ar, en);
      continue;
    }
    const parts = ar.split("{}");
    const literal = parts.join("").trim();
    list.push({
      re: new RegExp(`^${parts.map(escapeRe).join("([\\s\\S]*?)")}$`),
      en,
      // A template that is almost all slots ("{} مطلوب") would match nearly anything;
      // it only counts when every slot translated, so it cannot produce half-English.
      strict: literal.replace(/[^؀-ۿ]/g, "").length < 12,
      weight: literal.length,
    });
  }
  // Most specific first: the longest fixed text wins over a looser template.
  list.sort((a, b) => b.weight - a.weight);
  patterns = list;
}

function translate(message: string, depth: number): string | null {
  if (!ARABIC.test(message)) return message;
  load();
  const trimmed = message.trim();
  const hit = exact!.get(trimmed);
  if (hit !== undefined) return message.replace(trimmed, hit);
  if (depth >= MAX_DEPTH) return null;
  for (const p of patterns!) {
    const m = p.re.exec(trimmed);
    if (!m) continue;
    const slots = m.slice(1).map((value) => translate(value, depth + 1) ?? value);
    if (p.strict && slots.some((s) => ARABIC.test(s))) continue;
    return message.replace(trimmed, p.en.replace(/\{(\d+)\}/g, (_, i: string) => slots[Number(i)] ?? ""));
  }
  return null;
}

/** `message` in `locale`; Arabic (or unknown) messages are returned unchanged for "ar". */
export function localizeServerMessage(message: string, locale: MessageLocale): string {
  if (locale !== "en" || typeof message !== "string") return message;
  return translate(message, 0) ?? message;
}

/** The locale a request asked for: lib/api-client.ts sends exactly `Accept-Language: en`
 * when the user picked English. A browser's own header ("en-US,en;q=0.9") is not a
 * choice made in the app, so like lib/rbac.ts and lib/http.ts only "en" means English. */
export function requestLocale(req?: { headers: { get(name: string): string | null } } | null): MessageLocale {
  return req?.headers.get("accept-language")?.trim() === "en" ? "en" : "ar";
}
