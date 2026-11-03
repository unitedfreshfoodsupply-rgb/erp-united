/* Statement lines: only what the system wrote is translated, chosen by the line's kind;
   what a user typed (references, reasons, asset names) is shown exactly as stored. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statementLine } from "../../lib/locale/statement-text";

const en = (kind: string, ref: string, number = "X-1") => statementLine({ kind, number, ref }, "en");

test("system words lead the line; the typed part after them is kept as typed", () => {
  assert.equal(en("receipt", "تحصيل · CHQ-118").ref, "Receipt · CHQ-118");
  assert.equal(en("receipt", "تحصيل").ref, "Receipt");
  assert.equal(en("payment", "سداد · TRF 9").ref, "Payment · TRF 9");
  assert.equal(en("refund", "رد مبلغ · مرتجع بضاعة").ref, "Refund paid · مرتجع بضاعة");
  assert.equal(en("refund", "استرداد · خصم").ref, "Refund received · خصم");
  assert.equal(en("receipt_reversal", "عكس تحصيل · شيك مرتد").ref, "Receipt reversal · شيك مرتد");
  assert.equal(en("payment_reversal", "عكس سداد · خطأ").ref, "Payment reversal · خطأ");
});

test("typed text that looks like a known phrase or code is never rewritten", () => {
  assert.equal(en("receipt", "تحصيل · SI 2026/77").ref, "Receipt · SI 2026/77");
  assert.equal(en("receipt", "تحصيل · tax 5").ref, "Receipt · tax 5");
  assert.equal(en("receipt", "تحصيل · استلام نقدية").ref, "Receipt · استلام نقدية");
  assert.equal(en("refund", "رد مبلغ · لا").ref, "Refund paid · لا");
  assert.equal(en("payment", "سداد · fixed").ref, "Payment · fixed");
  assert.equal(en("credit_note", "INV-2026-00001 · مرتجع").ref, "INV-2026-00001 · مرتجع");
  assert.equal(en("debit_note", "BIL-2026-00002 · input").ref, "BIL-2026-00002 · input");
  assert.equal(en("opening_balance", "SI 2026/77", "رصيد افتتاحي").ref, "SI 2026/77");
  assert.equal(en("charge", "رسوم · استحقاق 2026-12-01", "SI 2026/77").number, "SI 2026/77");
});

test("due dates, the asset-sale charge and the opening-balance number read in English", () => {
  assert.equal(en("invoice", "استحقاق 2026-11-30").ref, "due 2026-11-30");
  assert.equal(en("bill", "NUB-118 · استحقاق 2026-11-30").ref, "NUB-118 · due 2026-11-30");
  assert.equal(en("charge", "بيع أصل FA-00001: عربية نقل · استحقاق 2026-12-01").ref, "Asset sale FA-00001: عربية نقل · due 2026-12-01");
  assert.equal(en("opening_balance", "", "رصيد افتتاحي").number, "Opening balance");
});

test("an Arabic reader gets the line exactly as stored", () => {
  const row = { kind: "receipt", number: "RCT-1", ref: "تحصيل · SI 2026/77" };
  assert.deepEqual(statementLine(row, "ar"), { number: "RCT-1", ref: "تحصيل · SI 2026/77" });
});
