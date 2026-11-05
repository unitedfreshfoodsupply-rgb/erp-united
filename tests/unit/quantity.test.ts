/* Quantities to three decimals, decided on the typed value (LOG-2, Nov 2026): the old check,
   Number.isInteger(q * 1000), refused valid weights such as 16.1 kg, and the stepper handed on
   float drift (2.3 − 1 = 1.2999999999999998). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { D } from "@/lib/inventory/decimal";
import { fitsDecimals, stepQuantity } from "@/lib/quantity";

test("weights the old check refused fit three decimals", () => {
  for (const q of [16.1, 32.2, 8.03, 2.01, 1.001, 0.001, 999_999_999_999, 999_999_999.999, 0, 5]) assert.equal(fitsDecimals(q), true, String(q));
});

test("more than three decimals, or float drift, is still refused", () => {
  for (const q of [1.2999999999999998, 0.0005, 2.0001, 1e-7, 16.1001, NaN, Infinity]) assert.equal(fitsDecimals(q), false, String(q));
  assert.equal(fitsDecimals(2.5, 0), false, "a whole-number unit refuses fractions");
  assert.equal(fitsDecimals(3, 0), true);
});

test("same answer as the Decimal rule (D(q).toDecimalPlaces(3) = D(q)) over every value at one, two and three places", () => {
  const same = (q: number) => fitsDecimals(q) === D(q).toDecimalPlaces(3).equals(D(q));
  for (let i = 0; i <= 5000; i++) assert.ok(same(i / 10), String(i / 10));
  for (let i = 0; i <= 10000; i++) assert.ok(same(i / 100), String(i / 100));
  for (let i = 0; i <= 100000; i++) assert.ok(fitsDecimals(i / 1000), String(i / 1000));
  for (const q of [0.1 + 0.2, 1.1 * 3, 2.3 - 1, 0.07 * 100]) assert.ok(same(q), String(q));
});

test("the stepper rounds to three decimals and never goes below zero", () => {
  assert.equal(stepQuantity(2.3, -1), 1.3);
  assert.equal(stepQuantity(0.1, 0.2), 0.3);
  assert.equal(stepQuantity(16.1, 1), 17.1);
  assert.equal(stepQuantity(0.5, -1), 0);
  assert.equal(stepQuantity(2.005, 0.001), 2.006);
  assert.ok(fitsDecimals(stepQuantity(7.7, -0.1)));
});
