/* Order timelines: commercial events are shown only to the permissions that show the same
   facts elsewhere. A below-cost price exception names the average cost. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleAuditRows } from "../../lib/security/audit-visibility";

const row = { action: "order_price_exception", entityType: "order", fieldChanged: null };
const canOnly = (...perms: string[]) => (p: string) => perms.includes(p);

test("a price-exception row (it names the average cost) is hidden from the floor and from sales without valuation", () => {
  for (const perms of [["orders.view"], ["orders.view", "orders.prepare"], ["orders.view", "sales.pricing.view"]]) {
    assert.deepEqual(visibleAuditRows([row], canOnly(...perms)), [], perms.join(","));
  }
});

test("…and shown to whoever may see stock cost or approve the exception", () => {
  assert.equal(visibleAuditRows([row], canOnly("orders.view", "stock.valuation.view")).length, 1);
  assert.equal(visibleAuditRows([row], canOnly("orders.view", "sales.pricing.approve")).length, 1);
});

test("ordinary timeline rows are unaffected", () => {
  assert.equal(visibleAuditRows([{ action: "item_marked_prepared", entityType: "order", fieldChanged: null }], canOnly("orders.view")).length, 1);
});
