/* The manual order form's line rules (lib/orderEntry.ts): a discount typed on its own is
   sent against the list price shown, the reason field appears whenever the price OR the
   discount differs from the list (the server's rule), and a product without a quantity is
   refused rather than dropped. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasTypedDiscount, lineMissingQuantity, linePriceDiffers, linePricingPayload } from "../../lib/orderEntry";

const line = (unit_price: string, discount_pct: string) => ({ unit_price, discount_pct });

test("nothing typed sends no price: the server applies the list price", () => {
  assert.equal(linePricingPayload(line("", ""), "12.5", ""), null);
  assert.equal(linePricingPayload(line("", "0"), "12.5", "x"), null);
  assert.equal(linePricingPayload(line("", ""), null, ""), null);
});

test("a discount typed without a price is sent against the list price", () => {
  assert.deepEqual(linePricingPayload(line("", "10"), "12.5", " regular customer "), {
    unit_price: "12.5",
    discount_pct: "10",
    price_reason: "regular customer",
  });
});

test("a typed price is sent as typed, with its discount or 0", () => {
  assert.deepEqual(linePricingPayload(line("11", ""), "12.5", ""), { unit_price: "11", discount_pct: "0", price_reason: undefined });
  assert.deepEqual(linePricingPayload(line("12.5", "5"), "12.5", "deal"), { unit_price: "12.5", discount_pct: "5", price_reason: "deal" });
  // No list price: the typed price is the price.
  assert.deepEqual(linePricingPayload(line("9", ""), null, ""), { unit_price: "9", discount_pct: "0", price_reason: undefined });
});

test("a discount with no price at all leaves the line unpriced, as the form shows it", () => {
  assert.equal(linePricingPayload(line("", "10"), null, ""), null);
});

test("the price differs from the list when the unit price OR the discount does", () => {
  assert.equal(linePriceDiffers(line("", ""), "12.5"), false);
  assert.equal(linePriceDiffers(line("12.5", ""), "12.5"), false);
  assert.equal(linePriceDiffers(line("12.50", "0"), "12.5"), false);
  assert.equal(linePriceDiffers(line("11", ""), "12.5"), true);
  assert.equal(linePriceDiffers(line("", "10"), "12.5"), true); // case A: discount only
  assert.equal(linePriceDiffers(line("12.5", "5"), "12.5"), true); // case B: list price + discount
  // No list price: nothing to differ from, the server needs no reason.
  assert.equal(linePriceDiffers(line("9", "5"), null), false);
});

test("a zero or blank discount is no discount", () => {
  assert.equal(hasTypedDiscount({ discount_pct: "" }), false);
  assert.equal(hasTypedDiscount({ discount_pct: "0" }), false);
  assert.equal(hasTypedDiscount({ discount_pct: "0.0" }), false);
  assert.equal(hasTypedDiscount({ discount_pct: "2.5" }), true);
});

test("a product with no positive quantity is a missing quantity; an empty line is not", () => {
  assert.equal(lineMissingQuantity({ stock_product_id: "p1", quantity: "" }), true);
  assert.equal(lineMissingQuantity({ stock_product_id: "p1", quantity: "0" }), true);
  assert.equal(lineMissingQuantity({ stock_product_id: "p1", quantity: "-2" }), true);
  assert.equal(lineMissingQuantity({ stock_product_id: "p1", quantity: "abc" }), true);
  assert.equal(lineMissingQuantity({ stock_product_id: "p1", quantity: "0.5" }), false);
  assert.equal(lineMissingQuantity({ stock_product_id: "", quantity: "" }), false);
});
