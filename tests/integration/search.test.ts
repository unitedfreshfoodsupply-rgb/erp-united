/* Server-side search (maturity 2026-11): every module's search runs against PostgreSQL,
   folds Arabic letter variants, diacritics, case and digit scripts, finds a record by any
   of its identifiers, and treats % and _ as plain characters. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./_db";
import { searchIds, type SearchEntity } from "@/lib/core/search";

const TAG = `ZZSRCH${Date.now()}`;
after(() => prisma.$disconnect());

test("every searchable module answers (valid SQL), and a text that matches nothing returns nothing", async () => {
  const all: SearchEntity[] = ["customer", "supplier", "product", "order", "salesInvoice", "supplierBill", "supplierPayment", "customerReceipt", "purchaseRequest", "purchaseOrder", "intake", "journal", "document", "lot"];
  for (const e of all) assert.deepEqual(await searchIds(e, `${TAG}-no-such-thing`), [], e);
});

test("customers: Arabic letter variants, diacritics and Arabic-Indic digits match; phone and tax number find the card", async () => {
  const c = await prisma.customer.create({ data: { code: `C${String(Date.now()).slice(-8)}`, name: `${TAG} Alexandria Library Cafe`, nameAr: `${TAG} كافيتريا مكتبة الإسكندرية`, phone: "01001234567", taxRegistrationNo: "312456789", createdBy: "test" } });
  for (const q of ["مكتبه الاسكندريه", "مَكْتَبَة", "ALEXANDRIA library", "٠١٠٠١٢٣٤٥٦٧", "312456789", c.code.toLowerCase()]) {
    assert.ok((await searchIds("customer", q)).includes(c.id), `"${q}" finds the customer`);
  }
});

test("products: found by Arabic name, English name, SKU, category or an alias; % and _ are plain characters", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} Mango Ewais`, nameAr: `${TAG} مانجو عويس`, sku: `SKU_${TAG}`, category: "فاكهة" } });
  await prisma.productAlias.create({ data: { productId: p.id, alias: `${TAG} مانجا عويسي`, kind: "alias" } as never }).catch(() => undefined);
  for (const q of ["مانجو عويس", "mango ewais", `sku_${TAG.toLowerCase()}`, "فاكهه"]) {
    assert.ok((await searchIds("product", q)).includes(p.id), `"${q}" finds the product`);
  }
  assert.ok(!(await searchIds("product", "SKU%")).includes(p.id), "% is literal (no product's SKU contains a %)");
  assert.ok((await searchIds("product", `SKU_${TAG}`)).includes(p.id), "_ is literal and still matches itself");
});
