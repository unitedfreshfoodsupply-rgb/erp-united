/* SEC follow-up (Nov 2026): GET /api/audit follows the same money rules as the stock audit and
   the profiles. A stock controller given audit.view by a per-user override (no purchase prices,
   no stock cost) sees neither the agreed supplier prices, nor a receipt's provisional unit cost,
   nor the values of a cost-field change; whoever may see stock cost still does. The route only
   authenticates, builds the filter and serialises auditLogFor, so the rules are tested on it.
   Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createSupplierFull, setSupplierPrices } from "@/lib/purchasing/suppliers";
import { recordIntake } from "@/lib/stock-service";
import { auditLogFor, auditPage } from "@/app/api/audit/query";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZAUDLOG${Date.now()}`;
const buyer = actor("مشتريات", ["purchasing.suppliers.view", "purchasing.suppliers.manage", "purchasing.prices.view", "purchasing.prices.manage"], "audl-buyer");
const receiver = actor("أمين المخزن", ["stock.receive", "stock.view"], "audl-receiver", "STOCK_CONTROLLER");
// The default stock controller has no audit.view; an administrator can grant it per user.
const stockController = { permissions: [...ROLE_PERMISSIONS.STOCK_CONTROLLER, "audit.view"] };
const accountant = { permissions: ROLE_PERMISSIONS.ACCOUNTANT };

after(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: TAG } } });
  await prisma.$disconnect();
});

type Log = { action: string; oldValue: string | null; newValue: string | null; reason: string | null };
const page = async (viewer: { permissions: readonly string[] }, entityId: string) =>
  (await auditLogFor(viewer, { entityId }, 50, 0, { likelyShort: true })).logs as Log[];

test("agreed supplier prices leave /api/audit only for those who may see purchase prices", async () => {
  assert.ok(!stockController.permissions.includes("purchasing.prices.view"));
  const supplier = await createSupplierFull({ name: `${TAG} Farm`, category: "vegetable" }, buyer);
  const product = await prisma.stockProduct.create({ data: { name: `${TAG} Tomato` } });
  await setSupplierPrices(supplier.id, { valid_from: todayLocalISO(), prices: [{ product_id: product.id, unit_price: "8.5" }] }, buyer);

  const seen = await page(stockController, supplier.id);
  assert.deepEqual(seen.map((l) => l.action), ["supplier_created"], "no supplier_price_* row reaches the stock controller");
  assert.ok(!JSON.stringify(seen).includes("8.5"));
  assert.deepEqual((await page(accountant, supplier.id)).map((l) => l.action).sort(), ["supplier_created", "supplier_price_set"]);
});

test("a receipt's provisional unit cost leaves /api/audit only for those who may see stock cost", async () => {
  const supplier = await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${TAG} Gate Farm` } });
  const product = await prisma.stockProduct.create({ data: { name: `${TAG} Pepper` } });
  const { intake } = await recordIntake({ supplier_id: supplier.id, product_id: product.id, received_kg: 30, provisional_unit_cost: "11.75", location_id: "loc_cold_1" }, receiver);
  const written = await prisma.auditLog.findFirstOrThrow({ where: { entityId: intake.id, action: "stock_intake_created" } });
  assert.match(written.newValue ?? "", / · سعر مؤقت 11\.7500$/, "the trail itself keeps the amount");

  const atTheGate = (await page(stockController, intake.id)).find((l) => l.action === "stock_intake_created");
  assert.ok(atTheGate?.newValue?.endsWith(" · سعر مؤقت"), atTheGate?.newValue ?? "");
  assert.ok(!atTheGate?.newValue?.includes("11.75"));
  assert.ok(atTheGate?.newValue?.startsWith(intake.receiptNumber), "the rest of the line is unchanged");

  const forFinance = (await page(accountant, intake.id)).find((l) => l.action === "stock_intake_created");
  assert.equal(forFinance?.newValue, written.newValue);
});

test("a cost-field change keeps the fact and loses the amounts and reason without stock.valuation.view", async () => {
  const entityId = `${TAG}-lot`;
  await prisma.auditLog.create({
    data: { userName: "audit-log-test", role: "ACCOUNTANT", action: "stock_lot_cost_revalued", entityType: "stock_lot", entityId, fieldChanged: "unitCost", oldValue: "10.0000", newValue: "12.0000", reason: "إعادة تقييم الاستلام RCV-1 (سعر مؤقت 10.0000)", source: "system" },
  });
  const [atTheGate] = await page(stockController, entityId);
  assert.equal(atTheGate.action, "stock_lot_cost_revalued", "the change itself is still shown");
  assert.deepEqual([atTheGate.oldValue, atTheGate.newValue, atTheGate.reason], [null, null, null]);
  const [forFinance] = await page(accountant, entityId);
  assert.deepEqual([forFinance.oldValue, forFinance.newValue], ["10.0000", "12.0000"]);
});

test("rows written in the same millisecond come back in a stable order: newest id first", async () => {
  const at = new Date();
  const ids = [`${TAG}a`, `${TAG}b`, `${TAG}c`].map((s) => s.toLowerCase());
  // Inserted out of id order, all with one timestamp.
  for (const id of [ids[1], ids[2], ids[0]]) {
    await prisma.auditLog.create({ data: { id, userName: "audit-log-test", role: "ADMIN", action: "test_recorded", entityType: "settings", entityId: `${TAG}-tie`, source: "system", timestamp: at } });
  }
  try {
    for (let i = 0; i < 3; i++) {
      const { rows } = await auditPage({ entityId: `${TAG}-tie` }, 50, 0);
      assert.deepEqual(rows.map((r) => r.id), [ids[2], ids[1], ids[0]]);
    }
  } finally {
    await prisma.auditLog.deleteMany({ where: { id: { in: ids } } });
  }
});
