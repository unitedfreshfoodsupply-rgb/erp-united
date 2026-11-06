/* Approval titles, summaries and notification bodies are stored in Arabic when the request is
   raised; in English they read in English (browser QA D3, Nov 2026). Names and user-typed text
   stay as stored. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { systemText } from "@/lib/locale/system-text";
import { APPROVAL_TYPES } from "@/lib/core/approvals";

const ARABIC = /[؀-ۿ]/;
const plain = (s: string) => s.replace(/[⁦-⁩]/g, "");

test("request titles and summaries as the modules write them read in English", () => {
  assert.equal(systemText("قيد يدوي JR-2026-00058: QA journal 58", "en"), "Manual journal JR-2026-00058: QA journal 58");
  assert.equal(systemText("أرصدة افتتاحية OPN-0001 (2026-11-06)", "en"), "Opening balances OPN-0001 (2026-11-06)");
  assert.equal(systemText("أرصدة افتتاحية OPN-0002 — عملاء (2026-11-06)", "en"), "Opening balances OPN-0002 — customers (2026-11-06)");
  assert.equal(systemText("202 سطر · مدين 15000.00 = دائن 15000.00 · منها على الحساب الوسيط (مؤقت) 0.00", "en"), "202 lines · debit 15000.00 = credit 15000.00 · of which on the clearing account (provisional) 0.00");
  assert.equal(systemText("قفل الترحيل الافتتاحي (تاريخ القطع 2026-11-06)", "en"), "Opening migration closure (cut-over date 2026-11-06)");
  assert.equal(systemText("1 دفعة مترحّلة · الحساب الوسيط 0.00 · كل فحوصات القفل ناجحة", "en"), "1 batches posted · clearing account 0.00 · all closing checks pass");
  assert.equal(systemText("إعادة فتح الشهر 2026-10", "en"), "Reopen month 2026-10");
});

test("a cash transfer reads 'Transfer', from → to, the account names isolated and as stored", () => {
  const en = systemText("تحويل CT-2026-00001: الخزينة الرئيسية ← الحساب البنكي", "en");
  assert.equal(plain(en), "Transfer CT-2026-00001: الخزينة الرئيسية → الحساب البنكي");
  assert.match(en, /⁨الخزينة الرئيسية⁩ → ⁨الحساب البنكي⁩/);
  // The plain stock-movement rule is unchanged.
  assert.equal(systemText("تحويل TR-1", "en"), "transfer TR-1");
});

test("notification titles and bodies read in English", () => {
  assert.equal(systemText("مطلوب موافقتك: قيد يدوي JR-2026-00058: QA journal 58", "en"), "Your approval is needed: Manual journal JR-2026-00058: QA journal 58");
  assert.equal(systemText("بواسطة كريم", "en"), "by كريم");
});

test("every approval type's label (a request notice's body without a summary) reads in English", () => {
  const untranslated = Object.entries(APPROVAL_TYPES).filter(([, d]) => ARABIC.test(systemText(d.label, "en"))).map(([k]) => k);
  assert.deepEqual(untranslated, []);
});

test("Arabic reads as stored", () => {
  assert.equal(systemText("تحويل CT-2026-00001: الخزينة الرئيسية ← الحساب البنكي", "ar"), "تحويل CT-2026-00001: الخزينة الرئيسية ← الحساب البنكي");
});
