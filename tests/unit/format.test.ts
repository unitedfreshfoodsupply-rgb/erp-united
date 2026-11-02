import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNumber, money, qty } from "@/lib/format";

test("I18N-06: one number format — grouped, crumbs dropped, never -0", () => {
  assert.equal(qty(3840), "3,840", "quantities are grouped (the order page showed 3840 next to 3,200)");
  assert.equal(qty("12480.75"), "12,480.75");
  assert.equal(qty(0.30000000004), "0.3");
  assert.equal(formatNumber(-0.001, { minDp: 2, maxDp: 2 }), "0.00", "a difference that rounds to zero is 0.00, not -0.00");
  assert.equal(formatNumber("-0", { minDp: 2, maxDp: 2 }), "0.00");
  assert.equal(formatNumber(-1234.5, { minDp: 2, maxDp: 2 }), "-1,234.50", "a real negative keeps its sign");
  assert.equal(money(57439, "en"), "57,439.00 EGP");
  assert.equal(money("48185.2", "ar"), "48,185.20 ج.م");
  assert.equal(qty(null), "—");
});
