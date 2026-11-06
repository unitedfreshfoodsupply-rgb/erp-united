import { ApiClientError } from "@/lib/api-client";
import { unitLabel } from "@/lib/format";

/**
 * The order-confirmation stock refusal (409 stock_unavailable) in the reader's words (ORD-03).
 *
 * The server's message is Arabic with raw unit codes ("5 KG"); its details carry every
 * shortfall, so the order screens (entry, the awaiting-stock panel, the order's own status
 * moves) spell it out in the reader's language with unit words. Null for any other error:
 * the caller then shows the server's message as before.
 */
type Shortfall = { productName: string; unit: string; requested: string; available: string; reason: string };
type T = (key: string, params?: Record<string, string | number>) => string;

const REASON_KEY: Record<string, string> = {
  unmapped: "orders.stock-refused.unmapped",
  unit_not_on_product: "orders.stock-refused.unit_not_on_product",
  precision: "orders.stock-refused.precision",
  unit_mismatch: "orders.stock-refused.unit_mismatch",
};

export function stockRefusalText(err: unknown, t: T, locale: "ar" | "en"): string | null {
  if (!(err instanceof ApiClientError) || err.code !== "stock_unavailable") return null;
  const shortfalls = (err.details as { shortfalls?: Shortfall[] } | undefined)?.shortfalls;
  if (!Array.isArray(shortfalls) || shortfalls.length === 0) return null;
  const lines: string[] = [];
  for (const s of shortfalls) {
    if (s.reason === "insufficient") {
      lines.push(t("orders.stock-refused.insufficient", { product: s.productName, requested: s.requested, available: s.available, unit: unitLabel(s.unit, locale) }));
    } else if (REASON_KEY[s.reason]) {
      lines.push(t(REASON_KEY[s.reason], { product: s.productName }));
    } else {
      return null; // a reason this screen does not know: the server's own words
    }
  }
  return t("orders.stock-refused", { lines: lines.join(" · ") });
}
