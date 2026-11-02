/* Controls closed in the 2026-11 maturity phase, against PostgreSQL:
     D20  a bank overdraft is an administrator's audited decision, never a cash box's;
     D13  undoing the opening stock needs the opening-balance approver;
     D18  scrapping sellable stock waits for a second person (waste-location stock does not);
     (SEC-02, no self password change, is proven over HTTP in tests/password-change-session.test.ts.) */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor, withSetting } from "./_db";
import { updateCashAccount } from "@/lib/accounting/treasury";
import { createIntake } from "@/lib/stock-service";
import { createScrap, postOpeningStock, reverseDocument } from "@/lib/inventory/documents";
import { todayLocalISO } from "@/lib/localDate";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/permissions";

const TAG = `ZZCTL${Date.now()}`;
const today = todayLocalISO();
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number; code?: string }) => e.code ?? e.status ?? -1);
let supplierId = "";

before(async () => {
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-2${String(Date.now()).slice(-7)}`, name: `${TAG} مورد` } })).id;
});
after(() => prisma.$disconnect());

test("D20: only an administrator may allow a bank overdraft, with a reason, audited; a cash box never", async () => {
  const accountant = actor("محاسب", [...ROLE_PERMISSIONS.ACCOUNTANT]);
  const admin = actor("مدير", ALL_PERMISSIONS);
  const bank = await prisma.cashAccount.findUniqueOrThrow({ where: { id: "bank_main" } });
  try {
    assert.equal(await status(updateCashAccount("bank_main", { allow_overdraft: true, overdraft_reason: "موافقة البنك 123" }, accountant)), 403, "the accountant cannot");
    assert.equal(await status(updateCashAccount("bank_main", { allow_overdraft: true }, admin)), "overdraft_reason_required");
    assert.equal(await status(updateCashAccount("cash_main", { allow_overdraft: true, overdraft_reason: "x" }, admin)), "overdraft_bank_only");
    await updateCashAccount("bank_main", { allow_overdraft: true, overdraft_reason: "موافقة البنك 123" }, admin);
    assert.equal((await prisma.cashAccount.findUniqueOrThrow({ where: { id: "bank_main" } })).allowOverdraft, true);
    const log = await prisma.auditLog.findFirst({ where: { entityId: "bank_main" }, orderBy: { timestamp: "desc" } });
    assert.match(log?.newValue ?? "", /موافقة البنك 123/, "audited with the reason");
  } finally {
    await prisma.cashAccount.update({ where: { id: "bank_main" }, data: { allowOverdraft: bank.allowOverdraft } });
  }
});

test("D13: a stock controller cannot reverse the opening stock alone; the opening-balance approver can", async () => {
  const restore = await withSetting("accounting.direct_opening_entries", true);
  try {
    const p = await prisma.stockProduct.create({ data: { name: `${TAG} Opening`, unit: "KG" } });
    const admin = actor("مدير", ALL_PERMISSIONS);
    const opened = await postOpeningStock({ date: today, lines: [{ product_id: p.id, quantity: "5", unit_cost: "4" }] }, admin) as { document?: { id: string }; id?: string };
    const docId = opened.document?.id ?? opened.id!;
    const controller = actor("أمين مخزن", [...ROLE_PERMISSIONS.STOCK_CONTROLLER]);
    assert.ok(!ROLE_PERMISSIONS.STOCK_CONTROLLER.includes("accounting.opening.approve"));
    assert.equal(await status(reverseDocument(docId, { reason: "غلط" }, controller)), 403);
    assert.equal((await prisma.inventoryDocument.findUniqueOrThrow({ where: { id: docId } })).status, "posted", "still posted");
    await reverseDocument(docId, { reason: "رصيد افتتاحي غلط" }, admin);
    assert.equal((await prisma.inventoryDocument.findUniqueOrThrow({ where: { id: docId } })).status, "reversed");
  } finally {
    await restore();
  }
});

test("D18: scrapping sellable stock waits for approval (nothing moves); scrapping the waste location posts", async () => {
  const restoreOn = await withSetting("inventory.adjustment_approval_required", true);
  // The receipt's waste must reach the waste location now, not wait in quarantine for its
  // own grading-loss approval (a different control, tested elsewhere).
  const restoreHold = await withSetting("inventory.grading_loss_approval_required", false);
  try {
    const boss = actor("أمين مخزن", ["stock.view", "stock.receive", "stock.adjust", "stock.sort"]);
    const p = await prisma.stockProduct.create({ data: { name: `${TAG} Scrap`, unit: "KG" } });
    await createIntake({ supplier_id: supplierId, product_id: p.id, received_kg: 20, waste_qty: 2, unit_cost: "3", received_date: today } as never, boss);
    const before = await prisma.stockMovement.count({ where: { productId: p.id } });
    const sellable = await createScrap({ reason: "تلف في التخزين", lines: [{ product_id: p.id, quantity: 3 }] }, boss) as { document: { id: string; status: string } };
    assert.equal(sellable.document.status, "pending_approval");
    assert.equal(await prisma.stockMovement.count({ where: { productId: p.id } }), before, "nothing moved");
    assert.ok(await prisma.approvalRequest.findFirst({ where: { type: "inventory.adjustment", entityId: sellable.document.id, status: "pending" } }), "an approval request exists");
    const waste = await createScrap({ reason: "إعدام الهالك", lines: [{ product_id: p.id, quantity: 2, location_id: "loc_waste" }] }, boss) as { document: { status: string } };
    assert.equal(waste.document.status, "posted", "the approved grading loss is written off directly");
  } finally {
    await restoreHold();
    await restoreOn();
  }
});
