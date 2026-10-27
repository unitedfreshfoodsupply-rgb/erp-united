import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "@/lib/data-import/csv";

test("CSV parser handles BOM, quoted commas, escaped quotes, and CRLF", () => {
  assert.deepEqual(parseCsv('\uFEFFname,notes\r\n"Hotel, Cairo","Says ""deliver early"""\r\n', ["name"]), [
    { rowNumber: 2, values: { name: "Hotel, Cairo", notes: 'Says "deliver early"' } },
  ]);
});

test("CSV parser detects semicolon files saved from spreadsheet apps", () => {
  assert.deepEqual(parseCsv("name;sku\nتفاح;A-01\n", ["name", "sku"])[0].values, { name: "تفاح", sku: "A-01" });
});

test("CSV parser rejects duplicate headers and unclosed quoted cells", () => {
  assert.throws(() => parseCsv("name,name\na,b\n", ["name"]), /عنوان عمود مكرر/);
  assert.throws(() => parseCsv('name\n"not closed\n', ["name"]), /خلية مفتوحة/);
});

test("CSV parser refuses nonempty cells beyond the declared headers instead of dropping them", () => {
  assert.throws(() => parseCsv("name,phone\nCustomer,0100,unexpected-value\n", ["name"]), /صف 2 فيه بيانات زيادة/);
  assert.deepEqual(parseCsv("name,phone\nCustomer,0100,\n", ["name", "phone"])[0].values, { name: "Customer", phone: "0100" });
  assert.equal(parseCsv("name,phone\n\nCustomer,0100\n", ["name", "phone"])[0].rowNumber, 3);
});

test("CSV parser maps header aliases (name_en → name, code → sku) and keeps both names intact", () => {
  const [row] = parseCsv("code,name_en,name_ar,unit\nMNG-01,Mango Keitt,مانجو كيت,KG\n", ["name", "unit"], { name_en: "name", code: "sku" });
  assert.deepEqual(row.values, { sku: "MNG-01", name: "Mango Keitt", name_ar: "مانجو كيت", unit: "KG" });
});

test("CSV parser refuses two columns that mean the same field instead of letting one overwrite the other", () => {
  assert.throws(() => parseCsv("name,name_en\nA,B\n", ["name"], { name_en: "name" }), /name و name_en/);
});
