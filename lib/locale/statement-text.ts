import type { Locale } from "./context";

/**
 * A statement line in the reader's language.
 *
 * Statement lines mix words the system wrote ("تحصيل · <reference>", "<invoice no> · استحقاق
 * <date>", the opening-balance number) with text a user typed (a receipt reference, a refund
 * reason, an asset's name). Only the system part is translated, picked by the line's kind;
 * what the user typed is returned exactly as stored. Stored text is Arabic, so an Arabic
 * reader gets the line unchanged.
 */
const LEAD: Record<string, string> = {
  "تحصيل": "Receipt",
  "سداد": "Payment",
  "رد مبلغ": "Refund paid",
  "استرداد": "Refund received",
  "عكس تحصيل": "Receipt reversal",
  "عكس سداد": "Payment reversal",
};
/** Kinds whose reference starts with a system word, then " · " and the user's text. */
const LEAD_KINDS = new Set(["receipt", "payment", "refund", "receipt_reversal", "payment_reversal"]);
/** Kinds whose reference ends with "استحقاق <date>" (the due date). */
const DUE_KINDS = new Set(["invoice", "bill", "charge"]);
const DUE = /(^|^[\s\S]* · )استحقاق (\d{4}-\d{2}-\d{2})$/;
const ASSET_SALE = /^بيع أصل (\S+): /;
const OPENING = "رصيد افتتاحي";

export function statementLine(row: { kind: string; number: string; ref: string }, locale: Locale): { number: string; ref: string } {
  if (locale !== "en") return { number: row.number, ref: row.ref };
  return { number: row.kind === "opening_balance" && row.number === OPENING ? "Opening balance" : row.number, ref: refIn(row.kind, row.ref ?? "") };
}

function refIn(kind: string, ref: string): string {
  if (LEAD_KINDS.has(kind)) {
    const i = ref.indexOf(" · ");
    const head = i < 0 ? ref : ref.slice(0, i);
    return LEAD[head] ? LEAD[head] + (i < 0 ? "" : ref.slice(i)) : ref;
  }
  if (DUE_KINDS.has(kind)) {
    const m = DUE.exec(ref);
    if (!m) return ref;
    // The part before the due date: a supplier's invoice number (typed) or, for a charge, its
    // system description ("بيع أصل <asset no>: <asset name>" — the name stays as typed).
    const before = kind === "charge" ? m[1].replace(ASSET_SALE, "Asset sale $1: ") : m[1];
    return `${before}due ${m[2]}`;
  }
  return ref;
}
