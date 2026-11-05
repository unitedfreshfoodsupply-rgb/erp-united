/* Drafting a supplier bill (Nov 2026): every line looked up its receipt's live bill and its dated
   supplier price on its own (2 statements per line, up to 300 lines). Both are read once now; each
   line still gets the agreed price effectiveSupplierPrice gives, and a receipt already on a live
   bill is refused with the same message. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor } from "./_db";
import { todayLocalISO } from "@/lib/localDate";
import { createIntake } from "@/lib/stock-service";
import { createBill } from "@/lib/purchasing/bills";
import { effectiveSupplierPrice, setSupplierPrices } from "@/lib/purchasing/suppliers";

const TAG = `ZZBLB${Date.now()}`;
const today = todayLocalISO();
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const store = actor("أمين مخزن", ["stock.receive", "stock.view", "stock.valuation.view"], "blb-store");
const buyer = actor("مشتريات", ["purchasing.prices.manage"], "blb-buyer");
const billing = actor("فواتير الموردين", ["purchasing.bills.manage", "purchasing.bills.view"], "blb-bills");
let serial = 0;
const products: { id: string; name: string; unit: string }[] = [];

before(async () => {
  for (let i = 0; i < 4; i++) products.push(await prisma.stockProduct.create({ data: { name: `${TAG} صنف ${i}`, unit: "KG" } }));
});
after(async () => { await prisma.$disconnect(); });

async function supplierWithReceipts(n: number) {
  const s = await prisma.supplier.create({ data: { code: `SUP-6${String(Date.now()).slice(-6)}${serial++}`, name: `${TAG} مورد ${serial}`, category: "vegetable", paymentTermsDays: 0 } });
  // Two dated prices per product: a receipt takes the one valid on its date.
  await setSupplierPrices(s.id, { valid_from: shift(today, -10), prices: products.map((p, i) => ({ product_id: p.id, unit_price: String(5 + i) })) }, buyer);
  await setSupplierPrices(s.id, { valid_from: shift(today, -3), prices: products.slice(0, 2).map((p, i) => ({ product_id: p.id, unit_price: String(7 + i) })) }, buyer);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = products[i % products.length];
    const intake = await createIntake({ supplier_id: s.id, product_id: p.id, received_qty: 10 + i, received_date: shift(today, -(i % 8)), ...(i % 5 === 4 ? { unit_cost: "6.5" } : {}) } as never, store);
    ids.push(intake.id);
  }
  // Receipts from before costs were recorded (unknown cost): their agreed price is the dated supplier price.
  await prisma.stockIntake.updateMany({ where: { id: { in: ids.filter((_, i) => i % 5 === 1 || i % 5 === 3) } }, data: { unitCost: null } });
  return { supplierId: s.id, ids };
}

test("bill lines carry the dated supplier price, read once for all lines", async () => {
  async function measure(n: number) {
    const { supplierId, ids } = await supplierWithReceipts(n);
    const { result: bill, queries } = await countQueries(() => createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-${n}`, bill_date: today, lines: ids.map((id) => ({ intake_id: id, unit_price: "6" })) }, billing));
    const lines = await prisma.supplierBillLine.findMany({ where: { billId: bill.id }, include: { intake: { include: { product: true } } } });
    for (const l of lines) {
      const r = l.intake;
      const sp = await effectiveSupplierPrice(prisma, { supplierId, product: r.product, uom: r.product.unit, date: r.receivedDate });
      const want = r.unitCost != null ? new Prisma.Decimal(r.unitCost) : sp?.unitPrice ?? null;
      assert.equal(l.expectedUnitPrice?.toString() ?? null, want?.toString() ?? null, `${r.receiptNumber} on ${r.receivedDate}`);
    }
    const fromPrice = lines.filter((l) => l.intake.unitCost == null);
    assert.ok(fromPrice.length >= 2, "receipts priced from the supplier price");
    if (n > 8) assert.ok(new Set(fromPrice.map((l) => l.expectedUnitPrice?.toString())).size >= 3, "receipts dated before the newer price take the older one");
    // The same receipt on a second bill is refused, naming the first.
    await assert.rejects(
      createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-${n}-again`, bill_date: today, lines: [{ intake_id: ids[1], unit_price: "6" }] }, billing),
      (e) => (e as { status?: number }).status === 409 && (e as Error).message.includes(`عليه فاتورة ${bill.number} بالفعل`)
    );
    return queries;
  }
  const small = await measure(5), large = await measure(30);
  assert.equal(large, small, `statements to draft a bill: 5 lines ${small}, 30 lines ${large}`);
});
