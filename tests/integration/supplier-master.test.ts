/* One supplier editor (Nov 2026): every route reaches updateSupplierMaster, which decides who may
   change what — the stock permission edits name, phone, notes and active; everything else (the
   category, type, tax data, terms, the Arabic name) needs purchasing.suppliers.manage — versioned
   and audited field by field. The supplier category is a closed, structured attribute.
   Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor, taxNo } from "./_db";
import { createSupplierFull, listSuppliersFull, updateSupplierMaster } from "@/lib/purchasing/suppliers";
import { createSupplier, updateSupplier } from "@/lib/stock-service";
import { localizeServerMessage } from "@/lib/locale/server-messages";

const TAG = `ZZSUPM${Date.now()}`;
const buyer = actor("مشتريات", ["purchasing.suppliers.view", "purchasing.suppliers.manage"], "supm-buyer");
const stock = actor("مخازن", ["stock.view", "stock.manage_suppliers"], "supm-stock");
const viewer = actor("مشرف", ["purchasing.suppliers.view", "stock.view"], "supm-viewer");
const status = (code: number) => (e: any) => e?.status === code;

after(async () => { await prisma.$disconnect(); });

test("category (D-1): required on every normal creation and edit; only the stock gate's quick add starts unclassified; closed in the database", async () => {
  const veg = await createSupplierFull({ name: `${TAG} Veg Farm`, name_ar: `${TAG} مزرعة خضار`, category: "vegetable" }, buyer);
  const fruit = await createSupplierFull({ name: `${TAG} Fruit Farm`, category: "fruit" }, buyer);
  // A third category for services and non-produce suppliers (maintenance, contractors, landlords, asset vendors).
  const services = await createSupplierFull({ name: `${TAG} Maintenance Co`, category: "other" }, buyer);
  assert.equal(services.category, "other");
  // Normal creation without a category is refused, with nothing written.
  await assert.rejects(createSupplierFull({ name: `${TAG} No Category` }, buyer), (e: any) => e.status === 400 && e.message === "فئة المورد مطلوبة — اختار خضار أو فاكهة أو أخرى/خدمات");
  await assert.rejects(createSupplierFull({ name: `${TAG} Null Category`, category: null }, buyer), status(400));
  assert.equal(await prisma.supplier.count({ where: { name: { in: [`${TAG} No Category`, `${TAG} Null Category`] } } }), 0);
  assert.equal(localizeServerMessage("فئة المورد مطلوبة — اختار خضار أو فاكهة أو أخرى/خدمات", "en"), "The supplier category is required — choose vegetables, fruit or other/services");
  // The stock gate may add a farmer on the spot: unclassified, visibly so, until purchasing classifies it.
  const none = await createSupplier({ name: `${TAG} مزارع على الباب` }, stock as any);
  assert.deepEqual([veg.category, fruit.category, none.category], ["vegetable", "fruit", null]);

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).filter((id) => [veg.id, fruit.id, services.id, none.id].includes(id)).sort();
  assert.deepEqual(ids(await listSuppliersFull({ q: TAG, category: "vegetable" })), [veg.id]);
  assert.deepEqual(ids(await listSuppliersFull({ q: TAG, category: "fruit" })), [fruit.id]);
  assert.deepEqual(ids(await listSuppliersFull({ q: TAG, category: "other" })), [services.id]);
  assert.deepEqual(ids(await listSuppliersFull({ q: TAG, category: "none" })), [none.id], "the unclassified are listed on their own, never inside a category");
  assert.deepEqual(ids(await listSuppliersFull({ q: TAG, category: "bogus" })), [veg.id, fruit.id, services.id, none.id].sort(), "an unknown filter value filters nothing");

  await assert.rejects(createSupplierFull({ name: `${TAG} X`, category: "herbs" }, buyer), (e: any) => e.status === 400 && e.message === "فئة المورد لازم خضار أو فاكهة أو أخرى/خدمات");
  assert.equal(localizeServerMessage("فئة المورد لازم خضار أو فاكهة أو أخرى/خدمات", "en"), "The supplier category must be vegetables, fruit or other/services");
  await assert.rejects(updateSupplierMaster(none.id, { category: "herbs" }, buyer), status(400));
  // The database refuses an unknown category whatever writes it.
  await assert.rejects(prisma.$executeRaw`UPDATE "Supplier" SET "category" = 'herbs' WHERE "id" = ${none.id}`, /Supplier_category_known/);
  // Classifying is purchasing's: the stock permission cannot do it.
  await assert.rejects(updateSupplierMaster(none.id, { category: "fruit", expected_version: none.version }, stock), status(403));

  const moved = await updateSupplierMaster(none.id, { category: "fruit", expected_version: none.version }, buyer);
  assert.equal(moved.category, "fruit");
  const a = await prisma.auditLog.findFirst({ where: { entityId: none.id, fieldChanged: "category" } });
  assert.deepEqual([a?.action, a?.oldValue, a?.newValue, a?.userName], ["supplier_terms_changed", null, "fruit", "مشتريات"]);
  // A classified supplier cannot be made unclassified again; a re-classification is audited.
  await assert.rejects(updateSupplierMaster(none.id, { category: null, expected_version: moved.version }, buyer), status(400));
  const vegNow = await updateSupplierMaster(none.id, { category: "vegetable", expected_version: moved.version }, buyer);
  assert.equal(vegNow.category, "vegetable");
  const trail = await prisma.auditLog.findMany({ where: { entityId: none.id, fieldChanged: "category" }, orderBy: { timestamp: "asc" }, select: { oldValue: true, newValue: true } });
  assert.deepEqual(trail.map((x) => [x.oldValue, x.newValue]), [[null, "fruit"], ["fruit", "vegetable"]]);
});

test("the stock permission edits identity fields only; the rule holds in the service, whichever route calls it", async () => {
  const s = await createSupplier({ name: `${TAG} مزارع البوابة`, phone: "0100" }, stock as any);
  assert.equal(s.category, null, "a supplier met at the gate starts unclassified");

  // Stock: name, phone, notes, active — through either entry point.
  const v1 = await updateSupplierMaster(s.id, { name: `${TAG} مزارع البوابة الجديد`, phone: "0111", expected_version: s.version }, stock);
  const v2 = await updateSupplier(s.id, { notes: "يورّد صبح بدري" }, stock as any, v1.version);
  assert.deepEqual([v2.name, v2.phone, v2.notes], [`${TAG} مزارع البوابة الجديد`, "0111", "يورّد صبح بدري"]);

  // ...but not the category, type, tax data, terms or Arabic name, even beside an allowed field.
  for (const body of [{ category: "vegetable" }, { type: "farm" }, { tax_registration_no: "123456789" }, { payment_terms_days: 30 }, { name_ar: "x" }, { name: "Y", category: "fruit" }]) {
    await assert.rejects(updateSupplierMaster(s.id, { ...body, expected_version: v2.version }, stock), status(403), JSON.stringify(body));
  }
  // Neither permission: refused before anything is read or written.
  await assert.rejects(updateSupplierMaster(s.id, { name: "Z" }, viewer), status(403));
  await assert.rejects(updateSupplier(s.id, { active: false }, viewer as any, v2.version), status(403));
  const unchanged = await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual([unchanged.version, unchanged.category, unchanged.type, unchanged.taxRegistrationNo, unchanged.paymentTermsDays], [v2.version, null, s.type, null, 0]);

  // Purchasing edits the whole record in one save.
  const tax = taxNo();
  const full = await updateSupplierMaster(s.id, { name: `${TAG} Gate Farm`, name_ar: `${TAG} مزرعة البوابة`, category: "vegetable", type: "grower", tax_registration_no: `${tax.slice(0, 4)}-${tax.slice(4)}`, payment_terms_days: 14, lead_time_days: 1, active: true, expected_version: v2.version }, buyer);
  assert.deepEqual([full.name, full.nameAr, full.category, full.type, full.taxRegistrationNo, full.paymentTermsDays, full.leadTimeDays], [`${TAG} Gate Farm`, `${TAG} مزرعة البوابة`, "vegetable", "grower", tax, 14, 1]);

  // A stale version is refused, with nothing written.
  await assert.rejects(updateSupplierMaster(s.id, { phone: "0122", expected_version: v2.version }, stock), status(409));
  assert.equal((await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } })).phone, "0111");

  // Every change is one audit row per field, under the action that matches its kind.
  const audits = await prisma.auditLog.findMany({ where: { entityId: s.id, fieldChanged: { not: null } }, orderBy: { timestamp: "asc" }, select: { action: true, fieldChanged: true, oldValue: true, newValue: true, userName: true } });
  const by = (f: string) => audits.filter((x) => x.fieldChanged === f).map((x) => [x.action, x.oldValue, x.newValue, x.userName]);
  assert.deepEqual(by("name"), [["supplier_updated", `${TAG} مزارع البوابة`, `${TAG} مزارع البوابة الجديد`, "مخازن"], ["supplier_updated", `${TAG} مزارع البوابة الجديد`, `${TAG} Gate Farm`, "مشتريات"]]);
  assert.deepEqual(by("notes"), [["supplier_updated", null, "يورّد صبح بدري", "مخازن"]]);
  assert.deepEqual(by("category"), [["supplier_terms_changed", null, "vegetable", "مشتريات"]]);
  assert.deepEqual(by("taxRegistrationNo"), [["supplier_terms_changed", null, tax, "مشتريات"]]);
  assert.equal(by("active").length, 0, "an unchanged field writes no audit row");
});

test("a supplier rename never rewrites history: earlier audit rows stay as they were", async () => {
  const s = await createSupplierFull({ name: `${TAG} Old Name`, category: "fruit" }, buyer);
  const created = await prisma.auditLog.findFirstOrThrow({ where: { entityId: s.id, action: "supplier_created" } });
  await updateSupplierMaster(s.id, { name: `${TAG} New Name`, expected_version: s.version }, buyer);
  const again = await prisma.auditLog.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(again.newValue, created.newValue);
  assert.ok(again.newValue?.includes(`${TAG} Old Name`), "the creation event still names the supplier as it was");
});
