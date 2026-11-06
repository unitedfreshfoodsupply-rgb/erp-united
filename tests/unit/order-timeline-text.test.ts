/* ORD-09: what the order timeline stores for a held order's shortfalls and a line's price
   reads in English; the stored Arabic is unchanged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { systemText } from "@/lib/locale/system-text";

test("an awaiting-stock shortfall line reads in English, units as words", () => {
  assert.equal(
    systemText("ZZLOADD P10: المطلوب 5 KG، المتاح 2 KG، الناقص 3 KG · مانجو: المطلوب 2 BOX، المتاح 10، الناقص 5 KG", "en"),
    "ZZLOADD P10: requested 5 kg, available 2 kg, short 3 kg · مانجو: requested 2 box, available 10, short 5 kg"
  );
  // Arabic readers get the stored text, with unit words.
  assert.equal(systemText("مانجو: المطلوب 5 KG، المتاح 2 KG، الناقص 3 KG", "ar"), "مانجو: المطلوب 5 كجم، المتاح 2 كجم، الناقص 3 كجم");
});

test("a line price as audited reads in English", () => {
  assert.equal(systemText("10 (خصم 0%)", "en"), "10 (discount 0%)");
  assert.equal(systemText("10 (خصم 5%) · عند تسجيل الأوردر", "en"), "10 (discount 5%) · at order entry");
  assert.equal(systemText("12.5 (خصم 0%) · list", "en"), "12.5 (discount 0%) · list");
});

test("a return reason on the timeline reads in English", () => {
  assert.equal(systemText("مرتجع على INV-2026-00002: كسر", "en"), "Return on INV-2026-00002: كسر");
  assert.equal(systemText("اتحفظ مستني بضاعة — مفيش أي كمية محجوزة لحد الإفراج", "en"), "Saved awaiting stock — nothing is reserved until it is released");
});

test("the reasons the system writes when it releases a held order or prices a line at entry read in English", () => {
  // lib/sales/stock-hold.ts releaseHeldOrder, when no reason was typed.
  assert.equal(systemText("البضاعة اتوفرت — كل السطور اتحجزت", "en"), "Stock arrived — every line is reserved");
  // lib/sales/pricing.ts, a line priced at order entry with no list price.
  assert.equal(systemText("سعر متفق عليه مع العميل عند تسجيل الأوردر", "en"), "Price agreed with the customer at order entry");
  // Arabic readers get them as stored.
  assert.equal(systemText("سعر متفق عليه مع العميل عند تسجيل الأوردر", "ar"), "سعر متفق عليه مع العميل عند تسجيل الأوردر");
});
