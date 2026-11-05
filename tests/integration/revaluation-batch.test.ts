/* Revaluing provisional-cost receipts on the supplier bill (Nov 2026): every provisional line read
   its receipt's units, products, lots and wrote its rows one at a time (~60 statements per line with
   stock on hand), so a weekly bill of ~8 walk-in receipts could not be approved inside the 20 s
   limit. The reads and the row, lot-cost and audit writes are now batched; each line's on-hand
   units still move by their own out/in postMovements pair, so the GL is unchanged — the same
   entries, lines and amounts (merging them per bill is an owner decision). Checked here against
   the previous code (tests/integration/_revaluation-before.ts) on the same bill, both in
   transactions that are rolled back. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor, withSetting } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { createIntake } from "@/lib/stock-service";
import { postMovements } from "@/lib/inventory/ledger";
import { createBill } from "@/lib/purchasing/bills";
import { revalueOnBill, revalueOnDebitNote } from "@/lib/purchasing/revaluation";
import * as previous from "./_revaluation-before";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const TAG = `ZZREV${Date.now()}`;
const today = todayLocalISO();
const store = actor("أمين مخزن", ["stock.receive", "stock.sort", "stock.view"], "rev-store");
const billing = actor("فواتير الموردين", ["purchasing.bills.manage", "purchasing.bills.view"], "rev-bills");
const accountant = actor("محاسب", ["accounting.manage"], "rev-acc", "ACCOUNTANT");
let restore: (() => Promise<void>) | undefined;
let supplierId = "";
let productIds: string[] = [];
let gradeB = "";
let issueDoc = "";

before(async () => {
  restore = await withSetting("accounting.lock_date", null);
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-9${String(Date.now()).slice(-6)}1`, name: `${TAG} مورد سوق`, category: "vegetable", paymentTermsDays: 0 } })).id;
  productIds = [];
  for (let i = 0; i < 3; i++) productIds.push((await prisma.stockProduct.create({ data: { name: `${TAG} صنف ${i}`, unit: "KG" } })).id);
  gradeB = (await prisma.stockProduct.create({ data: { name: `${TAG} فرزة`, unit: "KG" } })).id;
  const wh = await prisma.warehouse.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  issueDoc = (await prisma.inventoryDocument.create({ data: { number: `${TAG}-ISS`, type: "issue", status: "posted", postedAt: new Date(), warehouseId: wh.id, businessDate: today, createdBy: "test" } })).id;
});
after(async () => { await restore?.(); await prisma.$disconnect(); });

class Rollback extends Error {}
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T;
  await assert.rejects(inTx(async (tx) => { out = await fn(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; throw new Rollback(); }), (e) => { if (e instanceof Rollback) return true; throw e; });
  return out!;
}

/** A provisional receipt; part of it then sold, written off, or all of it gone. */
async function receipt(n: number, kind: "on_hand" | "partly_gone" | "gone" | "graded") {
  const productId = productIds[n % productIds.length];
  const intake = await createIntake({
    supplier_id: supplierId, product_id: productId, received_qty: 100, provisional_unit_cost: String(10 + (n % 4)),
    ...(kind === "graded" ? { grade_b_qty: 30, grade_b_product_id: gradeB } : {}),
  } as never, store);
  if (kind === "partly_gone" || kind === "gone") {
    const moves = await prisma.stockMovement.findMany({ where: { intakeId: intake.id, lotId: { not: null }, quantity: { gt: 0 } } });
    await inTx(async (tx) => {
      for (const m of moves) {
        const q = kind === "gone" ? D(m.quantity) : D(m.quantity).times(n % 2 ? "0.4" : "0.25").toDecimalPlaces(3);
        await postMovements(tx, [{ productId: m.productId, warehouseId: m.warehouseId, locationId: m.locationId, lotId: m.lotId, quantity: q.times(0.5).toDecimalPlaces(3).negated(), kind: "issue", documentId: issueDoc, reason: TAG }], { actorId: null, actorName: "test", effectiveDate: today });
        await postMovements(tx, [{ productId: m.productId, warehouseId: m.warehouseId, locationId: m.locationId, lotId: m.lotId, quantity: q.minus(q.times(0.5).toDecimalPlaces(3)).negated(), kind: "adjustment", reason: TAG }], { actorId: null, actorName: "test", effectiveDate: today });
      }
    });
  }
  return intake.id;
}

async function bill(kinds: Parameters<typeof receipt>[1][], invoice: string) {
  const ids: string[] = [];
  for (const [i, k] of kinds.entries()) ids.push(await receipt(i, k));
  const b = await createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-${invoice}`, bill_date: today, lines: ids.map((id, i) => ({ intake_id: id, unit_price: String(9 + (i % 5) * 0.75) })) }, billing);
  return b.id;
}

/** Everything a revaluation wrote, keyed so two runs can be compared (ids and times differ). */
async function written(tx: Tx, where: Prisma.StockRevaluationWhereInput, auditsBefore: Set<string>) {
  const revs = await tx.stockRevaluation.findMany({ where, include: { billLine: { select: { lineNo: true } } } });
  const key = new Map(revs.map((r) => [r.id, `${r.billLine.lineNo}|${r.productId}`]));
  const movements = await tx.stockMovement.findMany({ where: { revaluationId: { in: [...key.keys()] } }, include: { valuation: true } });
  const postings = await tx.stockValuationPosting.findMany({ where: { movementId: { in: movements.map((m) => m.id) } } });
  const entries = await tx.journalEntry.findMany({ where: { id: { in: [...new Set(postings.map((p) => p.entryId).filter((x): x is string => !!x))] } }, include: { lines: true }, orderBy: { number: "asc" } });
  const lotIds = [...new Set(movements.map((m) => m.lotId).concat(revs.length ? (await tx.stockMovement.findMany({ where: { intakeId: { in: revs.map((r) => r.intakeId) }, lotId: { not: null } }, select: { lotId: true } })).map((m) => m.lotId) : []).filter((x): x is string => !!x))];
  const lots = await tx.stockLot.findMany({ where: { id: { in: lotIds } }, orderBy: { lotNumber: "asc" } });
  const audits = (await tx.auditLog.findMany({ where: { entityType: { in: ["stock_revaluation", "stock_lot"] }, OR: [{ entityId: { in: [...key.keys()] } }, { entityId: { in: lotIds } }] } })).filter((a) => !auditsBefore.has(a.id));
  const s = (v: unknown) => (v instanceof Prisma.Decimal ? v.toString() : v);
  const strip = (o: Record<string, unknown>, drop: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, s(v)]));
  return {
    revaluations: revs.map((r) => ({ key: key.get(r.id), ...strip(r as never, ["id", "createdAt", "billLine", "debitNoteId"]) })).sort((a, b) => a.key!.localeCompare(b.key!)),
    movements: movements.map((m) => ({ sort: `${key.get(m.revaluationId!)}|${m.kind}|${m.locationId}|${m.lotId}`, rev: key.get(m.revaluationId!), ...strip(m as never, ["id", "seq", "createdAt", "occurredAt", "revaluationId", "valuation"]), layer: strip(m.valuation as never, ["id", "movementId", "createdAt"]) }))
      .sort((a, b) => a.sort.localeCompare(b.sort)),
    entries: entries.map((e) => ({ ...strip(e as never, ["id", "createdAt", "lines", "sourceId"]), lines: e.lines.map((l) => strip(l as never, ["id", "entryId"])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })),
    lots: lots.map((l) => [l.lotNumber, l.unitCost?.toString() ?? null]),
    audits: audits.map((a) => [a.action, a.entityType === "stock_lot" ? a.entityId : key.get(a.entityId), a.fieldChanged, a.oldValue, a.newValue, a.reason, a.userName]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}
const totalsOf = (t: Awaited<ReturnType<typeof revalueOnBill>>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)]));
const auditIds = async () => new Set((await prisma.auditLog.findMany({ where: { entityType: { in: ["stock_revaluation", "stock_lot"] } }, select: { id: true } })).map((a) => a.id));

test("a bill revalues its provisional receipts exactly as before: rows, movements, GL entries, lot costs, audit rows", async () => {
  const id = await bill(["on_hand", "partly_gone", "gone", "graded", "partly_gone", "on_hand", "graded"], "same");
  const seen = await auditIds();
  const old = await rolledBack(async (tx) => ({ totals: totalsOf(await previous.revalueOnBill(tx, id, accountant)), rows: await written(tx, { billId: id }, seen) }));
  const now = await rolledBack(async (tx) => ({ totals: totalsOf(await revalueOnBill(tx, id, accountant)), rows: await written(tx, { billId: id }, seen) }));
  assert.ok(old.rows.revaluations.length >= 9 && old.rows.entries.length >= 8 && old.rows.audits.length > 9, "the scenario exercises every part");
  assert.deepEqual(now, old);
});

test("a debit note without goods takes the cost back exactly as before", async () => {
  const id = await bill(["on_hand", "partly_gone", "graded", "gone"], "dn");
  // Post the bill's revaluation for real (the debit note reverses its rows).
  await inTx((tx) => revalueOnBill(tx, id, accountant));
  const b = await prisma.supplierBill.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const note = async (tx: Tx) => {
    const lines = b.lines.map((l) => { const net = D(l.net).times("0.4").toDecimalPlaces(2); return { billLineId: l.id, quantity: D(l.quantity).times("0.4").toDecimalPlaces(3), gross: net, discount: D(0), net, tax: D(0), total: net }; });
    const sum = lines.reduce((s, l) => s.plus(l.net), D(0));
    return tx.debitNote.create({ data: { number: await nextDocumentNumber(tx, "purchasing.debit_note", today), billId: id, supplierId, issueDate: today, reason: "تخفيض", currencyCode: "EGP", gross: sum, discountTotal: 0, net: sum, taxTotal: 0, total: sum, createdBy: "test", lines: { createMany: { data: lines } } } });
  };
  const seen = await auditIds();
  const old = await rolledBack(async (tx) => { const dn = await note(tx); return { totals: totalsOf(await previous.revalueOnDebitNote(tx, dn.id, accountant)), rows: await written(tx, { debitNoteId: dn.id }, seen) }; });
  const now = await rolledBack(async (tx) => { const dn = await note(tx); return { totals: totalsOf(await revalueOnDebitNote(tx, dn.id, accountant)), rows: await written(tx, { debitNoteId: dn.id }, seen) }; });
  assert.ok(old.rows.revaluations.length >= 5 && old.rows.audits.length > 5);
  assert.deepEqual(now, old);
});

test("the same refusal at the same point: a receipt with nothing in the stock ledger", async () => {
  const id = await bill(["on_hand", "on_hand"], "refused");
  const lines = await prisma.supplierBillLine.findMany({ where: { billId: id }, orderBy: { lineNo: "asc" }, include: { intake: true } });
  const outcome = (fn: typeof revalueOnBill) => rolledBack(async (tx) => {
    // The second receipt's movements lose their lot (as for a receipt from before lots were kept).
    await tx.$executeRaw`ALTER TABLE "StockMovement" DISABLE TRIGGER USER`;
    await tx.stockMovement.updateMany({ where: { intakeId: lines[1].intakeId }, data: { lotId: null } });
    await tx.$executeRaw`ALTER TABLE "StockMovement" ENABLE TRIGGER USER`;
    try { await fn(tx, id, accountant); return "ok"; } catch (e) { return `${(e as { status?: number }).status} ${(e as Error).message}`; }
  });
  const old = await outcome(previous.revalueOnBill), now = await outcome(revalueOnBill);
  assert.match(old, /^409 الاستلام .*مش لاقي كمياته/);
  assert.equal(now, old);
});

test("statements per bill: the reads and writes around each line's postMovements no longer grow with the lines", async () => {
  async function measure(kinds: Parameters<typeof receipt>[1][], label: string) {
    const id = await bill(kinds, label);
    const old = await rolledBack(async (tx) => (await countQueries(() => previous.revalueOnBill(tx, id, accountant))).queries);
    const now = await rolledBack(async (tx) => (await countQueries(() => revalueOnBill(tx, id, accountant))).queries);
    return { old, now };
  }
  // Everything already gone: no stock to move, so nothing per line is left.
  const gone4 = await measure(Array(4).fill("gone"), "gone4"), gone12 = await measure(Array(12).fill("gone"), "gone12");
  assert.equal(gone12.now, gone4.now, `fully sold: ${JSON.stringify({ gone4, gone12 })}`);
  // Stock on hand: only the two postMovements calls per line remain (one stock-valuation entry each).
  const hand4 = await measure(Array(4).fill("on_hand"), "hand4"), hand12 = await measure(Array(12).fill("on_hand"), "hand12");
  const perLine = (a: { old: number; now: number }, b: { old: number; now: number }, k: "old" | "now") => (b[k] - a[k]) / 8;
  const report = { gone: { old: perLine(gone4, gone12, "old"), now: perLine(gone4, gone12, "now") }, onHand: { old: perLine(hand4, hand12, "old"), now: perLine(hand4, hand12, "now") }, hand12 };
  assert.ok(report.onHand.now <= report.onHand.old - 9, JSON.stringify(report));
  console.log(`revalueOnBill statements: ${JSON.stringify(report)}`);
});
