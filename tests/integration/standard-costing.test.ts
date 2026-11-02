/* Standard costing (DEFECT-SC-01), proven on the journal: a standard-cost product is
   carried in stock at its standard; GRNI moves at the purchase price; the difference is a
   purchase price variance on the chart's PPV account; a new standard revalues the stock
   on hand; the method refuses to work without its variance accounts. Every assertion
   reads the posted journal lines and the valuation layers, not API return values. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, withSetting, inTx } from "./_db";
import { createIntake, voidIntake } from "@/lib/stock-service";
import { createAdjustment } from "@/lib/inventory/documents";
import { applyBillDecision, createBill, createDebitNote, postBill } from "@/lib/purchasing/bills";
import { updateInventorySettings } from "@/lib/inventory/products";
import { assertStandardCostAccounts } from "@/lib/inventory/standard-cost";
import { integrityReport } from "@/lib/accounting/integrity";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZSTD${Date.now()}`;
const boss = actor("مدير مخزن", ["stock.view", "stock.receive", "stock.sort", "stock.adjust", "stock.manage_products", "stock.approve_adjustments", "stock.valuation.view"]);
const acct = actor("محاسب", ["purchasing.bills.manage", "purchasing.bills.view", "accounting.manage", "stock.manage_products"]);
const today = todayLocalISO();
let supplierId = "";
let restore: () => Promise<void> = async () => {};

before(async () => {
  restore = await withSetting("inventory.adjustment_approval_required", false);
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${TAG} مورد`, paymentTermsDays: 7 } })).id;
});
after(async () => {
  await restore();
  await prisma.$disconnect();
});

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const standardProduct = (name: string, std: string) =>
  prisma.stockProduct.create({ data: { name: `${TAG} ${name}`, unit: "KG", costingMethod: "standard", standardCost: std } });
const receive = (productId: string, kg: number, cost: Record<string, string>) =>
  createIntake({ supplier_id: supplierId, product_id: productId, received_kg: kg, received_date: today, ...cost } as never, boss);

/** Signed (debit − credit) per system key, over the given journal entries. */
async function byKey(entryIds: (string | null | undefined)[]) {
  const ids = entryIds.filter((x): x is string => !!x);
  const lines = await prisma.journalLine.findMany({ where: { entryId: { in: ids } }, include: { account: { select: { systemKey: true } } } });
  const out: Record<string, string> = {};
  for (const l of lines) {
    const k = l.account.systemKey ?? l.accountId;
    out[k] = D(out[k] ?? 0).plus(l.debit).minus(l.credit).toFixed(2);
  }
  for (const k of Object.keys(out)) if (D(out[k]).isZero()) delete out[k];
  return out;
}
/** The stock-valuation journal entries of movements matching `where`. */
async function valuationEntries(where: Prisma.StockMovementWhereInput) {
  const posts = await prisma.stockValuationPosting.findMany({ where: { movement: where }, select: { entryId: true } });
  return [...new Set(posts.map((p) => p.entryId))];
}
const value = async (productId: string) => {
  const a = await prisma.stockValuationLayer.aggregate({ where: { productId }, _sum: { quantity: true, value: true, priceVariance: true } });
  return { qty: D(a._sum.quantity ?? 0).toString(), value: D(a._sum.value ?? 0).toFixed(2), variance: D(a._sum.priceVariance ?? 0).toFixed(2) };
};
// A bill whose price differs from the receipt waits for a second person (CTL-01); the
// approval engine itself is tested elsewhere — here the decision lands, by someone else.
const approver = actor("مدير مالي", ["purchasing.bills.approve"], "zz-std-approver");
async function postOrApprove(billId: string) {
  const b = await postBill(billId, acct);
  if (b.status !== "pending_approval") return b;
  await inTx((tx) => applyBillDecision(tx, billId, true, { id: approver.id, name: approver.name, role: "ACCOUNTANT" }, "فرق سعر مقبول"));
  return prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } });
}
const billEntry = (billId: string) => prisma.journalEntry.findFirst({ where: { sourceType: "supplier_bill", sourceId: billId }, select: { id: true } }).then((e) => e?.id);

test("precondition: the chart's PPV and inventory-adjustment system accounts exist and are postable", async () => {
  const rows = await prisma.account.findMany({ where: { systemKey: { in: ["ppv", "inventory_adjustment", "inventory", "grni"] }, active: true, postable: true }, select: { systemKey: true, code: true } });
  assert.deepEqual(rows.map((r) => r.systemKey).sort(), ["grni", "inventory", "inventory_adjustment", "ppv"]);
});

test("receipt at 9 with a standard of 7: Dr Inventory 70, Dr PPV 20, Cr GRNI 90; the layer carries 7 and a 20 variance", async () => {
  const p = await standardProduct("Receipt", "7");
  const r = await receive(p.id, 10, { unit_cost: "9" });
  const layer = await prisma.stockValuationLayer.findFirstOrThrow({ where: { movement: { intakeId: r.id } } });
  assert.equal(layer.costSource, "standard");
  assert.equal(D(layer.unitCost).toFixed(4), "7.0000");
  assert.equal(D(layer.value).toFixed(2), "70.00");
  assert.equal(D(layer.priceVariance).toFixed(2), "20.00");
  assert.deepEqual(await byKey(await valuationEntries({ intakeId: r.id })), { inventory: "70.00", ppv: "20.00", grni: "-90.00" });
});

test("the original DEFECT-SC-01 scenario on the journal: receive 10 @ 9, issue 4 → 6 kg carried at 42; the issue left at 28", async () => {
  const p = await standardProduct("Issue", "7");
  const r = await receive(p.id, 10, { unit_cost: "9" });
  await createAdjustment({ reason: "صرف", lines: [{ product_id: p.id, quantity: -4 }] }, boss);
  assert.deepEqual(await value(p.id), { qty: "6", value: "42.00", variance: "20.00" });
  assert.deepEqual(await byKey(await valuationEntries({ productId: p.id, kind: "adjustment" })), { inventory: "-28.00", inventory_adjustment: "28.00" });
  // Inventory account movement for this product = 70 − 28 = 42 = the valuation layers.
  const inv = await byKey([...(await valuationEntries({ intakeId: r.id })), ...(await valuationEntries({ productId: p.id, kind: "adjustment" }))]);
  assert.equal(inv.inventory, "42.00");
});

test("bill at the receipt price clears GRNI exactly; a bill above it adds only its own difference to PPV", async () => {
  const p = await standardProduct("Bill", "7");
  const r1 = await receive(p.id, 10, { unit_cost: "9" });
  const r2 = await receive(p.id, 10, { unit_cost: "9" });
  const b1 = await postOrApprove((await createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-B1`, bill_date: today, lines: [{ intake_id: r1.id, unit_price: "9" }] }, acct)).id);
  const b2 = await postOrApprove((await createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-B2`, bill_date: today, lines: [{ intake_id: r2.id, unit_price: "9.5" }] }, acct)).id);
  assert.equal(b1.status, "posted");
  assert.equal(b2.status, "posted");
  const e1 = await byKey([...(await valuationEntries({ intakeId: r1.id })), await billEntry(b1.id)]);
  assert.equal(e1.grni, undefined, "receipt + bill at the same price: GRNI nets to zero");
  assert.equal(e1.ppv, "20.00", "PPV = (9 − 7) × 10");
  assert.equal(e1.inventory, "70.00");
  const e2 = await byKey([...(await valuationEntries({ intakeId: r2.id })), await billEntry(b2.id)]);
  assert.equal(e2.grni, undefined, "GRNI nets to zero");
  assert.equal(e2.ppv, "25.00", "PPV = (9.5 − 7) × 10: 20 at receipt + 5 on the bill");
  assert.equal(e2.inventory, "70.00", "inventory stays at standard");
});

test("goods returned to the supplier leave at the standard; GRNI is reversed at the purchase price, the variance with it", async () => {
  const p = await standardProduct("Return", "7");
  const r = await receive(p.id, 10, { unit_cost: "9" });
  const bill = await postOrApprove((await createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-RT`, bill_date: today, lines: [{ intake_id: r.id, unit_price: "9" }] }, acct)).id);
  const lineId = (await prisma.supplierBillLine.findFirstOrThrow({ where: { billId: bill.id } })).id;
  const dn = await createDebitNote(bill.id, { reason: "مرتجع تالف", return_goods: true, lines: [{ bill_line_id: lineId, quantity: 2 }] }, acct);
  const note = await prisma.debitNote.findUniqueOrThrow({ where: { id: (dn as { id: string }).id } });
  assert.ok(note.returnDocumentId, "goods went back (a supplier return document)");
  const ret = await byKey(await valuationEntries({ documentId: note.returnDocumentId }));
  assert.deepEqual(ret, { inventory: "-14.00", ppv: "-4.00", grni: "18.00" }, "out at 2 × 7; GRNI back at 2 × 9; the 2 × 2 variance reversed");
  const dnEntry = (await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: "debit_note", sourceId: note.id } })).id;
  const all = await byKey([...(await valuationEntries({ intakeId: r.id })), await billEntry(bill.id), ...(await valuationEntries({ documentId: note.returnDocumentId })), dnEntry]);
  assert.equal(all.grni, undefined, "receipt, bill, return and debit note leave GRNI at zero");
  assert.equal(all.inventory, "56.00", "8 kg × 7 left in stock");
  assert.equal(all.ppv, "16.00", "variance on the 8 kg kept: 8 × 2");
  assert.equal(all.ap, "-72.00", "owed for 8 kg × 9");
});

test("voiding a receipt reverses inventory, GRNI and the variance exactly", async () => {
  const p = await standardProduct("Void", "7");
  const r = await receive(p.id, 5, { unit_cost: "9" });
  const intake = await prisma.stockIntake.findUniqueOrThrow({ where: { id: r.id } });
  await voidIntake(r.id, boss, "استلام غلط", intake.version);
  assert.deepEqual(await byKey(await valuationEntries({ intakeId: r.id })), {}, "every account nets to zero");
  assert.deepEqual(await value(p.id), { qty: "0", value: "0.00", variance: "0.00" });
});

test("a provisional receipt billed later: stock never moves from the standard; the whole difference is PPV", async () => {
  const p = await standardProduct("Provisional", "7");
  const r = await receive(p.id, 10, { provisional_unit_cost: "8" });
  assert.deepEqual(await byKey(await valuationEntries({ intakeId: r.id })), { inventory: "70.00", ppv: "10.00", grni: "-80.00" });
  const bill = await postOrApprove((await createBill({ supplier_id: supplierId, supplier_invoice_no: `${TAG}-PV`, bill_date: today, lines: [{ intake_id: r.id, unit_price: "9" }] }, acct)).id);
  const rv = await prisma.stockRevaluation.findFirstOrThrow({ where: { billId: bill.id } });
  assert.equal(D(rv.inventoryDelta).toFixed(2), "0.00", "no revaluation of standard stock");
  assert.equal(D(rv.ppvDelta).toFixed(2), "10.00", "the 10 × (9 − 8) difference is a price variance");
  assert.equal(await prisma.stockMovement.count({ where: { intakeId: r.id, kind: { in: ["revaluation_out", "revaluation_in"] } } }), 0);
  const all = await byKey([...(await valuationEntries({ intakeId: r.id })), await billEntry(bill.id)]);
  assert.deepEqual(all, { inventory: "70.00", ppv: "20.00", ap: "-90.00" }, "GRNI cleared; PPV = (9 − 7) × 10");
  assert.deepEqual(await value(p.id), { qty: "10", value: "70.00", variance: "10.00" });
});

test("a new standard revalues the stock on hand (Dr Inventory / Cr adjustments), is recorded, and later issues leave at it", async () => {
  const p = await standardProduct("Restandard", "7");
  await receive(p.id, 6, { unit_cost: "9" });
  await assert.rejects(updateInventorySettings(p.id, { standard_cost: "8" }, acct), (e: { status?: number; code?: string }) => e.status === 400 && e.code === "standard_cost_reason_required");
  assert.equal(D((await prisma.stockProduct.findUniqueOrThrow({ where: { id: p.id } })).standardCost!).toFixed(4), "7.0000", "refused: nothing changed");
  await updateInventorySettings(p.id, { standard_cost: "8", standard_cost_reason: "تحديث التكلفة المعيارية للموسم" }, acct);
  const change = await prisma.standardCostChange.findFirstOrThrow({ where: { productId: p.id } });
  assert.deepEqual([D(change.oldStandardCost!).toFixed(4), D(change.newStandardCost).toFixed(4), D(change.onHandQty).toString(), D(change.revaluation).toFixed(2)], ["7.0000", "8.0000", "6", "6.00"]);
  assert.deepEqual(await byKey(await valuationEntries({ standardCostChangeId: change.id })), { inventory: "6.00", inventory_adjustment: "-6.00" });
  assert.deepEqual(await value(p.id), { qty: "6", value: "48.00", variance: "12.00" }, "6 kg now carried at 8");
  await createAdjustment({ reason: "صرف", lines: [{ product_id: p.id, quantity: -1 }] }, boss);
  assert.deepEqual(await byKey(await valuationEntries({ productId: p.id, kind: "adjustment" })), { inventory: "-8.00", inventory_adjustment: "8.00" });
  assert.deepEqual(await value(p.id), { qty: "5", value: "40.00", variance: "12.00" });
  assert.equal(await prisma.auditLog.count({ where: { action: "standard_cost_changed", entityId: p.id } }), 1);
  await assert.rejects(prisma.$executeRaw`UPDATE "StandardCostChange" SET "reason" = 'x' WHERE "id" = ${change.id}`, /append-only/);
});

test("fail-safe: a standard-cost product without a standard cannot move stock; the method cannot be set without its variance accounts", async () => {
  // The database refuses the product outright (StockProduct_standard_cost_required)…
  await assert.rejects(prisma.stockProduct.create({ data: { name: `${TAG} NoStd`, unit: "KG", costingMethod: "standard" } }), /StockProduct_standard_cost_required/);
  // …and the service refuses to make one (no standard given).
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} ToStd`, unit: "KG" } });
  await assert.rejects(updateInventorySettings(p.id, { costing_method: "standard" }, acct), (e: { status?: number }) => e.status === 400);
  assert.equal((await prisma.stockProduct.findUniqueOrThrow({ where: { id: p.id } })).costingMethod, "avco", "unchanged");
  class Rollback extends Error {}
  let refused = null as { status?: number; code?: string } | null;
  await prisma.$transaction(async (tx) => {
    await tx.account.updateMany({ where: { systemKey: "ppv" }, data: { active: false } });
    refused = await assertStandardCostAccounts(tx).then(() => null, (e) => e);
    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  assert.equal(refused?.status, 409);
  assert.equal(refused?.code, "standard_cost_accounts_missing");
  assert.equal((await prisma.account.findFirstOrThrow({ where: { systemKey: "ppv" } })).active, true, "rolled back");
});

/** Receives 100 kg @ 9 of a standard-7 product graded into 70 good, 20 grade-B (own SKU, standard 3), 10 waste. */
async function gradedReceipt(label: string) {
  const a = await standardProduct(`${label} A`, "7");
  const b = await standardProduct(`${label} B`, "3");
  const r = await createIntake({ supplier_id: supplierId, product_id: a.id, received_kg: 100, grade_b_qty: 20, grade_b_product_id: b.id, waste_qty: 10, unit_cost: "9", received_date: today } as never, boss);
  const layers = await prisma.stockValuationLayer.findMany({ where: { movement: { intakeId: r.id } }, include: { movement: { select: { productId: true, quantity: true, location: { select: { type: true } } } } } });
  const entries = [...(await valuationEntries({ intakeId: r.id })), ...(await prisma.journalEntry.findMany({ where: { sourceId: `intake-waste|${r.id}` }, select: { id: true } })).map((e) => e.id)];
  return { a, b, layers, journal: await byKey(entries) };
}

test("grading a standard-cost receipt: every grade at its own standard, GRNI at the full 900, the difference is PPV", async () => {
  const g = await gradedReceipt("Grade");
  for (const l of g.layers) {
    assert.equal(l.costSource, "standard");
    assert.equal(D(l.unitCost).toFixed(4), l.movement.productId === g.b.id ? "3.0000" : "7.0000", `${l.movement.location.type} layer at its product's standard`);
  }
  const waste = g.layers.find((l) => l.movement.location.type === "waste");
  assert.equal(D(waste!.value).toFixed(2), "70.00", "waste carried at the standard until it is written off");
  assert.deepEqual(g.journal, { inventory: "620.00", ppv: "280.00", grni: "-900.00" }, "490 good + 60 grade-B + 70 waste; GRNI 100 × 9");
});

test("grading by market value with waste expensed at grading does not double-count a standard product's waste", async () => {
  // The NRV path needs market prices (the default price list). A temporary default list
  // prices both grades; an AVCO control receipt proves the NRV waste-loss path is really
  // taken with these prices, so the standard-cost result below is not a silent fallback.
  const list = await prisma.priceList.create({ data: { code: `${TAG}-PL`, name: `${TAG} أسعار`, isDefault: true, createdBy: "test" } });
  const r1 = await withSetting("inventory.grading_cost_policy", "nrv");
  const r2 = await withSetting("inventory.grading_waste_loss", "expense_at_grading");
  try {
    const price = (productId: string, unitPrice: string) => prisma.priceListItem.create({ data: { priceListId: list.id, productId, uomCode: "KG", unitPrice, validFrom: "2020-01-01", createdBy: "test" } });
    const ca = await prisma.stockProduct.create({ data: { name: `${TAG} NrvCtl A`, unit: "KG" } });
    const cb = await prisma.stockProduct.create({ data: { name: `${TAG} NrvCtl B`, unit: "KG" } });
    await price(ca.id, "15");
    await price(cb.id, "5");
    const ctl = await createIntake({ supplier_id: supplierId, product_id: ca.id, received_kg: 100, grade_b_qty: 20, grade_b_product_id: cb.id, waste_qty: 10, unit_cost: "9", received_date: today } as never, boss);
    assert.equal(await prisma.journalEntry.count({ where: { sourceId: `intake-waste|${ctl.id}` } }), 1, "control: the NRV waste-loss entry is posted for an AVCO product");
    const a = await standardProduct("GradeNrv A", "7");
    const b = await standardProduct("GradeNrv B", "3");
    await price(a.id, "15");
    await price(b.id, "5");
    const r = await createIntake({ supplier_id: supplierId, product_id: a.id, received_kg: 100, grade_b_qty: 20, grade_b_product_id: b.id, waste_qty: 10, unit_cost: "9", received_date: today } as never, boss);
    assert.equal(await prisma.journalEntry.count({ where: { sourceId: `intake-waste|${r.id}` } }), 0, "no separate waste-loss expense for a standard product");
    assert.deepEqual(await byKey(await valuationEntries({ intakeId: r.id })), { inventory: "620.00", ppv: "280.00", grni: "-900.00" }, "same as proportional");
  } finally {
    await r2();
    await r1();
    await prisma.priceList.update({ where: { id: list.id }, data: { isDefault: false, active: false } });
  }
});

test("other costing methods are untouched: an AVCO receipt carries no variance and posts Inventory ↔ GRNI only", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} Avco`, unit: "KG" } });
  const r = await receive(p.id, 10, { unit_cost: "9" });
  assert.deepEqual(await byKey(await valuationEntries({ intakeId: r.id })), { inventory: "90.00", grni: "-90.00" });
  assert.deepEqual(await value(p.id), { qty: "10", value: "90.00", variance: "0.00" });
});

test("the integrity report still reconciles inventory with the GL after all of the above", async () => {
  const report = await integrityReport();
  const inv = (report as { checks: { key: string; ok: boolean }[] }).checks.find((c) => c.key === "inventory");
  assert.ok(inv, "an inventory check exists");
  assert.equal(inv!.ok, true, JSON.stringify(inv));
});
