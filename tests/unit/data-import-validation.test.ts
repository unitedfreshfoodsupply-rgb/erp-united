import { test } from "node:test";
import assert from "node:assert/strict";
import { validateImportRow } from "@/lib/data-import/validation";

function check(kind: string, values: Record<string, string>) {
  return validateImportRow(kind, { rowNumber: 2, values }, ["name", "sku", "uom", "qty_in_base_unit"].filter((key) => key in values));
}

test("product settings require a real configuration and enforce costing fields", () => {
  assert.match(check("product_settings", { sku: "A1", costing_method: "standard" }).join(" "), /standard_cost مطلوب/);
  assert.deepEqual(check("product_settings", { sku: "A1", costing_method: "standard", standard_cost: "42.7500", min_stock_qty: "2", reorder_point_qty: "4", max_stock_qty: "3" }).filter((x) => x.includes("أكبر من")), ["reorder_point_qty أكبر من max_stock_qty"]);
  assert.deepEqual(check("product_settings", { sku: "A1", cold_chain: "false", removal_strategy: "fefo" }), []);
});

test("product packaging rejects zero, over-precise and invalid active values", () => {
  assert.match(check("product_packaging", { sku: "A1", uom: "CRATE", qty_in_base_unit: "0", active: "yes" }).join(" "), /qty_in_base_unit/);
  assert.match(check("product_packaging", { sku: "A1", uom: "CRATE", qty_in_base_unit: "1.1234567", active: "yes" }).join(" "), /qty_in_base_unit/);
  assert.match(check("product_packaging", { sku: "A1", uom: "CRATE", qty_in_base_unit: "12.5", active: "yes" }).join(" "), /active لازم/);
});

test("customer opening terms require finance reasons and a hold explanation", () => {
  assert.match(check("customers", { name: "عميل", payment_terms_days: "30" }).join(" "), /credit_reason مطلوب/);
  assert.match(check("customers", { name: "عميل", credit_hold: "true", credit_reason: "اعتماد مالي" }).join(" "), /credit_hold_reason مطلوب/);
  assert.deepEqual(check("customers", { name: "عميل", payment_terms_days: "30", credit_limit: "50000.00", credit_reason: "معتمد من المالية" }), []);
});

test("opening balance import preserves an original due date before the cut-off date", () => {
  assert.deepEqual(check("opening_balances", { party_type: "customer", party_code: "CUS-1", date: "2026-10-09", due_date: "2026-08-30", amount: "500.00" }), []);
});

test("bilingual imports refuse a non-Arabic name_ar and say when the columns look swapped", () => {
  const v = (values: Record<string, string>, kind = "products") => validateImportRow(kind, { rowNumber: 2, values }, ["name"]);
  assert.deepEqual(v({ name: "Mango", name_ar: "مانجو" }), []);
  assert.deepEqual(v({ name: "Mango", name_ar: "" }), []);
  assert.match(v({ name: "مانجو", name_ar: "Mango" }).join(" "), /متبدلين/);
  assert.match(v({ name: "Mango", name_ar: "Mango" }, "suppliers").join(" "), /name_ar لازم يكون الاسم بالعربي/);
  assert.match(v({ name: "Hilton", name_ar: "هيلتون", legal_name: "فندق", legal_name_ar: "Hotel" }, "customers").join(" "), /legal_name_ar و legal_name متبدلين/);
  for (const kind of ["customers", "customer_groups", "customer_legal_entities", "suppliers", "products"]) {
    assert.ok(v({ name: "X", name_ar: "X" }, kind).length > 0, kind);
  }
  // Kinds without names are unaffected.
  assert.deepEqual(validateImportRow("product_packaging", { rowNumber: 2, values: { sku: "A", uom: "BOX", qty_in_base_unit: "5", name_ar: "x" } }, ["sku"]), []);
});

test("customer and supplier codes from the business's records are kept; a malformed one is refused, empty = generated", () => {
  assert.deepEqual(validateImportRow("customers", { rowNumber: 2, values: { name: "Hilton", code: "C-1001" } }, ["name"]), []);
  assert.deepEqual(validateImportRow("suppliers", { rowNumber: 2, values: { name: "Farm", code: "20045" } }, ["name"]), []);
  assert.match(validateImportRow("customers", { rowNumber: 2, values: { name: "Hilton", code: "كود 1" } }, ["name"]).join(" "), /الكود حروف إنجليزي/);
  assert.match(validateImportRow("suppliers", { rowNumber: 2, values: { name: "Farm", code: "-bad code" } }, ["name"]).join(" "), /الكود حروف إنجليزي/);
  assert.match(validateImportRow("customers", { rowNumber: 2, values: { name: "Hilton", code: "CUS-9" } }, ["name"]).join(" "), /محجوزة للترقيم التلقائي/);
  assert.deepEqual(validateImportRow("suppliers", { rowNumber: 2, values: { name: "Farm", code: "" } }, ["name"]), []);
  assert.deepEqual(validateImportRow("customer_groups", { rowNumber: 2, values: { code: "JAZ", name: "Jaz Hotels", name_ar: "جاز" } }, ["code", "name"]), []);
});
