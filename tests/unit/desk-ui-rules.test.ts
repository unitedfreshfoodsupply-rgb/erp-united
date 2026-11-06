/* Desk screens: the small rules behind what the invoice, bill, payroll and period-close screens
   show (fully credited, fully debited, the first permitted payroll tab, close warnings in the
   singular). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isFullyCredited } from "@/components/sales/invoice-credit";
import { billDebitFacts } from "@/components/purchasing/bill-debit";
import { payrollTab } from "@/components/hr/payroll-tabs";
import { DICTIONARY } from "@/lib/locale/dictionary";

test("an invoice is fully credited when its credit notes add up to its total (the server's rule)", () => {
  assert.equal(isFullyCredited({ status: "issued", total: "100.00", credited: "100.00" }), true);
  assert.equal(isFullyCredited({ status: "issued", total: "100.00", credited: "100.01" }), true);
  assert.equal(isFullyCredited({ status: "issued", total: "100.00", credited: "99.99" }), false);
  assert.equal(isFullyCredited({ status: "issued", total: "0.00", credited: "0.00" }), false, "a zero invoice is not 'fully credited'");
  assert.equal(isFullyCredited({ status: "draft", total: "100.00", credited: "100.00" }), false);
  assert.equal(isFullyCredited({ status: "void", total: "100.00", credited: "100.00" }), false);
});

test("a posted bill with nothing left on its lines and a debit note is fully debited", () => {
  const goods = { status: "posted", service: false, serviceLines: [], debitNotes: [{}] };
  assert.deepEqual(billDebitFacts({ ...goods, lines: [{ quantity: "10", debitedQty: "10" }, { quantity: "2.5", debitedQty: "2.5" }] }), { debitable: false, fullyDebited: true });
  assert.deepEqual(billDebitFacts({ ...goods, lines: [{ quantity: "10", debitedQty: "10" }, { quantity: "2.5", debitedQty: "1" }] }), { debitable: true, fullyDebited: false });
  assert.deepEqual(billDebitFacts({ ...goods, debitNotes: [], lines: [{ quantity: "0", debitedQty: "0" }] }), { debitable: false, fullyDebited: false }, "no debit note, not 'fully debited'");
  assert.deepEqual(billDebitFacts({ ...goods, status: "draft", lines: [{ quantity: "1", debitedQty: "1" }] }).fullyDebited, false);
  const service = { status: "posted", service: true, lines: [], debitNotes: [{}] };
  assert.deepEqual(billDebitFacts({ ...service, serviceLines: [{ net: "500.00", debitedNet: "500.00" }] }), { debitable: false, fullyDebited: true });
  assert.deepEqual(billDebitFacts({ ...service, serviceLines: [{ net: "500.00", debitedNet: "120.00" }] }), { debitable: true, fullyDebited: false });
});

test("payroll opens on the first permitted tab, also when the permissions arrive after the first render", () => {
  assert.equal(payrollTab(null, [], "runs"), "runs", "before the permissions arrive");
  assert.equal(payrollTab(null, ["runs", "packages", "components", "rules"], "runs"), "runs");
  assert.equal(payrollTab(null, ["components", "rules"], "runs"), "components");
  assert.equal(payrollTab("rules", ["runs", "rules"], "runs"), "rules", "the user's choice stays while permitted");
  assert.equal(payrollTab("packages", ["runs", "rules"], "runs"), "runs", "a choice no longer permitted falls back");
});

test("every period-close warning has a plural and a singular text in both languages", () => {
  const src = readFileSync("lib/accounting/close-checklist.ts", "utf8");
  const union = src.match(/export type CloseWarning = \{ code: ([^;]+);/)?.[1] ?? "";
  const codes = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 6, "the CloseWarning codes are read from close-checklist.ts");
  const dict = DICTIONARY as Record<string, { ar: string; en: string } | undefined>;
  for (const code of codes) {
    for (const key of [`periods.close-warning.${code}`, `periods.close-warning.${code}.one`]) {
      assert.ok(dict[key]?.ar && dict[key]?.en, `${key} exists in Arabic and English`);
      assert.match(dict[key]!.en, /\{count\}/, `${key} shows the count`);
    }
  }
});
