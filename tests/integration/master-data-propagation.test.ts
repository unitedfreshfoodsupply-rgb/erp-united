/* A customer or supplier is one record, referenced by id (Nov 2026): an authorised edit
   reaches every current-data view at once — lists, search, statements, aging, purchase
   orders — through live joins, with field-level audit; it never rewrites an issued invoice
   or a posted journal narrative; and no document table carries an editable copy of a party
   attribute beyond the reviewed, classified list below. Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, taxNo } from "./_db";
import { createCustomer, createLegalEntityForCustomer, listCustomers, updateCustomer } from "@/lib/sales/customers";
import { agingReport, customerStatement, issueInvoice, listInvoices } from "@/lib/sales/invoicing";
import { createSupplierFull, listSuppliersFull, updateSupplierTerms } from "@/lib/purchasing/suppliers";
import { listPurchaseOrders } from "@/lib/purchasing/orders";
import { listSuppliers, updateSupplier } from "@/lib/stock-service";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZPRP${Date.now()}`;
const D = (v: number) => new Prisma.Decimal(v);
const sales = actor("مدير مبيعات", ["sales.customers.view", "sales.customers.manage", "sales.invoices.manage", "sales.invoices.view"], "prp-sales");
const buyer = actor("مشتريات", ["purchasing.suppliers.view", "purchasing.suppliers.manage", "purchasing.orders.view"], "prp-buyer");
const stock = actor("مخازن", ["stock.view", "stock.manage_suppliers"], "prp-stock");
const viewer = actor("مشرف", ["sales.customers.view", "purchasing.suppliers.view", "purchasing.orders.view"], "prp-viewer");

after(async () => { await prisma.$disconnect(); });

test("a customer rename reaches lists, search, statement and aging; the issued invoice keeps its buyer", async () => {
  const c = await createCustomer({ name: `${TAG} مطعم الفيروز`, tax_registration_no: taxNo() }, sales);
  await createLegalEntityForCustomer(c.id, { country: "EG", governate: "Cairo", region_city: "Zamalek", street: "26 July", building_number: "3" }, sales);
  const product = await prisma.stockProduct.create({ data: { name: `${TAG} Lemon` } });
  const draft = await prisma.salesInvoice.create({
    data: {
      customerId: c.id, buyerName: c.name, gross: D(300), discountTotal: D(0), net: D(300), taxTotal: D(0), total: D(300), createdBy: "test",
      lines: { create: { lineNo: 1, productId: product.id, description: "Lemon", uomCode: "KG", quantity: D(6), unitPrice: D(50), taxCode: "EXEMPT", taxRate: D(0), gross: D(300), discount: D(0), net: D(300), tax: D(0), total: D(300) } },
    },
  });
  await issueInvoice(draft.id, {}, sales);
  const issued = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: draft.id } });

  const cur = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
  const renamed = `${TAG} مطعم الفيروز الجديد`;
  await updateCustomer(c.id, { name: renamed, expected_version: cur.version }, sales);
  // Field-level audit of the rename.
  const a = await prisma.auditLog.findFirst({ where: { entityId: c.id, fieldChanged: "name" }, orderBy: { timestamp: "desc" } });
  assert.deepEqual([a?.oldValue, a?.newValue], [c.name, renamed]);

  // Current-data views: invoice list (live customer), customer search, statement, aging.
  const list = await listInvoices({ customerId: c.id });
  const row = list.items.find((i) => i.id === issued.id);
  assert.equal(row?.customer?.name, renamed);
  assert.equal(row?.buyerName, issued.buyerName, "the issued invoice keeps the buyer name it was issued with");
  const found = await listCustomers({ q: "الفيروز الجديد" } as any);
  assert.ok(JSON.stringify(found).includes(c.id), "search finds the customer by the new name");
  const st = await customerStatement(c.id, "2000-01-01", todayLocalISO());
  assert.equal(st.customer.nameEn, renamed);
  const aging = await agingReport();
  assert.ok(JSON.stringify(aging).includes(renamed), "aging shows the current name");

  // The invoice row itself is untouched (and the database refuses to touch it).
  const after = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: issued.id } });
  assert.deepEqual([after.buyerName, after.buyerTaxId, after.buyerAddress, after.customerId], [issued.buyerName, issued.buyerTaxId, issued.buyerAddress, c.id]);
});

test("a supplier rename reaches the supplier lists and its purchase orders; the PO stores only the id", async () => {
  const s = await createSupplierFull({ name: `${TAG} Farm`, name_ar: `${TAG} مزرعة الخير`, category: "vegetable" }, buyer);
  const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { active: true } });
  const po = await prisma.purchaseOrder.create({
    data: { number: `PO-2099-${String(Date.now()).slice(-7)}`, status: "draft", supplierId: s.id, warehouseId: warehouse.id, orderDate: todayLocalISO(), currencyCode: "EGP", paymentTermsDays: 0, net: D(0), taxTotal: D(0), total: D(0), createdBy: "test" },
  });
  // Only the stock supplier permission may rename; the rule holds in the service itself.
  await assert.rejects(updateSupplier(s.id, { name: `${TAG} X` }, viewer as any, s.version), (e: any) => e.status === 403);
  await assert.rejects(updateSupplierTerms(s.id, { name_ar: "X" }, viewer), (e: any) => e.status === 403);
  await updateSupplier(s.id, { name: `${TAG} Farm New` }, stock as any, s.version);
  const fresh = await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } });
  await updateSupplierTerms(s.id, { name_ar: `${TAG} مزرعة الخير الجديدة`, expected_version: fresh.version }, buyer);
  const audits = await prisma.auditLog.findMany({ where: { entityId: s.id, fieldChanged: { not: null } }, select: { fieldChanged: true, oldValue: true, newValue: true } });
  assert.ok(audits.some((x) => x.newValue === `${TAG} Farm New`), "rename audited field by field");
  assert.ok(audits.some((x) => x.newValue === `${TAG} مزرعة الخير الجديدة`), "Arabic name change audited field by field");

  const pos = await listPurchaseOrders({ supplierId: s.id }, viewer);
  const p = (pos as any[]).find((x) => x.id === po.id) ?? (pos as any).orders?.find?.((x: any) => x.id === po.id);
  assert.ok(JSON.stringify(p).includes(`${TAG} Farm New`) || JSON.stringify(p).includes(`${TAG} مزرعة الخير الجديدة`), "the PO list shows the current supplier");
  assert.ok(!JSON.stringify(p).includes(`"${TAG} Farm"`), "no stale supplier name on the PO");
  assert.ok((await listSuppliersFull({ q: "الخير الجديدة" })).some((x) => x.id === s.id));
  assert.ok((await listSuppliers()).some((x: any) => x.id === s.id && x.name === `${TAG} Farm New`));
});

test("no document table holds an editable copy of a party attribute outside the reviewed list", () => {
  // Every scalar column, in every model, whose name looks like a customer/supplier attribute.
  const party = /^(customer|supplier|buyer|receiver|party)(Name|Phone|Email|Address|TaxId|TaxRegistrationNo|LegalName)$|^(buyerName|buyerTaxId|buyerAddress|customerName|supplierName)$/;
  const found: string[] = [];
  for (const m of Prisma.dmmf.datamodel.models) for (const f of m.fields) if (f.kind === "scalar" && party.test(f.name)) found.push(`${m.name}.${f.name}`);
  // Reviewed (MASTER_DATA_ARCHITECTURE_2026-11.md §2): the invoice's legal snapshot, frozen at
  // issue; the order's name as received from the intake integration (a live join is shown
  // when the order is mapped); and who signed for a delivery (a delivery fact, not master data).
  assert.deepEqual(found.sort(), ["Order.customerName", "SalesInvoice.buyerAddress", "SalesInvoice.buyerName", "SalesInvoice.buyerTaxId", "TripStop.receiverName"]);
});
