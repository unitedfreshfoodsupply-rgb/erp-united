/* Stored system text (journal descriptions, audit values, approval titles) and unit codes
   read in the UI language; unknown text and user data pass through as stored. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { systemText } from "../../lib/locale/system-text";
import { unitLabel, qtyUnit, intlLocale } from "../../lib/format";

test("Arabic system text reads in English, values carried over", () => {
  assert.equal(systemText("فاتورة مبيعات INV-2026-00010", "en"), "Sales invoice INV-2026-00010");
  assert.equal(systemText("قيمة مخزون — مرتجع عميل RET-2026-00006", "en"), "Inventory value — customer return RET-2026-00006");
  assert.equal(systemText("مسير مرتبات PRL-2026-00001 · 2025-08 · 2 موظف", "en"), "Payroll run PRL-2026-00001 · 2025-08 · 2 employees");
  assert.equal(systemText("payroll_run · 10600.00", "en"), "Payroll run · 10600.00");
});

test("English system text reads in Arabic, part by part", () => {
  assert.equal(systemText("2 rows · 0 ready", "ar"), "2 صف · 0 جاهز");
  assert.equal(systemText("earning · fixed · tax true · SI false", "ar"), "استحقاق · ثابت شهري · خاضع للضريبة: نعم · خاضع للتأمينات: لا");
});

test("user text and names are never rewritten", () => {
  assert.equal(systemText("Hassan Ali", "ar"), "Hassan Ali");
  assert.equal(systemText("شيك مرتد", "en"), "شيك مرتد");
  assert.equal(systemText(null, "en"), "");
});

test("units read as words; codes outside the list pass through", () => {
  assert.equal(unitLabel("KG", "ar"), "كجم");
  assert.equal(unitLabel("KG", "en"), "kg");
  assert.equal(unitLabel("BOX", "ar"), "صندوق");
  assert.equal(unitLabel("XYZ", "ar"), "XYZ");
  assert.equal(qtyUnit(2.5, "KG", "ar"), "2.5 كجم");
});

test("Arabic dates use Western digits, like every other number on screen", () => {
  const s = new Date(Date.UTC(2026, 9, 29, 9, 0)).toLocaleDateString(intlLocale("ar"), { timeZone: "UTC" });
  assert.match(s, /29/);
  assert.doesNotMatch(s, /[٠-٩]/);
});

test("unit codes inside stored text follow the reader", () => {
  assert.equal(systemText("Mint: مطلوب 9 KG، الفعلي 10 (فرق 11.1%)", "en"), "Mint: required 9 kg, actual 10 (11.1% difference)");
  assert.equal(systemText("Mint: مطلوب 9 KG، الفعلي 10 (فرق 11.1%)", "ar"), "Mint: مطلوب 9 كجم، الفعلي 10 (فرق 11.1%)");
  assert.equal(systemText("Mango: خرج 2 KG، اتصرف من الدفاتر 0", "ar"), "Mango: خرج 2 كجم، اتصرف من الدفاتر 0");
});

test("integration scopes stored as keys read as words", () => {
  assert.equal(systemText("Key · orders.create · uk_abc…", "en"), "Key · Create orders · uk_abc…");
  assert.equal(systemText("Key · orders.create · uk_abc…", "ar"), "Key · إنشاء أوردرات · uk_abc…");
});
