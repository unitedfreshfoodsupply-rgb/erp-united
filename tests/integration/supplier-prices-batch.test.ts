/* Saving supplier prices in one pass (Nov 2026): setSupplierPrices read and wrote one price at a
   time (~4 statements each), so a CSV import or a price sheet of a few hundred prices ran past the
   20 s transaction limit and saved nothing. The batched save must leave exactly the rows and audit
   rows the one-at-a-time loop leaves — including a product and unit repeated in one request (the
   later line corrects the earlier) and an unchanged price (skipped) — refuse the same lines with
   the same messages, and run a fixed number of statements whatever the number of prices. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { writeAuditMany, type AuditInput } from "@/lib/audit";
import { advisoryXactLock } from "@/lib/dbLock";
import { ApiError } from "@/lib/rbac";
import { setSupplierPrices } from "@/lib/purchasing/suppliers";
import { createPurchaseOrder } from "@/lib/purchasing/orders";

const TAG = `ZZSPB${Date.now()}`;
const buyer = actor("مشتريات", ["purchasing.orders.manage", "purchasing.prices.manage"], null, "BUYER");
const today = todayLocalISO();
const day = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
let serial = 0;
const supplier = () => prisma.supplier.create({ data: { code: `SUP-8${String(Date.now()).slice(-6)}${serial++}`, name: `${TAG} مورد ${serial}`, category: "vegetable", paymentTermsDays: 0 } });
let products: { id: string; name: string }[] = [];

before(async () => {
  products = [];
  for (let i = 0; i < 6; i++) products.push(await prisma.stockProduct.create({ data: { name: `${TAG} صنف ${i}`, unit: "KG" } }));
  await prisma.productPackaging.create({ data: { productId: products[0].id, uomCode: "CRATE", qtyInBaseUnit: new Prisma.Decimal(18) } });
});
after(async () => { await prisma.$disconnect(); });

type Price = { product_id: string; uom?: string; unit_price: string; lead_time_days?: number; notes?: string };

/** The loop as it was before Nov 2026, kept here as the reference the batched save must match. */
async function oneAtATime(supplierId: string, v: { valid_from: string; valid_to?: string | null; prices: Price[] }) {
  const a = (x: Omit<AuditInput, "userId" | "userName" | "role" | "source">): AuditInput => ({ userId: buyer.id, userName: buyer.name, role: buyer.role, source: "user", ...x });
  return inTx(async (tx: Tx) => {
    await advisoryXactLock(tx, `purchasing:supplier-prices:${supplierId}`);
    const s = await tx.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    const audits: AuditInput[] = [];
    let created = 0, replaced = 0;
    for (const p of v.prices) {
      const unitPrice = new Prisma.Decimal(p.unit_price);
      const product = await tx.stockProduct.findUnique({ where: { id: p.product_id }, include: { packagings: true } });
      if (!product) throw new ApiError(404, "الصنف مش موجود");
      const uom = p.uom || product.unit;
      if (uom !== product.unit && !product.packagings.some((x) => x.uomCode === uom && x.active)) {
        const u = await tx.unitOfMeasure.findUnique({ where: { code: uom } });
        const base = await tx.unitOfMeasure.findUnique({ where: { code: product.unit } });
        if (!u || !base || u.category !== base.category || u.category === "package") throw new ApiError(400, `الوحدة ${uom} مش متعرّفة للصنف "${product.name}"`);
      }
      const key = { supplierId_productId_uomCode_validFrom: { supplierId, productId: product.id, uomCode: uom, validFrom: v.valid_from } };
      const existing = await tx.supplierPrice.findUnique({ where: key });
      if (existing) {
        if (existing.unitPrice.equals(unitPrice) && existing.validTo === (v.valid_to ?? null)) continue;
        const used = await tx.purchaseOrderLine.count({ where: { supplierPriceId: existing.id } });
        if (used) throw new ApiError(409, `سعر "${product.name}" من ${v.valid_from} اتعمل بيه أوامر شراء — سجّل السعر الجديد من تاريخ بعده`);
        await tx.supplierPrice.update({ where: { id: existing.id }, data: { unitPrice, validTo: v.valid_to ?? null, leadTimeDays: p.lead_time_days ?? null, notes: p.notes ?? null, createdById: buyer.id, createdBy: buyer.name } });
        audits.push(a({ action: "supplier_price_corrected", entityType: "supplier", entityId: supplierId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, oldValue: existing.unitPrice.toString(), newValue: unitPrice.toString() }));
        replaced++;
      } else {
        await tx.supplierPrice.create({ data: { supplierId, productId: product.id, uomCode: uom, unitPrice, currencyCode: s.currencyCode, validFrom: v.valid_from, validTo: v.valid_to ?? null, leadTimeDays: p.lead_time_days ?? null, notes: p.notes ?? null, createdById: buyer.id, createdBy: buyer.name } });
        audits.push(a({ action: "supplier_price_set", entityType: "supplier", entityId: supplierId, fieldChanged: `${product.name} / ${uom} @ ${v.valid_from}`, newValue: unitPrice.toString() }));
        created++;
      }
    }
    await writeAuditMany(audits, tx);
    return { created, replaced };
  });
}

async function state(supplierId: string) {
  const prices = await prisma.supplierPrice.findMany({ where: { supplierId }, orderBy: [{ productId: "asc" }, { uomCode: "asc" }, { validFrom: "asc" }] });
  const audits = await prisma.auditLog.findMany({ where: { entityType: "supplier", entityId: supplierId }, orderBy: [{ timestamp: "asc" }, { id: "asc" }] });
  return {
    prices: prices.map(({ id: _i, supplierId: _s, createdAt: _c, ...r }) => ({ ...r, unitPrice: r.unitPrice.toString(), minQty: r.minQty?.toString() ?? null })),
    audits: audits.map((x) => [x.action, x.fieldChanged, x.oldValue, x.newValue, x.userName]),
  };
}

const outcome = async (fn: () => Promise<unknown>) => { try { return { ok: await fn() }; } catch (e) { return { status: (e as ApiError).status, message: (e as Error).message }; } };

test("a batched save leaves the rows, audit rows, counts and refusals of the one-at-a-time loop", async () => {
  const [p0, p1, p2, p3, p4] = products;
  const rounds: { valid_from: string; valid_to?: string | null; prices: Price[] }[] = [
    // New prices, a packaging, a convertible unit, and one product+unit given twice (the second corrects the first).
    { valid_from: day, prices: [
      { product_id: p0.id, unit_price: "10" }, { product_id: p0.id, uom: "CRATE", unit_price: "175.5", lead_time_days: 2 },
      { product_id: p1.id, uom: "G", unit_price: "0.02" }, { product_id: p2.id, unit_price: "5" }, { product_id: p2.id, uom: "KG", unit_price: "6", notes: "تصحيح" },
      { product_id: p3.id, unit_price: "7" },
    ] },
    // Same day again: an unchanged price is skipped, changed ones corrected, a new one added.
    { valid_from: day, prices: [{ product_id: p0.id, unit_price: "10.0000" }, { product_id: p1.id, uom: "G", unit_price: "0.03" }, { product_id: p3.id, unit_price: "8", notes: "x" }, { product_id: p4.id, unit_price: "9" }] },
    // An end date makes an equal price a correction.
    { valid_from: day, valid_to: today, prices: [{ product_id: p0.id, unit_price: "10" }, { product_id: p2.id, unit_price: "6" }] },
    // Refusals: an undeclared package unit, an unknown product, in the order given.
    { valid_from: day, prices: [{ product_id: p4.id, unit_price: "1" }, { product_id: p1.id, uom: "BOX", unit_price: "3" }, { product_id: "nope", unit_price: "1" }] },
    { valid_from: day, prices: [{ product_id: p4.id, unit_price: "2" }, { product_id: "nope", unit_price: "1" }, { product_id: p1.id, uom: "BOX", unit_price: "3" }] },
    { valid_from: day, prices: [{ product_id: p1.id, uom: "L", unit_price: "3" }] },
  ];
  const [a, b] = [await supplier(), await supplier()];
  for (const r of rounds) {
    const old = await outcome(() => oneAtATime(a.id, r));
    const now = await outcome(() => setSupplierPrices(b.id, r, buyer));
    assert.deepEqual(now, old, `outcome of ${JSON.stringify(r.prices.map((p) => p.unit_price))}`);
  }
  const [sa, sb] = [await state(a.id), await state(b.id)];
  assert.ok(sa.prices.length >= 6 && sa.audits.length >= 8);
  assert.deepEqual(sb, sa);
});

test("a price already used on a purchase order is refused with the same 409, nothing saved", async () => {
  const restoreDate = today;
  const s = await supplier();
  await setSupplierPrices(s.id, { valid_from: restoreDate, prices: [{ product_id: products[5].id, unit_price: "4" }] }, buyer);
  await createPurchaseOrder({ supplier_id: s.id, lines: [{ product_id: products[5].id, quantity: 3 }] }, buyer);
  const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { po: { supplierId: s.id } } });
  assert.ok(line.supplierPriceId, "the PO line was priced from the agreed price");
  const before = await state(s.id);
  await assert.rejects(
    setSupplierPrices(s.id, { valid_from: restoreDate, prices: [{ product_id: products[4].id, unit_price: "1" }, { product_id: products[5].id, unit_price: "4.5" }] }, buyer),
    (e) => (e as ApiError).status === 409 && (e as Error).message.includes(`سعر "${products[5].name}" من ${restoreDate} اتعمل بيه أوامر شراء`)
  );
  assert.deepEqual(await state(s.id), before);
});

test("statements are constant in the number of prices: 5 vs 50, new and corrected", async () => {
  const many: { id: string }[] = [];
  for (let i = 0; i < 50; i++) many.push(await prisma.stockProduct.create({ data: { name: `${TAG} كثير ${i}`, unit: "KG" } }));
  async function measure(n: number) {
    const s = await supplier();
    const prices = (price: string) => many.slice(0, n).map((p, i) => ({ product_id: p.id, ...(i % 3 === 0 ? { uom: "G" } : {}), unit_price: price }));
    const create = await countQueries(() => setSupplierPrices(s.id, { valid_from: day, prices: prices("2") }, buyer));
    assert.deepEqual(create.result, { created: n, replaced: 0 });
    const correct = await countQueries(() => setSupplierPrices(s.id, { valid_from: day, prices: prices("3") }, buyer));
    assert.deepEqual(correct.result, { created: 0, replaced: n });
    return { create: create.queries, correct: correct.queries };
  }
  const small = await measure(5), large = await measure(50);
  assert.deepEqual(large, small, `5 prices ${JSON.stringify(small)}, 50 prices ${JSON.stringify(large)}`);
  assert.ok(large.create <= 12 && large.correct <= 12, JSON.stringify(large));
});
