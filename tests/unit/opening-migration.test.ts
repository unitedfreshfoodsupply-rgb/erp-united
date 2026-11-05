/* The phased opening migration's status and closure rules (pure): what the control center shows,
   and what must hold before a second person may close the migration. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { closureChecks, migrationStatus, ATTESTATIONS } from "../../lib/accounting/opening-migration";
import { openingItems } from "../../lib/accounting/cutover";

const D = (v: string) => new Prisma.Decimal(v);
const green = { ap: { ok: true }, ar: { ok: true }, inventory: { ok: true }, fixed_assets: { ok: true }, trial_balance: { ok: true } };
const everyone = Object.fromEntries(ATTESTATIONS.map((k) => [k, { by: "x", byId: "u", at: "2026-11-04", note: "ok" }]));
const ready = { draft: 0, pending: 0, integrity: green, clearing: D("0"), untraced: D("0"), openingEquity: D("0"), openExceptions: 0, attestations: everyone, users: 2, differentApprover: true };
const failing = (f: typeof ready) => closureChecks(f).filter((c) => !c.ok).map((c) => c.key);

test("status: not started, in progress, awaiting approval, reconciliation required, ready, closed", () => {
  const s = (over: Partial<Parameters<typeof migrationStatus>[0]>) => migrationStatus({ migration: { status: "open" }, draft: 0, pending: 0, posted: 1, checksOk: false, ...over });
  assert.equal(migrationStatus({ migration: null, draft: 0, pending: 0, posted: 0, checksOk: true }), "not_started");
  assert.equal(s({ posted: 0 }), "in_progress", "nothing posted yet");
  assert.equal(s({ draft: 1 }), "in_progress", "a batch still being prepared");
  assert.equal(s({ pending: 1 }), "awaiting_approval");
  assert.equal(s({ migration: { status: "closing" }, checksOk: true }), "awaiting_approval");
  assert.equal(s({}), "reconciliation_required");
  assert.equal(s({ checksOk: true }), "ready_for_closure");
  assert.equal(s({ migration: { status: "closed" }, draft: 3 }), "closed");
});

test("closure needs every check: a supplier-only position leaves the clearing account non-zero and cannot close", () => {
  assert.deepEqual(failing(ready), []);
  // Today's production position after posting the verified supplier rows: AP on one side, the clearing account on the other.
  assert.deepEqual(failing({ ...ready, clearing: D("4260486.80"), openingEquity: D("-418281.23"), openExceptions: 40, attestations: {}, users: 1 }), [
    "clearing_zero", "opening_equity_zero", "exceptions_decided",
    "attest_suppliers_complete", "attest_customers_complete", "attest_cash_bank_verified", "attest_other_accounts_reconciled", "second_person",
  ]);
  assert.deepEqual(failing({ ...ready, untraced: D("1.00") }), ["clearing_traced"], "a clearing movement outside a migration batch");
  assert.deepEqual(failing({ ...ready, pending: 1 }), ["batches_settled"]);
  assert.deepEqual(failing({ ...ready, integrity: { ...green, ap: { ok: false } } }), ["ap_reconciled"]);
  assert.deepEqual(failing({ ...ready, integrity: { ...green, ar: { ok: false }, inventory: { ok: false } } }), ["ar_reconciled", "inventory_reconciled"]);
  assert.deepEqual(failing({ ...ready, differentApprover: false }), ["second_person"]);
});

test("the cut-over report: a phased migration is complete only when closed with its clearing account at zero", () => {
  const base = { initial: null, batches: [], equity: D("0"), equityAtCutover: null, directStock: [], partyRows: 11, batchPartyLines: 11 };
  const byKey = (items: ReturnType<typeof openingItems>) => Object.fromEntries(items.map((i) => [i.key, i]));
  const open = byKey(openingItems({ ...base, migration: { status: "open", cutoverDate: "2026-10-31" }, clearing: D("4260486.80") }));
  assert.equal(open.opening_batch.ok, false);
  assert.equal(open.opening_clearing_zero.ok, false);
  assert.equal(open.opening_clearing_zero.value, "4260486.80");
  const closed = byKey(openingItems({ ...base, migration: { status: "closed", cutoverDate: "2026-10-31" }, clearing: D("0") }));
  assert.deepEqual([closed.opening_batch.ok, closed.opening_clearing_zero.ok, closed.opening_equity_zero.ok], [true, true, true]);
  assert.equal("opening_clearing_zero" in byKey(openingItems(base)), false, "no migration: the one-batch items as before");
});
