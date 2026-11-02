/* The inventory engine, through its services, against PostgreSQL: valuation
   arithmetic, FEFO picking, concurrency (no deadlock, no overdraw), reservations,
   idempotency, reversal, and the database guards behind all of it. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor, withSetting } from "./_db";
import { createIntake } from "@/lib/stock-service";
import { createTransfer, createAdjustment, createScrap, createSupplierReturn, reverseDocument } from "@/lib/inventory/documents";
import { reserve, releaseReservation } from "@/lib/inventory/reservations";
import { productAvailability } from "@/lib/inventory/balances";
import { updateInventorySettings, savePackaging } from "@/lib/inventory/products";

const TAG = `ZZINV-${Date.now()}`;
const ALL = [
  "stock.view", "stock.receive", "stock.sort", "stock.adjust", "stock.manage_products",
  "stock.transfer", "stock.reserve", "stock.approve_adjustments", "stock.valuation.view",
];
const boss = actor("مدير مخزن", ALL);
let supplierId = "";
let today = "";

async function product(name: string, extra: Record<string, unknown> = {}) {
  return prisma.stockProduct.create({ data: { name: `${TAG} ${name}`, unit: "KG", ...extra } });
}
const value = async (productId: string) => {
  const a = await prisma.stockValuationLayer.aggregate({ where: { productId }, _sum: { quantity: true, value: true } });
  return { qty: a._sum.quantity?.toString() ?? "0", value: a._sum.value?.toString() ?? "0" };
};
const avail = (productId: string) => productAvailability(prisma, productId, "wh_main");
const receive = (productId: string, kg: number | string, extra: Record<string, unknown> = {}) =>
  // Every receipt carries a cost (ACC-E1): a test that does not name one receives at 10.
  createIntake({ supplier_id: supplierId, product_id: productId, received_kg: kg, received_date: today, ...(extra.unit_cost === undefined && extra.provisional_unit_cost === undefined ? { unit_cost: "10" } : {}), ...extra } as never, boss);

// These scenarios test valuation mechanics through direct adjustments; the approval step
// (on by default since November 2026, CTL-01) is tested in tests/stock.test.ts and
// tests/sales-stock-integrity.test.ts, so it is switched off for this file only.
let restoreApproval: () => Promise<void> = async () => {};
before(async () => {
  restoreApproval = await withSetting("inventory.adjustment_approval_required", false);
  const d = new Date();
  today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-9${String(Date.now()).slice(-7)}`, name: `${TAG} مورد` } })).id;
});
after(async () => {
  await restoreApproval();
  await prisma.$disconnect();
});

test("receipt: lot + bucket + valuation at the purchase price", async () => {
  const p = await product("Mango", { shelfLifeDays: 5 });
  const r = await receive(p.id, 100, { rejected_kg: 10, unit_cost: "12.50" });
  assert.equal(r.goodKg, 90);
  assert.ok(r.lot?.lotNumber.startsWith("LOT-"), "a lot was created");
  const lot = await prisma.stockLot.findUniqueOrThrow({ where: { id: r.lotId! } });
  assert.ok(lot.expiryDate && lot.expiryDate > today, "expiry = received + shelf life");
  assert.deepEqual(await value(p.id), { qty: "90", value: "1125" }, "90 kg × 12.50");
});

test("AVCO: issues leave at the running average; emptying leaves no value crumbs", async () => {
  const p = await product("Avco");
  await receive(p.id, 10, { unit_cost: 10 });
  await receive(p.id, 20, { unit_cost: 13 }); // avg = (100 + 260) / 30 = 12
  await createAdjustment({ reason: "صرف", lines: [{ product_id: p.id, quantity: -15 }] }, boss);
  assert.deepEqual(await value(p.id), { qty: "15", value: "180" }, "15 left at 12");
  await createAdjustment({ reason: "تصفية", lines: [{ product_id: p.id, quantity: -15 }] }, boss);
  assert.deepEqual(await value(p.id), { qty: "0", value: "0" }, "nothing on hand, nothing valued");
});

test("FIFO: the oldest cost leaves first", async () => {
  const p = await product("Fifo", { costingMethod: "fifo", removalStrategy: "fifo" });
  await receive(p.id, 10, { unit_cost: 5 });
  await receive(p.id, 10, { unit_cost: 8 });
  await createAdjustment({ reason: "صرف", lines: [{ product_id: p.id, quantity: -15 }] }, boss); // 10×5 + 5×8 = 90
  assert.deepEqual(await value(p.id), { qty: "5", value: "40" }, "remaining 5 at the newer cost");
});

test("standard cost values everything at the standard", async () => {
  const p = await product("Std", { costingMethod: "standard", standardCost: 7 });
  // Received at 9 while the standard is 7: only standard costing carries the 6 kg left at
  // 6 × 7 = 42. Average or actual receipt costing would give 6 × 9 = 54; mixing actual in
  // with standard out gives 90 − 28 = 62. (DEFECT-SC-01: today the result is 62.)
  await receive(p.id, 10, { unit_cost: "9" });
  await createAdjustment({ reason: "صرف", lines: [{ product_id: p.id, quantity: -4 }] }, boss);
  assert.deepEqual(await value(p.id), { qty: "6", value: "42" }, "standard costing: stock carried at the standard 7, not the receipt price 9 (54) nor a mix (62)");
});

test("FEFO: the lot that expires first goes first, whatever order it arrived in", async () => {
  const p = await product("Fefo");
  const late = await receive(p.id, 10, { expiry_date: "2099-01-20" });
  const soon = await receive(p.id, 10, { expiry_date: "2099-01-05" });
  const { document } = await createAdjustment({ reason: "صرف", lines: [{ product_id: p.id, quantity: -12 }] }, boss);
  const byLot = Object.fromEntries(document.movements.map((m) => [m.lotId, m.quantity.toString()]));
  assert.equal(byLot[soon.lotId!], "-10", "soon-to-expire lot emptied first");
  assert.equal(byLot[late.lotId!], "-2", "then the later one");
});

test("transfer moves stock without changing its value; reversal restores it exactly", async () => {
  const p = await product("Move");
  await receive(p.id, 50, { unit_cost: 4 });
  const before = await value(p.id);
  const t = await createTransfer({ lines: [{ product_id: p.id, quantity: 30, location_id: "loc_recv", to_location_id: "loc_cold_1" }] }, boss);
  assert.equal(t.document.movements.length, 2);
  assert.deepEqual(await value(p.id), before, "value unchanged by moving it");
  const a = await avail(p.id);
  const cold = a.buckets.find((b) => b.locationId === "loc_cold_1");
  assert.equal(cold?.quantity.toString(), "30");
  const rev = await reverseDocument(t.document.id, { reason: "اتحول غلط" }, boss);
  assert.equal(rev.reversalOfId, t.document.id);
  const after2 = await avail(p.id);
  assert.equal(after2.buckets.find((b) => b.locationId === "loc_cold_1")?.quantity.toString() ?? "0", "0");
  assert.deepEqual(await value(p.id), before);
  await assert.rejects(reverseDocument(t.document.id, { reason: "تاني" }, boss), /مش متسجل/, "a document reverses once");
});

test("opposing concurrent transfers do not deadlock and never overdraw", async () => {
  const p = await product("Race");
  await receive(p.id, 40);
  await createTransfer({ lines: [{ product_id: p.id, quantity: 20, location_id: "loc_recv", to_location_id: "loc_cold_1" }] }, boss);
  const there = (from: string, to: string) =>
    createTransfer({ lines: [{ product_id: p.id, quantity: 3, location_id: from, to_location_id: to }] }, boss).then(() => "ok", (e) => e.message);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? there("loc_recv", "loc_cold_1") : there("loc_cold_1", "loc_recv"))));
  assert.ok(results.every((r) => r === "ok"), `no deadlock / failure: ${results.filter((r) => r !== "ok").join(" | ")}`);
  const a = await avail(p.id);
  assert.equal(a.onHand.toString(), "40", "transfers never create or destroy stock");
});

test("concurrent removals cannot overdraw a bucket", async () => {
  const p = await product("Overdraw");
  await receive(p.id, 10);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => createScrap({ reason: "تالف", lines: [{ product_id: p.id, quantity: 3 }] }, boss).then(() => "ok", () => "refused"))
  );
  assert.equal(results.filter((r) => r === "ok").length, 3, "only 3 × 3 kg fit in 10 kg");
  assert.equal((await avail(p.id)).onHand.toString(), "1");
});

test("several lines of one product in one document never pick the same kilos twice", async () => {
  const p = await product("MultiLine");
  await receive(p.id, 6, { location_id: "loc_cold_1" });
  await receive(p.id, 6, { location_id: "loc_cold_1" });
  // Scrap: 4 + 4 + 4 across two lots — the third line must find the second lot.
  const scrap = await createScrap({ reason: "تالف", lines: [1, 2, 3].map(() => ({ product_id: p.id, quantity: 4 })) }, boss);
  assert.equal(scrap.document.movements.reduce((s: number, m: { quantity: unknown }) => s + Number(m.quantity), 0), -12);
  assert.equal((await avail(p.id)).onHand.toString(), "0");
  // …and a fourth line that does not fit fails the whole document, posting nothing.
  await receive(p.id, 5, { location_id: "loc_cold_1" });
  await assert.rejects(createScrap({ reason: "x", lines: [{ product_id: p.id, quantity: 3 }, { product_id: p.id, quantity: 3 }] }, boss), /الكمية المتاحة/);
  assert.equal((await avail(p.id)).onHand.toString(), "5");
  // Transfer: two auto-picked lines out of one room.
  await createTransfer({ lines: [{ product_id: p.id, quantity: 3, location_id: "loc_cold_1", to_location_id: "loc_cold_2" }, { product_id: p.id, quantity: 2, location_id: "loc_cold_1", to_location_id: "loc_cold_2" }] }, boss);
  const b = (await avail(p.id)).buckets.filter((x) => x.quantity.gt(0));
  assert.deepEqual(b.map((x) => [x.locationCode, x.quantity.toString()]), [["COLD-2", "5"]]);
  // Supplier return: a named-lot line and an auto-picked line competing for the same lot.
  const lot = b[0].lotId!;
  await assert.rejects(
    createSupplierReturn({ supplier_id: supplierId, reason: "جودة", lines: [{ product_id: p.id, quantity: 4, lot_id: lot, location_id: "loc_cold_2" }, { product_id: p.id, quantity: 2 }] }, boss),
    /الكمية المتاحة/
  );
  await createSupplierReturn({ supplier_id: supplierId, reason: "جودة", lines: [{ product_id: p.id, quantity: 3, lot_id: lot, location_id: "loc_cold_2" }, { product_id: p.id, quantity: 2 }] }, boss);
  assert.equal((await avail(p.id)).onHand.toString(), "0");
});

test("reservations reduce available, block removals that would break them, and release", async () => {
  const p = await product("Reserve");
  await receive(p.id, 20);
  const { reservation } = await reserve({ product_id: p.id, quantity: 15, source_type: "manual", source_id: `${TAG}-r1` }, boss);
  let a = await avail(p.id);
  assert.equal(a.onHand.toString(), "20");
  assert.equal(a.available.toString(), "5");
  await assert.rejects(reserve({ product_id: p.id, quantity: 6, source_type: "manual", source_id: `${TAG}-r2` }, boss), /المتاح/);
  await assert.rejects(createScrap({ reason: "تالف", lines: [{ product_id: p.id, quantity: 6 }] }, boss), /محجوز/, "scrap may not eat reserved stock");
  await createScrap({ reason: "تالف", lines: [{ product_id: p.id, quantity: 5 }] }, boss);
  await releaseReservation(reservation.id, "العميل لغى", boss);
  a = await avail(p.id);
  assert.equal(a.available.toString(), "15");
});

test("a reservation and a scrap racing for the last kilos: one wins", async () => {
  const p = await product("ResRace");
  await receive(p.id, 10);
  const [r, s] = await Promise.all([
    reserve({ product_id: p.id, quantity: 8, source_type: "manual", source_id: `${TAG}-rr` }, boss).then(() => "ok", () => "refused"),
    createScrap({ reason: "تالف", lines: [{ product_id: p.id, quantity: 8 }] }, boss).then(() => "ok", () => "refused"),
  ]);
  assert.equal([r, s].filter((x) => x === "ok").length, 1, `exactly one fits: reserve=${r} scrap=${s}`);
  assert.ok(!(await avail(p.id)).available.lt(0), "available never negative");
});

test("idempotency: the same key posts once", async () => {
  const p = await product("Idem");
  await receive(p.id, 10);
  const key = `${TAG}-scrap-1`;
  const [a, b] = await Promise.all([
    createScrap({ reason: "تالف", idempotency_key: key, lines: [{ product_id: p.id, quantity: 2 }] }, boss),
    createScrap({ reason: "تالف", idempotency_key: key, lines: [{ product_id: p.id, quantity: 2 }] }, boss),
  ]);
  assert.equal(a.document.id, b.document.id);
  assert.equal((await avail(p.id)).onHand.toString(), "8", "posted once");
});

test("approval threshold: a large adjustment waits, then posts at approval time", async () => {
  const p = await product("Approve");
  await receive(p.id, 100);
  await prisma.systemSetting.upsert({
    where: { key: "inventory.adjustment_approval_threshold" },
    update: { value: 20 },
    create: { key: "inventory.adjustment_approval_threshold", value: 20, updatedBy: "test" },
  });
  // The settings cache is per process; give it a fresh read.
  const { invalidateSettingsCache } = await import("@/lib/core/settings-service");
  invalidateSettingsCache();
  // This test is about the approval itself: on for its duration (the file turns it off).
  const restoreOn = await withSetting("inventory.adjustment_approval_required", true);
  try {
    const counter = actor("عامل جرد", ["stock.adjust", "stock.view"], null, "STOCK_CONTROLLER");
    const { document } = await createAdjustment({ reason: "جرد", lines: [{ product_id: p.id, quantity: -30 }] }, counter);
    assert.equal(document.status, "pending_approval");
    assert.equal(document.movements.length, 0, "nothing moved yet");
    assert.equal((await avail(p.id)).onHand.toString(), "100");
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { entityId: document.id, status: "pending" } });
    const { decideApproval } = await import("@/lib/core/approval-handlers");
    await decideApproval(req.id, "approve", { id: null, name: "مشرف", role: "SUPERVISOR", permissions: ["stock.approve_adjustments"] }, {});
    assert.equal((await avail(p.id)).onHand.toString(), "70", "posted on approval");
    const posted = await prisma.inventoryDocument.findUniqueOrThrow({ where: { id: document.id } });
    assert.equal(posted.status, "posted");

    const split = await createAdjustment({ reason: "تسوية مجزأة", lines: [
      { product_id: p.id, quantity: -11 },
      { product_id: p.id, quantity: -11 },
    ] }, boss);
    assert.equal(split.document.status, "pending_approval", "split lines still exceed the per-product threshold");
    const splitRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { entityId: split.document.id, status: "pending" } });
    await decideApproval(splitRequest.id, "approve", { id: null, name: "مشرف", role: "SUPERVISOR", permissions: ["stock.approve_adjustments"] }, {});
    assert.equal((await avail(p.id)).onHand.toString(), "48");

    const lotId = (await prisma.stockLot.findFirstOrThrow({ where: { productId: p.id } })).id;
    const count = await createAdjustment({ reason: "جرد ينتظر الموافقة", lines: [
      { product_id: p.id, location_id: "loc_recv", lot_id: lotId, counted_quantity: 0 },
    ] }, boss);
    const { document: intervening } = await createAdjustment({ reason: "حركة بعد الجرد", lines: [
      { product_id: p.id, location_id: "loc_recv", lot_id: lotId, quantity: 5 },
    ] }, boss);
    assert.equal(intervening.status, "posted");
    const countRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { entityId: count.document.id, status: "pending" } });
    await assert.rejects(decideApproval(countRequest.id, "approve", { id: null, name: "مشرف", role: "SUPERVISOR", permissions: ["stock.approve_adjustments"] }, {}), /رصيد الدفعة اتغير/);
    await decideApproval(countRequest.id, "reject", { id: null, name: "مشرف", role: "SUPERVISOR", permissions: ["stock.approve_adjustments"] }, { comment: "الرصيد اتغير؛ مطلوب جرد جديد" });
  } finally {
    await restoreOn();
    await prisma.systemSetting.delete({ where: { key: "inventory.adjustment_approval_threshold" } });
    invalidateSettingsCache();
  }
});

test("a count posts only the difference, in that bucket", async () => {
  const p = await product("Count");
  await receive(p.id, 25);
  const { document } = await createAdjustment({ reason: "جرد آخر اليوم", lines: [{ product_id: p.id, location_id: "loc_recv", lot_id: (await prisma.stockLot.findFirstOrThrow({ where: { productId: p.id } })).id, counted_quantity: 23.5 }] }, boss);
  assert.equal(document.movements[0].quantity.toString(), "-1.5");
  await assert.rejects(createAdjustment({ reason: "جرد", lines: [{ product_id: p.id, location_id: "loc_recv", lot_id: document.movements[0].lotId, counted_quantity: 23.5 }] }, boss), /مطابق/);
});

test("a count refuses duplicate rows for the same product bucket", async () => {
  const p = await product("Duplicate count");
  await receive(p.id, 25);
  const lotId = (await prisma.stockLot.findFirstOrThrow({ where: { productId: p.id } })).id;
  await assert.rejects(createAdjustment({ reason: "جرد مكرر", lines: [
    { product_id: p.id, location_id: "loc_recv", lot_id: lotId, counted_quantity: 23 },
    { product_id: p.id, location_id: "loc_recv", lot_id: lotId, counted_quantity: 23 },
  ] }, boss), /تكرر نفس الصنف/);
  assert.equal((await avail(p.id)).onHand.toString(), "25", "rejected count cannot change stock");
});

test("packaging converts per product, exactly or not at all", async () => {
  const p = await product("Crates");
  await savePackaging(p.id, { uom: "CRATE", qty_in_base_unit: "18.5" }, boss);
  const r = await receive(p.id, undefined as never, { entered_qty: 4, entered_uom: "CRATE" });
  assert.equal(r.goodKg, 74, "4 crates × 18.5 kg");
  await assert.rejects(receive(p.id, undefined as never, { entered_qty: 2, entered_uom: "PALLET" }), /مفيش تعبئة/);
  const eggs = await prisma.stockProduct.create({ data: { name: `${TAG} Eggs`, unit: "PIECE" } });
  await savePackaging(eggs.id, { uom: "CARTON", qty_in_base_unit: 30 }, boss);
  assert.equal((await receive(eggs.id, undefined as never, { entered_qty: "2.5", entered_uom: "CARTON" })).goodKg, 75, "2.5 cartons = 75 eggs");
  await assert.rejects(receive(eggs.id, undefined as never, { entered_qty: "0.01", entered_uom: "CARTON" }), /مش رقم صحيح/, "0.3 of an egg is refused, not rounded");
});

test("costing method cannot change while stock is held", async () => {
  const p = await product("Method");
  await receive(p.id, 5, { unit_cost: 3 });
  // Costing is finance's decision (accounting.manage); the warehouse manager is refused outright.
  await assert.rejects(updateInventorySettings(p.id, { costing_method: "fifo" }, boss), (e: any) => e.status === 403);
  const finance = actor("محاسب", ["accounting.manage"]);
  await assert.rejects(updateInventorySettings(p.id, { costing_method: "fifo" }, finance), /الرصيد يكون صفر/);
});

test("cold-chain products refuse a dry location", async () => {
  const p = await product("Cold", { coldChain: true });
  const dry = await prisma.storageLocation.create({ data: { warehouseId: "wh_main", code: `${TAG.slice(-6)}-DRY`, name: "Dry", type: "dry" } });
  await assert.rejects(receive(p.id, 5, { location_id: dry.id }), /محتاج تبريد/);
});

test("database guards: bucket floor and append-only ledger hold for raw SQL too", async () => {
  const p = await product("Guard");
  const r = await receive(p.id, 5);
  await assert.rejects(
    prisma.$executeRaw`INSERT INTO "StockMovement" (id, "productId", "effectiveDate", kind, quantity, "warehouseId", "locationId", "lotId", reason, "actorName")
      VALUES (${`${TAG}-raw`}, ${p.id}, ${today}, 'adjustment', -6, 'wh_main', 'loc_recv', ${r.lotId}, 'raw', 'sql')`,
    /negative/
  );
  await assert.rejects(prisma.$executeRaw`DELETE FROM "StockMovement" WHERE "productId" = ${p.id}`, /append-only/);
});
