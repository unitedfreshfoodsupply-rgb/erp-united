/* The order screen's price lock (ORD-06) and trip-stop wording (ORD-08), shared by the
   pricing panel and the customer's orders list. The lock follows lib/sales/pricing.ts:
   a cancelled order, an issued invoice, or a draft invoice to void first. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderPriceLock, orderStopShownAs } from "@/lib/orderActions";

test("prices are locked on a cancelled order, under an issued invoice and under a draft invoice", () => {
  assert.equal(orderPriceLock("cancelled", null), "cancelled");
  assert.equal(orderPriceLock("cancelled", "issued"), "cancelled", "cancelled is said first");
  assert.equal(orderPriceLock("dispatched", "issued"), "issued");
  assert.equal(orderPriceLock("dispatched", "draft"), "draft");
});

test("prices stay open on a live order with no invoice or only a void one", () => {
  for (const status of ["new", "preparing", "ready_for_loading", "loading", "loaded", "dispatched"]) {
    assert.equal(orderPriceLock(status, null), null, status);
    assert.equal(orderPriceLock(status, undefined), null, status);
    assert.equal(orderPriceLock(status, "void"), null, status);
  }
  assert.equal(orderPriceLock(undefined, null), null);
});

test("a pending stop reads 'on the trip' until the order is dispatched; other stop states as they are", () => {
  for (const status of ["loading", "loaded", null]) assert.equal(orderStopShownAs("pending", status), "on-trip", String(status));
  assert.equal(orderStopShownAs("pending", "dispatched"), "pending");
  for (const stop of ["delivered", "partial", "failed"]) {
    assert.equal(orderStopShownAs(stop, "dispatched"), stop);
    assert.equal(orderStopShownAs(stop, "loaded"), stop);
  }
});
