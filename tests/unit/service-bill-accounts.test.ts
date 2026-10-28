import { test } from "node:test";
import assert from "node:assert/strict";
import { isServiceBillAccount, SERVICE_BILL_REFUSED_KEYS } from "@/lib/purchasing/service-accounts";
import { controlAccountMovedBy } from "@/lib/accounting/ledger";
import { CHART_OF_ACCOUNTS } from "@/lib/core/reference-data";

/* One rule for the service-bill form and the server: what the form offers is exactly
   what the server accepts. */
const acct = (over: Partial<{ type: string; postable: boolean; active: boolean; systemKey: string | null }> = {}) => ({ type: "expense", postable: true, active: true, systemKey: null, ...over });

test("standard operating-expense accounts are chargeable, though they carry system keys", () => {
  for (const key of ["general_expenses", "transport_expenses", "salaries"]) assert.equal(isServiceBillAccount(acct({ systemKey: key })), true, key);
  assert.equal(isServiceBillAccount(acct()), true, "an accountant-created expense account");
  assert.equal(isServiceBillAccount(acct({ type: "asset" })), true, "equipment / fixed asset");
});

test("stock-cost accounts are refused: COGS, inventory adjustments, purchase price variance", () => {
  for (const key of ["cogs", "inventory_adjustment", "ppv"]) assert.equal(isServiceBillAccount(acct({ systemKey: key })), false, key);
});

test("control, input-VAT and cash/bank accounts, headers, inactive and non-expense/asset accounts are refused", () => {
  for (const key of ["ar", "ap", "inventory", "grni", "employee_advances", "employee_payable", "vat_input", "cash", "bank"]) assert.equal(isServiceBillAccount(acct({ type: "asset", systemKey: key })), false, key);
  assert.equal(isServiceBillAccount(acct(), true), false, "an account behind a cash box or bank account");
  assert.equal(isServiceBillAccount(acct({ postable: false })), false, "header");
  assert.equal(isServiceBillAccount(acct({ active: false })), false, "inactive");
  for (const type of ["revenue", "liability", "equity"]) assert.equal(isServiceBillAccount(acct({ type })), false, type);
});

test("every control account the ledger protects is refused here too (the lists cannot drift)", () => {
  const keys = CHART_OF_ACCOUNTS.map((a) => a.systemKey).filter((k): k is string => !!k);
  for (const key of keys) if (controlAccountMovedBy(key)) assert.ok(SERVICE_BILL_REFUSED_KEYS.has(key), key);
});
