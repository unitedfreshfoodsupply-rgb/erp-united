/* OPN-D13: the cut-over report's opening-balance items. Opening equity (3300) must net to zero
   (overall and as at the cut-over date); an opening entry counts as "direct" only when it did
   not come from a batch. Four situations from the decision register (D13/D14). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { openingItems } from "../../lib/accounting/cutover";

const D = (v: string) => new Prisma.Decimal(v);
const byKey = (items: ReturnType<typeof openingItems>) => Object.fromEntries(items.map((i) => [i.key, i]));
const blocked = (items: ReturnType<typeof openingItems>) => items.some((i) => !i.ok && i.severity === "blocker");

test("production today: no batch, the direct opening stock entry stands and 3300 holds its credit — red, and says why", () => {
  const i = byKey(openingItems({ initial: null, batches: [], equity: D("-418281.23"), equityAtCutover: null, directStock: [{ number: "ADJ-2026-00001", businessDate: "2026-10-31" }], partyRows: 0, batchPartyLines: 0 }));
  assert.equal(i.opening_batch.ok, false);
  assert.equal(i.opening_equity_zero.ok, false);
  assert.equal(i.opening_equity_zero.value, "-418281.23");
  assert.equal(i.direct_opening_stock.ok, false, "the direct entry is reported before a batch exists (it was hidden)");
  assert.deepEqual(i.direct_opening_stock.detail, [{ number: "ADJ-2026-00001", businessDate: "2026-10-31" }]);
  assert.equal("opening_equity_at_cutover" in i, false, "no cut-over date yet");
});

test("Option B done right: the direct entry reversed, one batch with stock and party lines — nothing flagged", () => {
  const items = openingItems({ initial: { number: "OPB-2026-00001", cutoverDate: "2026-11-05" }, batches: [], equity: D("0"), equityAtCutover: D("0"), directStock: [], reversedDirect: [{ number: "ADJ-2026-00001", reversedOn: "2026-11-05" }], partyRows: 191, batchPartyLines: 191 });
  assert.ok(items.every((x) => x.ok), JSON.stringify(items.filter((x) => !x.ok)));
  assert.equal(blocked(items), false);
});

test("a cut-over date before the reversal day: 3300 nets to zero today but not as at the cut-over date — blocked", () => {
  const i = byKey(openingItems({ initial: { number: "OPB-2026-00001", cutoverDate: "2026-10-31" }, batches: [], equity: D("0"), equityAtCutover: D("-418281.23"), directStock: [], partyRows: 2, batchPartyLines: 2 }));
  assert.equal(i.opening_equity_zero.ok, true);
  assert.equal(i.opening_equity_at_cutover.ok, false);
  assert.equal(i.opening_equity_at_cutover.severity, "blocker");
});

test("a batch posted while the direct stock entry stands: 3300 keeps its credit and the direct entry is listed — blocked", () => {
  const items = openingItems({ initial: { number: "OPB-2026-00001", cutoverDate: "2026-11-05" }, batches: [], equity: D("-418281.23"), equityAtCutover: D("-418281.23"), directStock: [{ number: "ADJ-2026-00001", businessDate: "2026-10-31" }], partyRows: 3, batchPartyLines: 2 });
  const i = byKey(items);
  assert.equal(blocked(items), true);
  assert.equal(i.direct_opening_stock.count, 1);
  assert.equal(i.direct_party_opening.count, 1, "one party balance did not come from the batch");
});

test("a cut-over date before the reversal of the direct entry — even before 31 Oct — is blocked: the stock would be counted twice in between", () => {
  // 3300 nets to zero at any date before 31 Oct (neither the direct entry nor its reversal yet),
  // so the as-at check alone passes; the reversal date is what decides.
  for (const cutoverDate of ["2026-10-30", "2026-11-04"]) {
    const i = byKey(openingItems({ initial: { number: "OPB-2026-00001", cutoverDate }, batches: [], equity: D("0"), equityAtCutover: D("0"), directStock: [], reversedDirect: [{ number: "ADJ-2026-00001", reversedOn: "2026-11-05" }], partyRows: 0, batchPartyLines: 0 }));
    assert.equal(i.opening_equity_at_cutover.ok, true, cutoverDate);
    assert.equal(i.cutover_after_direct_reversal.ok, false, cutoverDate);
    assert.equal(i.cutover_after_direct_reversal.severity, "blocker");
    assert.deepEqual(i.cutover_after_direct_reversal.detail, [{ number: "ADJ-2026-00001", reversedOn: "2026-11-05" }]);
  }
  const same = byKey(openingItems({ initial: { number: "OPB-2026-00001", cutoverDate: "2026-11-05" }, batches: [], equity: D("0"), equityAtCutover: D("0"), directStock: [], reversedDirect: [{ number: "ADJ-2026-00001", reversedOn: "2026-11-05" }], partyRows: 0, batchPartyLines: 0 }));
  assert.equal(same.cutover_after_direct_reversal.ok, true, "the reversal day itself is fine");
  assert.equal("cutover_after_direct_reversal" in byKey(openingItems({ initial: null, batches: [], equity: D("0"), equityAtCutover: null, directStock: [], reversedDirect: [{ number: "ADJ-2026-00001", reversedOn: "2026-11-05" }], partyRows: 0, batchPartyLines: 0 })), false, "no batch yet: nothing to compare");
});
