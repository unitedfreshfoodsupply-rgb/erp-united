import { test } from "node:test";
import assert from "node:assert/strict";
import { codedLocalName, localName, matchesLocalName, otherLocalName } from "@/lib/locale/names";

const product = { name: "Mango Keitt", nameAr: "مانجو كيت", sku: "MNG-01" };

test("Arabic locale shows the Arabic name, English locale the English name", () => {
  assert.equal(localName(product, "ar"), "مانجو كيت");
  assert.equal(localName(product, "en"), "Mango Keitt");
});

test("a missing translation falls back to the other language, never invents one", () => {
  assert.equal(localName({ name: "Hilton Zamalek", nameAr: null }, "ar"), "Hilton Zamalek");
  assert.equal(localName({ name: "فندق النيل", nameAr: undefined }, "en"), "فندق النيل");
  assert.equal(localName({ nameAr: "طماطم" }, "en"), "طماطم");
});

test("blank and whitespace-only names are ignored; whitespace is normalised", () => {
  assert.equal(localName({ name: "  Tomato   Cherry ", nameAr: "   " }, "ar"), "Tomato Cherry");
  assert.equal(localName({ name: "Tomato", nameAr: "" }, "ar"), "Tomato");
});

test("the code is the last resort before the unnamed label — never undefined or blank", () => {
  assert.equal(localName({ name: " ", nameAr: null, code: "SUP-00007" }, "ar"), "SUP-00007");
  assert.equal(localName({ sku: "A-1" }, "en"), "A-1");
  assert.equal(localName({}, "ar"), "بدون اسم");
  assert.equal(localName(null, "en"), "Unnamed");
  assert.equal(localName(undefined, "ar"), "بدون اسم");
  assert.equal(localName({ name: 42 as unknown as string }, "en"), "Unnamed");
});

test("companies resolve through legalName/tradeName; explicit nameEn wins over a legacy name", () => {
  assert.equal(localName({ legalName: "UNITED Fresh Food Supply", tradeName: "UNITED", nameAr: "يونايتد" }, "en"), "UNITED Fresh Food Supply");
  assert.equal(localName({ legalName: "UNITED Fresh Food Supply", nameAr: "يونايتد" }, "ar"), "يونايتد");
  // Server DTOs keep `name` Arabic-first for old consumers and add nameAr/nameEn.
  assert.equal(localName({ name: "حساب العملاء", nameAr: "حساب العملاء", nameEn: "Accounts receivable" }, "en"), "Accounts receivable");
  assert.equal(localName({ name: "حساب العملاء", nameAr: "حساب العملاء", nameEn: "Accounts receivable" }, "ar"), "حساب العملاء");
});

test("resolving a name never mutates the record", () => {
  const record = { name: " Mango ", nameAr: " مانجو ", code: "P1" };
  const before = JSON.stringify(record);
  localName(record, "ar");
  localName(record, "en");
  otherLocalName(record, "ar");
  assert.equal(JSON.stringify(record), before);
});

test("secondary name is the other language only when it differs", () => {
  assert.equal(otherLocalName(product, "ar"), "Mango Keitt");
  assert.equal(otherLocalName(product, "en"), "مانجو كيت");
  assert.equal(otherLocalName({ name: "Mango" }, "en"), null);
  assert.equal(otherLocalName({ name: "Mango", nameAr: null }, "ar"), null);
});

test("selector labels keep the code separate from the name", () => {
  assert.equal(codedLocalName({ code: "CUS-00001", name: "Hilton", nameAr: "هيلتون" }, "ar"), "CUS-00001 · هيلتون");
  assert.equal(codedLocalName({ code: "CUS-00001", name: "Hilton", nameAr: "هيلتون" }, "en"), "CUS-00001 · Hilton");
  assert.equal(codedLocalName({ code: "CUS-00002" }, "en"), "CUS-00002");
});

test("search matches either language's name or the code, whatever the display locale", () => {
  assert.ok(matchesLocalName(product, "mango"));
  assert.ok(matchesLocalName(product, "مانجو"));
  assert.ok(matchesLocalName(product, "mng-01"));
  assert.ok(!matchesLocalName(product, "tomato"));
  assert.ok(matchesLocalName(product, "  "));
});
