/* Accounting gaps found by the 2026-11 maturity audit, each reproduced against PostgreSQL
   before it was fixed, and proven on the journal and the stock ledger afterwards. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, withSetting } from "./_db";
import { createIntake, updateIntake } from "@/lib/stock-service";
import { postJournal } from "@/lib/accounting/ledger";
import { createPayment } from "@/lib/accounting/cash";
import { apAgingReport, createBill, postBill } from "@/lib/purchasing/bills";
import { decideApproval } from "@/lib/core/approval-handlers";
import { ALL_PERMISSIONS } from "@/lib/permissions";
import { createAdjustment, createSupplierReturn, createCustomerReturn, reverseDocument } from "@/lib/inventory/documents";
import { issueStock } from "@/lib/inventory/reservations";
import { periodCloseChecklist } from "@/lib/accounting/close-checklist";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZGAP${Date.now()}`;
const boss = actor("أمين مخزن", ["stock.view", "stock.receive", "stock.sort", "stock.adjust", "stock.manage_products", "stock.approve_adjustments", "stock.valuation.view"]);
const today = todayLocalISO();
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
let supplierId = "";
let restore: () => Promise<void> = async () => {};

before(async () => {
  restore = await withSetting("inventory.grading_loss_approval_required", false);
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-5${String(Date.now()).slice(-7)}`, name: `${TAG} مورد` } })).id;
});
after(async () => {
  await restore();
  await prisma.$disconnect();
});

const onHand = async (productId: string) => D((await prisma.stockMovement.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity ?? 0).toString();

test("ACC-01: editing a graded receipt's notes changes no stock and no GL; a quantity correction moves only the good stock", async () => {
  const a = await prisma.stockProduct.create({ data: { name: `${TAG} A`, unit: "KG" } });
  const b = await prisma.stockProduct.create({ data: { name: `${TAG} B`, unit: "KG" } });
  const r = await createIntake({ supplier_id: supplierId, product_id: a.id, received_kg: 100, grade_b_qty: 20, grade_b_product_id: b.id, waste_qty: 10, unit_cost: "9", received_date: today } as never, boss);
  const before = { a: await onHand(a.id), b: await onHand(b.id), moves: await prisma.stockMovement.count({ where: { intakeId: r.id } }), entries: await prisma.stockValuationPosting.count({ where: { movement: { intakeId: r.id } } }) };
  assert.deepEqual([before.a, before.b], ["80", "20"], "70 good + 10 waste on A, 20 grade-B on B");
  const i1 = await prisma.stockIntake.findUniqueOrThrow({ where: { id: r.id } });
  await updateIntake(r.id, { notes: "ملاحظة على الاستلام" } as never, boss, "ملاحظة", i1.version);
  const i2 = await prisma.stockIntake.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(i2.notes, "ملاحظة على الاستلام");
  assert.equal(D(i2.goodQty).toString(), "70", "good quantity unchanged by a notes edit");
  assert.equal(await prisma.stockMovement.count({ where: { intakeId: r.id } }), before.moves, "no stock movement from a notes edit");
  assert.deepEqual([await onHand(a.id), await onHand(b.id)], ["80", "20"], "no phantom stock");
  // A real correction (received 100 → 104, grading unchanged) moves exactly +4 good kg at the receipt price.
  await updateIntake(r.id, { received_kg: "104" } as never, boss, "وزن أعيد", i2.version);
  const i3 = await prisma.stockIntake.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(D(i3.goodQty).toString(), "74");
  assert.deepEqual([await onHand(a.id), await onHand(b.id)], ["84", "20"]);
  const corr = await prisma.stockMovement.findMany({ where: { intakeId: r.id, kind: "intake_correction" }, include: { valuation: true } });
  assert.equal(corr.length, 1);
  assert.deepEqual([D(corr[0].quantity).toString(), D(corr[0].valuation!.value).toFixed(2)], ["4", "36.00"]);
});

class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back; returns what it returned. */
async function rolledBack<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await prisma.$transaction(async (tx) => { out = await fn(tx); throw new Rollback(); }, { timeout: 20_000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  return out as T;
}
const entry = (date: string, sourceType = "manual") => ({ date, description: "ACC-02 test", sourceType: sourceType as never, sourceId: `acc02-${Date.now()}-${Math.random()}`, lines: [{ key: "cash" as const, amount: D(10) }, { key: "capital" as const, amount: D(-10) }] });
const sys = { id: null, name: "اختبار", role: "SYSTEM" };
const settle = (p: Promise<unknown>) => p.then(() => "posted", (e: { code?: string; message?: string }) => e.code ?? e.message ?? "error");

test("ACC-02: nothing posts into a closed fiscal year, even a month that never had a period row — app and database", async () => {
  const r = await rolledBack(async (tx) => {
    await tx.fiscalYear.create({ data: { code: "2001", startDate: "2001-01-01", endDate: "2001-12-31", status: "closed", closedAt: new Date(), closedBy: "اختبار" } });
    const noRow = (await tx.accountingPeriod.count({ where: { code: "2001-06" } })) === 0;
    const app = await settle(postJournal(tx as never, entry("2001-06-15"), sys));
    const closingAllowed = await settle(postJournal(tx as never, entry("2001-12-31", "year_end_reopen"), sys));
    let raw = "posted";
    try {
      await tx.$executeRaw`SAVEPOINT s1`;
      await tx.$executeRaw`INSERT INTO "JournalEntry" ("id","number","date","description","sourceType","sourceId","total","createdBy") VALUES (${"acc02-raw"}, 'JE-2001-00001', '2001-07-01', 'raw', 'manual', 'acc02-raw', 10, 'x')`;
    } catch (e) {
      raw = String((e as Error).message).includes("fiscal_year_closed") ? "fiscal_year_closed" : String(e);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
    }
    return { noRow, app, closingAllowed, raw };
  });
  assert.equal(r.noRow, true, "precondition: the month has no period row");
  assert.equal(r.app, "fiscal_year_closed", "the application refuses");
  assert.equal(r.raw, "fiscal_year_closed", "the database refuses raw SQL too");
  assert.equal(r.closingAllowed, "posted", "the year-end reversal workflow is still allowed to post");
});

test("ACC-02: the books lock date refuses postings on or before it (app and database); after it posts", async () => {
  const restoreLock = await withSetting("accounting.lock_date", "2002-12-31");
  try {
    const r = await rolledBack(async (tx) => {
      const onLock = await settle(postJournal(tx as never, entry("2002-12-31"), sys));
      const before = await settle(postJournal(tx as never, entry("2002-03-01"), sys));
      const after = await settle(postJournal(tx as never, entry("2003-01-02"), sys));
      let raw = "posted";
      try {
        await tx.$executeRaw`SAVEPOINT s1`;
        await tx.$executeRaw`INSERT INTO "JournalEntry" ("id","number","date","description","sourceType","sourceId","total","createdBy") VALUES (${"acc02-lock"}, 'JE-2002-00001', '2002-05-01', 'raw', 'manual', 'acc02-lock', 10, 'x')`;
      } catch (e) {
        raw = String((e as Error).message).includes("accounting_lock_date") ? "accounting_lock_date" : String(e);
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      }
      return { onLock, before, after, raw };
    });
    assert.deepEqual(r, { onLock: "accounting_lock_date", before: "accounting_lock_date", after: "posted", raw: "accounting_lock_date" });
  } finally {
    await restoreLock();
  }
});

test("ACC-02: a back-dated stock document into a locked date is not refused — its value posts today, audited", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} Locked`, unit: "KG" } });
  await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 10, unit_cost: "5", received_date: today } as never, boss);
  const restoreApproval = await withSetting("inventory.adjustment_approval_required", false);
  const lockDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const restoreLock = await withSetting("accounting.lock_date", lockDay);
  try {
    await createAdjustment({ reason: "تسوية بأثر رجعي", business_date: lockDay, lines: [{ product_id: p.id, quantity: -1 }] }, boss);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { productId: p.id, kind: "adjustment" }, include: { valuationPosting: { include: { entry: true } } } });
    assert.equal(mv.effectiveDate, lockDay, "the stock movement keeps its business date");
    assert.equal(mv.valuationPosting?.entry?.date, today, "its value posts today (the lock date closes the original day)");
    assert.equal(await prisma.auditLog.count({ where: { action: "stock_valuation_redated", entityId: mv.valuationPosting!.entry!.id } }), 1, "and the shift is audited");
  } finally {
    await restoreLock();
    await restoreApproval();
  }
});

/** Signed (debit − credit) per system key over the stock-valuation entries of a document's movements. */
async function glOfDocument(documentId: string) {
  const posts = await prisma.stockValuationPosting.findMany({ where: { movement: { documentId } }, select: { entryId: true } });
  const lines = await prisma.journalLine.findMany({ where: { entryId: { in: [...new Set(posts.map((p) => p.entryId!).filter(Boolean))] } }, include: { account: { select: { systemKey: true } } } });
  const out: Record<string, string> = {};
  for (const l of lines) { const k = l.account.systemKey ?? l.accountId; out[k] = D(out[k] ?? 0).plus(l.debit).minus(l.credit).toFixed(2); }
  for (const k of Object.keys(out)) if (D(out[k]).isZero()) delete out[k];
  return out;
}
const docOf = (r: unknown) => ((r as { document?: { id: string } }).document?.id ?? (r as { id: string }).id);

test("ACC-03: reversing a supplier return takes the goods back against GRNI — not a gain in inventory adjustments", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} SupRet`, unit: "KG" } });
  await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 10, unit_cost: "9", received_date: today } as never, boss);
  const ret = docOf(await createSupplierReturn({ supplier_id: supplierId, reason: "جودة", lines: [{ product_id: p.id, quantity: 3 }] }, boss));
  assert.deepEqual(await glOfDocument(ret), { inventory: "-27.00", grni: "27.00" });
  const rev = docOf(await reverseDocument(ret, { reason: "المورد رفض المرتجع" }, boss));
  assert.deepEqual(await glOfDocument(rev), { inventory: "27.00", grni: "-27.00" }, "the reversal is the exact opposite, against GRNI");
  assert.equal(await onHand(p.id), "10");
});

test("ACC-03: a standard-cost supplier return reversed brings back the variance too", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} SupRetStd`, unit: "KG", costingMethod: "standard", standardCost: "7" } });
  await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 10, unit_cost: "9", received_date: today } as never, boss);
  const lot = (await prisma.stockMovement.findFirstOrThrow({ where: { productId: p.id, kind: "intake" } })).lotId;
  const ret = docOf(await createSupplierReturn({ supplier_id: supplierId, reason: "جودة", lines: [{ product_id: p.id, quantity: 2, lot_id: lot }] }, boss));
  const out = await glOfDocument(ret);
  const rev = docOf(await reverseDocument(ret, { reason: "إلغاء" }, boss));
  const back = await glOfDocument(rev);
  for (const k of Object.keys(out)) assert.equal(D(back[k] ?? 0).plus(out[k]).toFixed(2), "0.00", `${k} nets to zero`);
  assert.equal(out.inventory, "-14.00", "out at the standard");
});

test("ACC-03: reversing a customer return issues the goods again against COGS", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} CusRet`, unit: "KG" } });
  await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 10, unit_cost: "6", received_date: today } as never, boss);
  const ret = docOf(await createCustomerReturn({ reason: "مرتجع عميل", lines: [{ product_id: p.id, quantity: 2, location_id: "loc_recv" }] }, boss));
  const inMoves = await glOfDocument(ret);
  assert.equal(inMoves.cogs, "-12.00", "the return reduced COGS at 6");
  const rev = docOf(await reverseDocument(ret, { reason: "تسجيل غلط" }, boss));
  assert.deepEqual(await glOfDocument(rev), { inventory: "-12.00", cogs: "12.00" }, "back through COGS, not adjustments");
  const kinds = await prisma.stockMovement.findMany({ where: { documentId: rev }, select: { kind: true } });
  assert.deepEqual(kinds.map((k) => k.kind), ["issue"], "the reversal of a return is an issue");
});

test("ACC-04: with payment approval on, a supplier payment waits — nothing posts — until someone else approves it", async () => {
  const restoreOn = await withSetting("accounting.payment_approval", true);
  try {
    const users = await prisma.user.findMany({ where: { username: { in: ["karim", "admin"] } }, select: { id: true, name: true, username: true } });
    const karim = users.find((u) => u.username === "karim")!, admin = users.find((u) => u.username === "admin")!;
    const clerk = actor(karim.name, ["accounting.payments.manage", "accounting.manage"], karim.id, "ACCOUNTANT");
    const sup = (await prisma.supplier.create({ data: { code: `SUP-4${String(Date.now()).slice(-7)}`, name: `${TAG} مورد سداد` } })).id;
    // Money in the bank first (cash never goes negative): an opening capital line.
    await inTxPost(entry(today, "manual"));
    const cashGl = (await prisma.cashAccount.findUniqueOrThrow({ where: { id: "cash_main" } })).accountId;
    const glCash = async () => { const a = await prisma.journalLine.aggregate({ where: { accountId: cashGl }, _sum: { debit: true, credit: true } }); return D(a._sum.debit ?? 0).minus(a._sum.credit ?? 0).toFixed(2); };
    const before = { cash: await glCash(), payments: await prisma.supplierPayment.count({ where: { supplierId: sup } }) };

    const key = `acc04-${Date.now()}`;
    const r = await createPayment({ party_id: sup, cash_account_id: "cash_main", amount: "7", method: "cash", idempotency_key: key }, clerk) as { paymentRequest?: { id: string; status: string; number: string }; payment?: unknown };
    assert.ok(r.paymentRequest && !r.payment, "a request, not a payment");
    assert.equal(r.paymentRequest!.status, "pending_approval");
    assert.match(r.paymentRequest!.number, /^SPR-\d{4}-\d{5}$/);
    assert.deepEqual({ cash: await glCash(), payments: await prisma.supplierPayment.count({ where: { supplierId: sup } }) }, before, "nothing posted while it waits");
    const replay = await createPayment({ party_id: sup, cash_account_id: "cash_main", amount: "7", method: "cash", idempotency_key: key }, clerk) as { paymentRequest?: { id: string } };
    assert.equal(replay.paymentRequest?.id, r.paymentRequest!.id, "a retried submit returns the same request");

    const appr = await prisma.approvalRequest.findFirstOrThrow({ where: { type: "accounting.supplier_payment", entityId: r.paymentRequest!.id, status: "pending" } });
    const self = await decideApproval(appr.id, "approve", { id: karim.id, name: karim.name, role: "ACCOUNTANT", permissions: ["accounting.manage"] }, {}).then(() => 0, (e: { status?: number }) => e.status);
    assert.equal(self, 403, "the requester cannot approve their own payment");
    await decideApproval(appr.id, "approve", { id: admin.id, name: admin.name, role: "SUPER_ADMIN", permissions: ALL_PERMISSIONS }, { comment: "تمام" });
    const req = await prisma.supplierPaymentRequest.findUniqueOrThrow({ where: { id: r.paymentRequest!.id }, include: { payment: true } });
    assert.equal(req.status, "posted");
    assert.ok(req.payment, "the payment exists now");
    assert.equal(req.payment!.createdBy, karim.name, "recorded as the requester's");
    assert.equal(req.decidedBy, admin.name);
    assert.equal(D(before.cash).minus(await glCash()).toFixed(2), "7.00", "cash moved by 7 only now");
    const lines = await prisma.journalLine.findMany({ where: { entry: { sourceType: "supplier_payment", sourceId: req.payment!.id } }, include: { account: { select: { systemKey: true } } } });
    assert.deepEqual(lines.map((l) => [l.account.systemKey, D(l.debit).minus(l.credit).toFixed(2)]).sort(), [["ap", "7.00"], ["cash", "-7.00"]]);
    await assert.rejects(prisma.$executeRaw`UPDATE "SupplierPaymentRequest" SET "amount" = 1 WHERE "id" = ${req.id}`, /keeps what was asked/);

    // Rejected: nothing moves.
    const r2 = await createPayment({ party_id: sup, cash_account_id: "cash_main", amount: "2", method: "cash" }, clerk) as { paymentRequest: { id: string } };
    const a2 = await prisma.approvalRequest.findFirstOrThrow({ where: { entityId: r2.paymentRequest.id, status: "pending" } });
    await decideApproval(a2.id, "reject", { id: admin.id, name: admin.name, role: "SUPER_ADMIN", permissions: ALL_PERMISSIONS }, { comment: "مش مستحق" });
    const rej = await prisma.supplierPaymentRequest.findUniqueOrThrow({ where: { id: r2.paymentRequest.id } });
    assert.deepEqual([rej.status, rej.paymentId], ["rejected", null]);
    assert.equal(await prisma.supplierPayment.count({ where: { supplierId: sup } }), 1, "only the approved one exists");
    // More than the box holds: refused at request time, nothing recorded.
    const big = await createPayment({ party_id: sup, cash_account_id: "cash_main", amount: "99999999", method: "cash" }, clerk).then(() => 0, (e: { status?: number; code?: string }) => e.code);
    assert.equal(big, "cash_account_negative");
  } finally {
    await restoreOn();
  }
});

async function inTxPost(e: ReturnType<typeof entry>) {
  const { inTx } = await import("./_db");
  await inTx((tx) => postJournal(tx, e, sys));
}

test("ACC-10: nothing posts dated after the end of the current month; the month end itself is fine", async () => {
  const [y, m] = today.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const r = await rolledBack(async (tx) => ({ end: await settle(postJournal(tx as never, entry(monthEnd), sys)), after: await settle(postJournal(tx as never, entry(nextMonth), sys)) }));
  assert.deepEqual(r, { end: "posted", after: "future_posting_date" });
});

test("ACC-16: the balance sheet shows contra balances and a loss with their real sign, and still balances", async () => {
  const { balanceSheet } = await import("@/lib/accounting/ledger");
  const bs = await rolledBack(async () => balanceSheet(today));
  const sum = (lines: { amount: string }[]) => lines.reduce((s, l) => s.plus(l.amount), D(0)).toFixed(2);
  assert.equal(sum(bs.sections.assets.lines), D(bs.sections.assets.total).toFixed(2), "asset lines add up to the asset total");
  assert.equal(sum(bs.sections.liabilities.lines), D(bs.sections.liabilities.total).toFixed(2), "liability lines add up to the liability total");
  assert.equal(sum(bs.sections.equity.lines), D(bs.sections.equity.total).toFixed(2), "equity lines (with net income signed) add up to the equity total");
  assert.equal((bs as { _balanced?: boolean })._balanced, true);
});

test("ACC-08: an aging for a past day ignores payments made after it — the bill is fully open on that day", async () => {
  const restore = await withSetting("accounting.payment_approval", false);
  try {
    const acct = actor("محاسب", ["purchasing.bills.manage", "purchasing.bills.view", "accounting.payments.manage", "accounting.manage"]);
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const sup = (await prisma.supplier.create({ data: { code: `SUP-3${String(Date.now()).slice(-7)}`, name: `${TAG} مورد أعمار`, paymentTermsDays: 30 } })).id;
    const p = await prisma.stockProduct.create({ data: { name: `${TAG} Aging`, unit: "KG" } });
    const r = await createIntake({ supplier_id: sup, product_id: p.id, received_kg: 10, unit_cost: "5", received_date: yesterday } as never, boss);
    const bill = await postBill((await createBill({ supplier_id: sup, supplier_invoice_no: `${TAG}-AG`, bill_date: yesterday, lines: [{ intake_id: r.id, unit_price: "5" }] }, acct)).id, acct);
    assert.equal(bill.status, "posted");
    await inTxPost(entry(today, "manual"));
    await createPayment({ party_id: sup, cash_account_id: "cash_main", amount: "10", date: today, method: "cash", allocations: [{ document_id: bill.id, amount: "10" }] }, acct);
    const rowOf = async (asOf: string) => ((await apAgingReport(asOf)).rows as { supplier: { id: string }; total: Prisma.Decimal | string }[]).find((x) => x.supplier.id === sup);
    assert.equal(D((await rowOf(yesterday))!.total).toFixed(2), "50.00", "yesterday: the whole bill was open");
    assert.equal(D((await rowOf(today))!.total).toFixed(2), "40.00", "today: 10 paid");
  } finally {
    await restore();
  }
});

test("ACC-07: goods returned against an order come back at the cost they left at — not today's average", async () => {
  const restore = await withSetting("inventory.adjustment_approval_required", false);
  try {
    const p = await prisma.stockProduct.create({ data: { name: `${TAG} RetCost`, unit: "KG" } });
    await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 10, unit_cost: "6", received_date: today } as never, boss);
    const order = await prisma.order.create({ data: { orderNumber: `${TAG}-RC`, customerName: `${TAG} فندق`, deliveryDate: today } });
    const { inTx } = await import("./_db");
    await inTx((tx) => issueStock(tx, { warehouseId: "wh_main", sourceType: "order", sourceId: order.id, reference: `${TAG} RC`, lines: [{ productId: p.id, quantity: D(4), sourceLineId: `${TAG}-RC-1` }] }, boss as never));
    // The average moves: 6 kg left at 6, 10 more arrive at 12 → (36 + 120) / 16 = 9.75.
    await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 10, unit_cost: "12", received_date: today } as never, boss);
    const ret = docOf(await createCustomerReturn({ order_id: order.id, reason: "رجع من العميل", lines: [{ product_id: p.id, quantity: 2, location_id: "loc_recv" }] }, boss));
    const layer = await prisma.stockValuationLayer.findFirstOrThrow({ where: { movement: { documentId: ret } } });
    assert.equal(D(layer.unitCost).toFixed(2), "6.00", "back at the 6 it left at, not the 9.75 average");
    assert.deepEqual(await glOfDocument(ret), { inventory: "12.00", cogs: "-12.00" }, "COGS reduced by exactly what it was charged");
  } finally {
    await restore();
  }
});

test("ACC-13: the month-close checklist lists a dispatched order with no invoice (a warning, with where to fix it)", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} Close`, unit: "KG" } });
  await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 5, unit_cost: "3", received_date: today } as never, boss);
  const before = (await periodCloseChecklist(today.slice(0, 7))).warnings.find((w) => w.code === "dispatched_not_invoiced")?.count ?? 0;
  const order = await prisma.order.create({ data: { orderNumber: `${TAG}-CL`, customerName: `${TAG} مطعم`, deliveryDate: today } });
  const { inTx } = await import("./_db");
  await inTx((tx) => issueStock(tx, { warehouseId: "wh_main", sourceType: "order", sourceId: order.id, reference: `${TAG} CL`, lines: [{ productId: p.id, quantity: D(1), sourceLineId: `${TAG}-CL-1` }] }, boss as never));
  const w = (await periodCloseChecklist(today.slice(0, 7))).warnings.find((x) => x.code === "dispatched_not_invoiced");
  assert.equal(w?.count, before + 1);
  assert.equal(w?.href, "/sales");
  await assert.rejects(periodCloseChecklist("2026-13x"), (e: { status?: number }) => e.status === 400);
});

test("standard costing: a customer return against an order comes back at the standard, with no variance", async () => {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} StdRet`, unit: "KG", costingMethod: "standard", standardCost: "7" } });
  await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 10, unit_cost: "9", received_date: today } as never, boss);
  const order = await prisma.order.create({ data: { orderNumber: `${TAG}-SR`, customerName: `${TAG} فندق`, deliveryDate: today } });
  const { inTx } = await import("./_db");
  await inTx((tx) => issueStock(tx, { warehouseId: "wh_main", sourceType: "order", sourceId: order.id, reference: `${TAG} SR`, lines: [{ productId: p.id, quantity: D(4), sourceLineId: `${TAG}-SR-1` }] }, boss as never));
  const ret = docOf(await createCustomerReturn({ order_id: order.id, reason: "رجوع", lines: [{ product_id: p.id, quantity: 1, location_id: "loc_recv" }] }, boss));
  const layer = await prisma.stockValuationLayer.findFirstOrThrow({ where: { movement: { documentId: ret } } });
  assert.deepEqual([layer.costSource, D(layer.unitCost).toFixed(2), D(layer.priceVariance).toFixed(2)], ["standard", "7.00", "0.00"]);
  assert.deepEqual(await glOfDocument(ret), { inventory: "7.00", cogs: "-7.00" });
});
