/* Sales documents against PostgreSQL: the database itself keeps issued invoices and
   credit notes immutable, and concurrent credit notes can never over-credit a line. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, taxNo } from "./_db";
import { createCustomer } from "@/lib/sales/customers";
import { createCreditNote, issueInvoice } from "@/lib/sales/invoicing";

const TAG = `ZZSLG${Date.now()}`;
const acct = actor("محاسب", ["sales.invoices.manage", "sales.invoices.view", "sales.customers.manage"]);
let invoiceId = "";
let lineId = "";

before(async () => {
  const c = await createCustomer({ name: `${TAG} Customer`, tax_registration_no: taxNo() }, acct);
  const inv = await prisma.salesInvoice.create({
    data: {
      customerId: c.id,
      gross: new Prisma.Decimal("100"), discountTotal: new Prisma.Decimal(0), net: new Prisma.Decimal("100"), taxTotal: new Prisma.Decimal(0), total: new Prisma.Decimal("100"),
      createdBy: "test",
      lines: { create: { lineNo: 1, description: "Mango", uomCode: "KG", quantity: new Prisma.Decimal(10), unitPrice: new Prisma.Decimal(10), taxCode: "EXEMPT", taxRate: new Prisma.Decimal(0), gross: new Prisma.Decimal(100), discount: new Prisma.Decimal(0), net: new Prisma.Decimal(100), tax: new Prisma.Decimal(0), total: new Prisma.Decimal(100) } },
    },
    include: { lines: true },
  });
  invoiceId = inv.id;
  lineId = inv.lines[0].id;
  await issueInvoice(invoiceId, {}, acct);
});
after(() => prisma.$disconnect());

test("an issued invoice cannot be changed or deleted, even with raw SQL", async () => {
  await assert.rejects(prisma.$executeRaw`UPDATE "SalesInvoice" SET "total" = 1, "net" = 1, "gross" = 1 WHERE "id" = ${invoiceId}`, /cannot change/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "SalesInvoice" WHERE "id" = ${invoiceId}`, /never deleted/);
  await assert.rejects(prisma.$executeRaw`UPDATE "SalesInvoiceLine" SET "quantity" = 1 WHERE "id" = ${lineId}`, /cannot change/);
  await assert.rejects(
    prisma.$executeRaw`INSERT INTO "SalesInvoiceLine" ("id","invoiceId","lineNo","description","uomCode","quantity","unitPrice","taxCode","taxRate","gross","discount","net","tax","total") VALUES (${`${TAG}-x`}, ${invoiceId}, 2, 'x', 'KG', 1, 1, 'EXEMPT', 0, 1, 0, 1, 0, 1)`,
    /cannot change/
  );
  const inv = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  assert.equal(inv.total.toString(), "100");
});

test("totals that do not add up are refused by the database", async () => {
  const c = await prisma.customer.findFirstOrThrow({ where: { name: `${TAG} Customer` } });
  await assert.rejects(
    prisma.salesInvoice.create({ data: { customerId: c.id, gross: new Prisma.Decimal(10), discountTotal: new Prisma.Decimal(0), net: new Prisma.Decimal(10), taxTotal: new Prisma.Decimal(1), total: new Prisma.Decimal(10), createdBy: "x" } }),
    /SalesInvoice_totals/
  );
});

test("concurrent credit notes never credit more than was invoiced", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, () => createCreditNote(invoiceId, { reason: "مرتجع", lines: [{ invoice_line_id: lineId, quantity: 3 }] }, acct).then(() => "ok", () => "refused"))
  );
  assert.equal(results.filter((r) => r === "ok").length, 3, "3 × 3 kg fit in 10 kg");
  const sum = await prisma.creditNoteLine.aggregate({ where: { invoiceLineId: lineId }, _sum: { quantity: true, total: true } });
  assert.equal(sum._sum.quantity?.toString(), "9");
  assert.equal(sum._sum.total?.toString(), "90");
});

test("credit notes are append-only", async () => {
  const cn = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId } });
  await assert.rejects(prisma.$executeRaw`UPDATE "CreditNote" SET "total" = 1 WHERE "id" = ${cn.id}`, /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "CreditNoteLine" WHERE "creditNoteId" = ${cn.id}`, /append-only/);
});
