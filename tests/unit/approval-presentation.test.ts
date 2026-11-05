/* The screens name approval types through lib/core/approval-presentation.ts (client-safe);
   every name there must be a real type, or a notice or a confirmation silently never shows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_TYPES } from "@/lib/core/approvals";
import { APPROVAL_TYPE, CONFIRM_TYPES, MONEY_TYPES } from "@/lib/core/approval-presentation";

test("every approval type the screens name is defined", () => {
  const known = new Set(Object.keys(APPROVAL_TYPES));
  const named = [...Object.values(APPROVAL_TYPE), ...MONEY_TYPES, ...CONFIRM_TYPES];
  assert.deepEqual(named.filter((t) => !known.has(t)), []);
});

test("the notices' types are decided in the inbox, and their approvers are pointed there", () => {
  for (const t of Object.values(APPROVAL_TYPE)) assert.equal((APPROVAL_TYPES as Record<string, { decidedInInbox?: true }>)[t].decidedInInbox, true, t);
});
