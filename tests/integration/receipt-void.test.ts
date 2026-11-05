/* ACC-18: voiding a receipt undoes it movement by movement — each at its own layer value,
   through its own counter account — so a graded receipt (good stock, Grade B on another
   product, waste) and its corrections leave nothing behind in the stock ledger, the valuation
   layers or the GL, and the NRV waste-loss entry is reversed with it. Whatever was built on
   the receipt (a release, stock taken from it, an average that moved) refuses the void. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, withSetting, inTx } from "./_db";
import { createIntake, updateIntake, voidIntake } from "@/lib/stock-service";
import { decideApproval } from "@/lib/core/approval-handlers";
import { createAdjustment, createTransfer, reverseDocument } from "@/lib/inventory/documents";
import { changeStandardCost } from "@/lib/inventory/standard-cost";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZVOID${Date.now()}`;
const boss = actor("أمين مخزن", ["stock.view", "stock.receive", "stock.sort", "stock.adjust", "stock.transfer", "stock.manage_products", "stock.approve_adjustments", "stock.valuation.view"]);
const today = todayLocalISO();
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
let supplierId = "";
const restores: (() => Promise<void>)[] = [];

before(async () => {
  restores.push(await withSetting("inventory.grading_loss_approval_required", false));
  restores.push(await withSetting("inventory.adjustment_approval_required", false));
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-6${String(Date.now()).slice(-7)}`, name: `${TAG} مورد` } })).id;
});
after(async () => {
  for (const r of restores.reverse()) await r();
  await prisma.$disconnect();
});

const product = (name: string, data: Partial<Prisma.StockProductCreateInput> = {}) => prisma.stockProduct.create({ data: { name: `${TAG} ${name}`, unit: "KG", ...data } });
const receive = (productId: string, extra: Record<string, unknown>) => createIntake({ supplier_id: supplierId, product_id: productId, received_date: today, ...extra } as never, boss);
const intakeOf = (id: string) => prisma.stockIntake.findUniqueOrThrow({ where: { id } });
const voidIt = async (id: string, why = "استلام غلط") => voidIntake(id, boss, why, (await intakeOf(id)).version);
const onHand = async (productId: string) => D((await prisma.stockMovement.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity ?? 0).toString();
const valuation = async (productId: string) => {
  const a = await prisma.stockValuationLayer.aggregate({ where: { productId }, _sum: { quantity: true, value: true } });
  return [D(a._sum.quantity ?? 0).toString(), D(a._sum.value ?? 0).toFixed(2)];
};
/** Net per account over every GL entry the receipt produced: its valuation entries (receipt,
 * corrections, void) and its waste-loss entry with that entry's reversal. */
async function receiptGl(intakeId: string) {
  const posted = await prisma.stockValuationPosting.findMany({ where: { movement: { intakeId } }, select: { entryId: true } });
  const ids = new Set(posted.map((p) => p.entryId).filter((x): x is string => !!x));
  const loss = await prisma.journalEntry.findFirst({ where: { sourceId: `intake-waste|${intakeId}` }, select: { id: true, reversedBy: { select: { id: true } } } });
  if (loss) ids.add(loss.id);
  if (loss?.reversedBy) ids.add(loss.reversedBy.id);
  const lines = await prisma.journalLine.findMany({ where: { entryId: { in: [...ids] } }, include: { account: { select: { systemKey: true } } } });
  const net = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    const k = l.account.systemKey ?? l.accountId;
    net.set(k, (net.get(k) ?? D(0)).plus(l.debit).minus(l.credit));
  }
  return Object.fromEntries([...net].filter(([, v]) => !v.isZero()).map(([k, v]) => [k, v.toFixed(2)]));
}
const status = (e: unknown) => (e as { status?: number }).status;

test("a graded receipt (good, Grade B on another product, waste) voids: stock, layers and GL back to nothing", async () => {
  const a = await product("A"), b = await product("B");
  const r = await receive(a.id, { received_kg: 100, grade_b_qty: 15, grade_b_product_id: b.id, waste_qty: 5, unit_cost: "6" });
  assert.deepEqual([await onHand(a.id), await onHand(b.id)], ["85", "15"], "80 good + 5 waste on A, 15 Grade B on B");
  assert.deepEqual(await receiptGl(r.id), { inventory: "600.00", grni: "-600.00" });
  await voidIt(r.id);
  assert.equal((await intakeOf(r.id)).status, "voided");
  assert.deepEqual([await onHand(a.id), await onHand(b.id)], ["0", "0"], "every bucket emptied, Grade B on its own product");
  assert.deepEqual([await valuation(a.id), await valuation(b.id)], [["0", "0.00"], ["0", "0.00"]]);
  assert.deepEqual(await receiptGl(r.id), {}, "inventory and GRNI back exactly");
  const voids = await prisma.stockMovement.findMany({ where: { intakeId: r.id, kind: "intake_void" }, include: { valuation: true } });
  assert.equal(voids.length, 3, "one reversal per movement of the receipt");
});

test("a receipt held for its grading loss voids out of quarantine and its approval is cancelled", async () => {
  const restoreHold = await withSetting("inventory.grading_loss_approval_required", true);
  try {
    const a = await product("Held"), b = await product("HeldB");
    const r = await receive(a.id, { received_kg: 50, grade_b_qty: 10, grade_b_product_id: b.id, waste_qty: 5, unit_cost: "4" });
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "inventory.grading_loss", entityId: r.id, status: "pending" } });
    const held = await prisma.stockMovement.count({ where: { intakeId: r.id, location: { type: "quarantine" } } });
    assert.ok(held > 0, "the good stock waits in quarantine");
    await voidIt(r.id);
    assert.equal((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).status, "cancelled");
    assert.deepEqual([await onHand(a.id), await onHand(b.id)], ["0", "0"]);
    assert.deepEqual(await receiptGl(r.id), {});
  } finally {
    await restoreHold();
  }
});

test("a released hold refuses the void, naming the release; once the release is reversed the void goes through", async () => {
  const restoreHold = await withSetting("inventory.grading_loss_approval_required", true);
  try {
    const a = await product("Released");
    const r = await receive(a.id, { received_kg: 40, waste_qty: 4, unit_cost: "5" });
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "inventory.grading_loss", entityId: r.id, status: "pending" } });
    await decideApproval(req.id, "approve", { id: null, name: "مشرف", role: "SUPERVISOR", permissions: ["stock.approve_adjustments"] }, {});
    const release = await prisma.inventoryDocument.findFirstOrThrow({ where: { sourceType: "stock_intake", sourceId: r.id, status: "posted" } });
    const moves = await prisma.stockMovement.count();
    await assert.rejects(voidIt(r.id), (e: { status?: number; message?: string }) => e.status === 409 && e.message!.includes(release.number));
    assert.equal((await intakeOf(r.id)).status, "posted");
    assert.equal(await prisma.stockMovement.count(), moves, "nothing moved");
    await reverseDocument(release.id, { reason: "الإفراج اتعمل غلط" }, boss);
    await voidIt(r.id);
    assert.equal(await onHand(a.id), "0");
    assert.deepEqual(await receiptGl(r.id), {});
  } finally {
    await restoreHold();
  }
});

test("stock taken from the receipt refuses the void with a clear reason; nothing is half-done", async () => {
  const a = await product("Taken"), b = await product("TakenB");
  const r = await receive(a.id, { received_kg: 60, grade_b_qty: 10, grade_b_product_id: b.id, waste_qty: 2, unit_cost: "3" });
  await createAdjustment({ reason: "تالف", lines: [{ product_id: b.id, quantity: -3 }] }, boss);
  const before_ = { moves: await prisma.stockMovement.count({ where: { intakeId: r.id } }), gl: await receiptGl(r.id) };
  await assert.rejects(voidIt(r.id), (e: { status?: number; message?: string }) => e.status === 400 && e.message!.includes(b.name) && !e.message!.includes("الرصيد مش كفاية"));
  assert.equal((await intakeOf(r.id)).status, "posted");
  assert.equal(await prisma.stockMovement.count({ where: { intakeId: r.id } }), before_.moves);
  assert.deepEqual(await receiptGl(r.id), before_.gl);
  assert.deepEqual([await onHand(a.id), await onHand(b.id)], ["50", "7"], "48 good + 2 waste on A");
});

test("average cost: a void that would leave an impossible valuation is refused; with nothing issued since, it restores the pool exactly", async () => {
  // 10 kg at 1 on hand, 100 kg at 10 received (average 9.1818), then the 10 old kg issued at
  // that average: taking the receipt out at its own 1000.00 would leave 0 kg worth −81.82.
  const p = await product("Avco");
  const r1 = await receive(p.id, { received_kg: 10, unit_cost: "1" });
  const r2 = await receive(p.id, { received_kg: 100, unit_cost: "10" });
  await createAdjustment({ reason: "صرف قديم", lines: [{ product_id: p.id, location_id: "loc_recv", lot_id: (await intakeOf(r1.id)).lotId, quantity: -10 }] }, boss);
  const before_ = await valuation(p.id);
  await assert.rejects(voidIt(r2.id), (e: { status?: number; message?: string }) => e.status === 409 && /-81\.82/.test(e.message!));
  assert.equal((await intakeOf(r2.id)).status, "posted");
  assert.deepEqual(await valuation(p.id), before_);

  const q = await product("Avco2");
  await receive(q.id, { received_kg: 10, unit_cost: "1" });
  const s2 = await receive(q.id, { received_kg: 100, unit_cost: "10" });
  await voidIt(s2.id);
  assert.deepEqual(await valuation(q.id), ["10", "10.00"], "back to the 10 kg at 1");
});

test("each GL entry is reversed on its own: a receipt and a correction that each round up by half a piastre net to 0.00", async () => {
  // 2.001 kg × 5 = 10.005 → 10.01; the correction +0.001 kg × 5 = 0.005 → 0.01. One pooled
  // reversal of 10.010 would round to 10.01 and leave 0.01 in GRNI and inventory.
  const p = await product("Cent");
  const r = await receive(p.id, { received_kg: "2.001", unit_cost: "5" });
  await updateIntake(r.id, { received_kg: "2.002" } as never, boss, "وزن أعيد", (await intakeOf(r.id)).version);
  assert.deepEqual(await receiptGl(r.id), { inventory: "10.02", grni: "-10.02" });
  await voidIt(r.id);
  assert.deepEqual(await receiptGl(r.id), {});
  assert.deepEqual(await valuation(p.id), ["0", "0.00"]);
});

test("standard cost: a graded receipt voids with its price variance; after the standard changes it is refused", async () => {
  const p = await product("Std", { costingMethod: "standard", standardCost: "7" });
  // Grade B is its own product (Nov 2026), never a bucket of the first-grade one.
  const pb = await product("StdB", {});
  const r = await receive(p.id, { received_kg: 100, grade_b_qty: 10, grade_b_product_id: pb.id, waste_qty: 5, unit_cost: "9" });
  assert.equal(Object.keys(await receiptGl(r.id)).includes("ppv"), true, "the receipt carried a variance");
  await voidIt(r.id);
  assert.deepEqual(await receiptGl(r.id), {}, "inventory, GRNI and the variance all back");
  assert.deepEqual(await valuation(p.id), ["0", "0.00"]);

  const r2 = await receive(p.id, { received_kg: 10, unit_cost: "9" });
  const fresh = await prisma.stockProduct.findUniqueOrThrow({ where: { id: p.id } });
  await inTx((tx) => changeStandardCost(tx, fresh, D(8), "سعر جديد", boss as never));
  await assert.rejects(voidIt(r2.id), (e: { status?: number }) => e.status === 409);
  assert.equal((await intakeOf(r2.id)).status, "posted");
});

test("FIFO: once the receipt's own layer has costed another movement the void is refused (ACC-11 open)", async () => {
  // Out to a cold room and back: the stock is where it was, but the receipt's layer was
  // consumed by the transfer and a new layer carries the cost now.
  const p = await product("Fifo", { costingMethod: "fifo" });
  const r = await receive(p.id, { received_kg: 10, unit_cost: "2" });
  const lot = (await intakeOf(r.id)).lotId;
  await createTransfer({ reason: "تبريد", lines: [{ product_id: p.id, location_id: "loc_recv", to_location_id: "loc_cold_1", lot_id: lot, quantity: 10 }] }, boss);
  await createTransfer({ reason: "رجوع", lines: [{ product_id: p.id, location_id: "loc_cold_1", to_location_id: "loc_recv", lot_id: lot, quantity: 10 }] }, boss);
  await assert.rejects(voidIt(r.id), (e: { status?: number; message?: string }) => e.status === 409 && /FIFO/.test(e.message!));
  assert.equal((await intakeOf(r.id)).status, "posted");
});

test("two voids at once: one goes through, the other is refused; the receipt is reversed once", async () => {
  const a = await product("Race"), b = await product("RaceB");
  const r = await receive(a.id, { received_kg: 30, grade_b_qty: 5, grade_b_product_id: b.id, waste_qty: 1, unit_cost: "2" });
  const v = (await intakeOf(r.id)).version;
  const results = await Promise.allSettled([voidIntake(r.id, boss, "أ", v), voidIntake(r.id, boss, "ب", v)]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const refused = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
  assert.ok((status(refused.reason) ?? 0) >= 400 && (status(refused.reason) ?? 0) < 500, String(refused.reason));
  assert.equal(await prisma.stockMovement.count({ where: { intakeId: r.id, kind: "intake_void" } }), 3);
  assert.deepEqual(await receiptGl(r.id), {});
});
