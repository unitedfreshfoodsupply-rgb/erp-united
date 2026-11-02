import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNumerals, toLatinDigits } from "@/lib/numerals";

test("I18N-02: Arabic-Indic and Persian digits and separators read as the same number", () => {
  assert.equal(toLatinDigits("١٢٫٥"), "12.5");
  assert.equal(toLatinDigits("۱۲۳۴"), "1234");
  assert.equal(toLatinDigits("١٬٢٣٤٫٥٠"), "1234.50");
  assert.equal(Number(toLatinDigits("٠٫٧٥")), 0.75);
});

test("I18N-02: a request body's number-like strings are normalised; text with digits is not", () => {
  const body = { quantity: "١٢٫٥", unit_price: "٢٧٫٠٠", name: "فرع ٣ — الدقي", phone: "٠١٠٠١٢٣٤٥٦٧", lines: [{ quantity: "٣" }], latin: "1,234", n: 5, neg: "−٤" };
  assert.deepEqual(normalizeNumerals(body), { quantity: "12.5", unit_price: "27.00", name: "فرع ٣ — الدقي", phone: "01001234567", lines: [{ quantity: "3" }], latin: "1,234", n: 5, neg: "-4" });
});
