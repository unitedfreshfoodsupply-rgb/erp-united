/* Approval titles, summaries and notification bodies are stored in Arabic when the request is
   raised; in English they read in English (browser QA D3, Nov 2026). Names and user-typed text
   stay as stored. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { systemText } from "@/lib/locale/system-text";
import { APPROVAL_TYPES } from "@/lib/core/approvals";
import { DICTIONARY } from "@/lib/locale/dictionary";

const ARABIC = /[؀-ۿ]/;
const plain = (s: string) => s.replace(/[⁦-⁩]/g, "");

test("request titles and summaries as the modules write them read in English", () => {
  assert.equal(systemText("قيد يدوي JR-2026-00058: QA journal 58", "en"), "Manual journal JR-2026-00058: QA journal 58");
  assert.equal(systemText("أرصدة افتتاحية OPN-0001 (2026-11-06)", "en"), "Opening balances OPN-0001 (2026-11-06)");
  assert.equal(systemText("أرصدة افتتاحية OPN-0002 — عملاء (2026-11-06)", "en"), "Opening balances OPN-0002 — customers (2026-11-06)");
  assert.equal(systemText("202 سطر · مدين 15000.00 = دائن 15000.00 · منها على الحساب الوسيط (مؤقت) 0.00", "en"), "202 lines · debit 15000.00 = credit 15000.00 · of which on the clearing account (provisional) 0.00");
  assert.equal(systemText("قفل الترحيل الافتتاحي (تاريخ القطع 2026-11-06)", "en"), "Opening migration closure (cut-over date 2026-11-06)");
  assert.equal(systemText("1 دفعة مترحّلة · الحساب الوسيط 0.00 · كل فحوصات القفل ناجحة", "en"), "batches posted: 1 · clearing account 0.00 · all closing checks pass");
  assert.equal(systemText("إعادة فتح الشهر 2026-10", "en"), "Reopen month 2026-10");
  // The later months are joined with the Arabic comma when stored; English reads ", ".
  assert.equal(systemText("شهور بعده مقفولة: 2026-11، 2026-12", "en"), "Later months closed: 2026-11, 2026-12");
});

test("the other modules' request titles and summaries read in English (names as stored)", () => {
  const cases: [string, string][] = [
    // hr/service.ts (expense), hr/custody.ts
    ["مصروف EXP-1: QA expense", "Expense EXP-1: QA expense"],
    ["90000.00 ج.م — مصروفات عمومية", "EGP 90000.00 — مصروفات عمومية"],
    ["عهدة شراء CA-1 لـ Ali من Main cash", "Purchasing custody CA-1 for Ali from Main cash"],
    ["500.00 ج.م · REF-7", "EGP 500.00 · REF-7"],
    // stock-service.ts and inventory/documents.ts (grading loss)
    ["اعتماد خسارة فرز · RC-2026-00001 · Tomato", "Grading loss approval · RC-2026-00001 · Tomato"],
    ["هالك 12 KG بقيمة 50.00 ج.م — البضاعة محجوزة في Q1 لحد الموافقة", "Waste 12 kg worth EGP 50.00 — goods held in Q1 until approved"],
    ["هالك 12 KG (التكلفة مش معروفة) — البضاعة محجوزة في Q1 لحد الموافقة", "Waste 12 kg (cost unknown) — goods held in Q1 until approved"],
    ["هالك 12 KG بقيمة 50.00 ج.م — المخرجات محجوزة في Q1 لحد الموافقة", "Waste 12 kg worth EGP 50.00 — output held in Q1 until approved"],
    // sales/price-exceptions.ts
    ["اعتماد أسعار أوردر ORD-1 · Customer A", "Prices on order ORD-1 · Customer A"],
    ["Tomato: خصم 20% أكبر من الحد 10% · Onion: صافي 5.00 لكل KG أقل من التكلفة 6.00", "Tomato: discount 20% above the limit 10% · Onion: net 5.00 per KG below the cost 6.00"],
    // purchasing/bills.ts
    ["فيها استلام مالوش سعر متفق عليه نطابق عليه", "A receipt on it has no agreed price to match against"],
    ["الفاتورة 100.00 قبل الضريبة، والمتفق عليه 90.00 — فرق 10.00", "Bill 100.00 before tax, agreed 90.00 — difference 10.00"],
    ["فاتورة خدمة إجماليها 5000.00 — أكبر من حد الاعتماد 1000.00", "Service bill of 5000.00 — above the approval limit 1000.00"],
    // inventory/dispatch.ts
    ["قفل استثناء صرف بدون حركة مخزون · Tomato", "Close an issue exception without a stock movement · Tomato"],
    ["أوردر ORD-1: خرج 5 KG واتصرف 3", "Order ORD-1: 5 kg went out, 3 issued"],
    // purchasing/orders.ts, purchasing/requests.ts, sales/credit.ts, accounting/cash.ts
    ["أمر شراء PO-1 · Supplier A", "Purchase order PO-1 · Supplier A"],
    ["طلب شراء PR-1 · Tomato", "Purchase request PR-1 · Tomato"],
    ["ائتمان أوردر ORD-1 · Customer A", "Order credit ORD-1 · Customer A"],
    ["سداد SP-1 لـ Supplier A من Main cash", "Payment SP-1 to Supplier A from Main cash"],
    ["إعادة فتح السنة المالية 2026", "Reopen fiscal year 2026"],
  ];
  for (const [ar, en] of cases) assert.equal(systemText(ar, "en"), en, ar);
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

test("the bell names each type with the same English as the inbox (approvals.type.* dictionary)", () => {
  const dict = DICTIONARY as Record<string, { ar: string; en: string } | undefined>;
  const differ = Object.entries(APPROVAL_TYPES)
    .filter(([k, d]) => dict[`approvals.type.${k}`] && systemText(d.label, "en") !== dict[`approvals.type.${k}`]!.en)
    .map(([k]) => k);
  assert.deepEqual(differ, []);
});

test("approval templates are read one way: English someone typed is never rewritten in Arabic mode", () => {
  for (const typed of ["by mistake", "customers", "suppliers", "other balances", "Transfer 5: a → b", "batches posted: 1"]) assert.equal(systemText(typed, "ar"), typed, typed);
  // …nor do their English words become identifiers that English mode capitalises.
  assert.equal(systemText("customers", "en"), "customers");
  assert.equal(systemText("suppliers · 2 lines", "en"), "suppliers · 2 lines");
});

test("Arabic reads as stored", () => {
  assert.equal(systemText("تحويل CT-2026-00001: الخزينة الرئيسية ← الحساب البنكي", "ar"), "تحويل CT-2026-00001: الخزينة الرئيسية ← الحساب البنكي");
});
