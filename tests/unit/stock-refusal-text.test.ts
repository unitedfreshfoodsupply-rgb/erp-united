/* ORD-03: the order-confirmation stock refusal reads in English for an English request
   (server catalogue), and the order screens spell it out with the reader's unit words. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StockUnavailableError } from "@/lib/sales/stock-commitment";
import { localizeServerMessage } from "@/lib/locale/server-messages";
import { ApiClientError } from "@/lib/api-client";
import { DICTIONARY } from "@/lib/locale/dictionary";
import { stockRefusalText } from "@/components/order/stockRefusal";

const sf = (over: Record<string, string>) => ({ productId: "p", productName: "Mango", unit: "KG", requested: "5", available: "2", reason: "insufficient", ...over }) as never;

test("the refusal the server throws translates whole, line by line", () => {
  const one = new StockUnavailableError([sf({})]);
  assert.equal(localizeServerMessage(one.message, "ar"), one.message, "Arabic untouched");
  assert.equal(localizeServerMessage(one.message, "en"), "The order cannot be confirmed — Mango: requested 5 KG, available 2 KG");
  const many = new StockUnavailableError([sf({}), sf({ productName: "مانجو", requested: "3", available: "1" }), sf({ productName: "Kiwi", reason: "unmapped" })]);
  assert.equal(
    localizeServerMessage(many.message, "en"),
    "The order cannot be confirmed — Mango: requested 5 KG, available 2 KG · مانجو: requested 3 KG, available 1 KG · Kiwi: not linked to the product catalog"
  );
});

const t = (locale: "ar" | "en") => (key: string, params?: Record<string, string | number>) =>
  (DICTIONARY as Record<string, { ar: string; en: string }>)[key][locale].replace(/\{(\w+)\}/g, (_, n: string) => String(params?.[n] ?? `{${n}}`));

test("the order screens spell the shortfalls out with localized units", () => {
  const err = new ApiClientError("مينفعش تأكيد الأوردر — …", "stock_unavailable", { shortfalls: [sf({}), sf({ productName: "Kiwi", reason: "unit_mismatch" })] }, 409);
  assert.equal(stockRefusalText(err, t("en"), "en"), "The order cannot be confirmed — Mango: 5 kg requested, 2 kg available · Kiwi: the unit does not convert to the stock unit");
  assert.equal(stockRefusalText(err, t("ar"), "ar"), "مينفعش تأكيد الأوردر — Mango: المطلوب 5 كجم، المتاح 2 كجم · Kiwi: الوحدة مش بتتحول لوحدة المخزون");
  // Anything else is not this helper's business.
  assert.equal(stockRefusalText(new ApiClientError("x", "stale", undefined, 409), t("en"), "en"), null);
  assert.equal(stockRefusalText(new Error("x"), t("en"), "en"), null);
});
