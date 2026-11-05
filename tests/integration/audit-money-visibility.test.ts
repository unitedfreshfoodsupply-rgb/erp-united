/* SEC-1 (Nov 2026): the two audit readers outside /api/audit — the supplier profile's History
   tab and the stock module's audit (GET /api/stock/audit) — follow the same money rules as the
   profiles. A stock controller (decision D-2: supplier profiles, no purchase prices, no stock
   cost) sees neither the agreed supplier prices nor a receipt's provisional unit cost; the buyer
   and whoever may see stock cost still do. Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/permissions";
import { createSupplierFull, setSupplierPrices } from "@/lib/purchasing/suppliers";
import { recordIntake } from "@/lib/stock-service";
import { profileSection, windowOf } from "@/lib/profiles/service";
import { visibleAuditRows, withoutProvisionalCost } from "@/lib/security/audit-visibility";
import { redactCosts } from "@/lib/security/redact";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZAUDMONEY${Date.now()}`;
const buyer = actor("مشتريات", ["purchasing.suppliers.view", "purchasing.suppliers.manage", "purchasing.prices.view", "purchasing.prices.manage"], "audm-buyer");
const receiver = actor("أمين المخزن", ["stock.receive", "stock.view"], "audm-receiver", "STOCK_CONTROLLER");
const canOf = (perms: readonly string[]) => (p: Permission) => perms.includes(p);
const stockController = canOf(ROLE_PERMISSIONS.STOCK_CONTROLLER);
const accountant = canOf(ROLE_PERMISSIONS.ACCOUNTANT);

after(async () => { await prisma.$disconnect(); });

/** What GET /api/stock/audit?entity_id= reads, then answers (app/api/stock/audit/route.ts). */
const stockAudit = async (entityId: string, can: (p: Permission) => boolean) => {
  const logs = await prisma.auditLog.findMany({ where: { entityId }, orderBy: { timestamp: "desc" }, take: 100 });
  return withoutProvisionalCost(visibleAuditRows(logs, can), can);
};

test("the supplier profile's History tab drops agreed prices for a stock controller and keeps them for the buyer", async () => {
  assert.ok(!ROLE_PERMISSIONS.STOCK_CONTROLLER.includes("purchasing.prices.view"), "D-2: the stock controller has no purchase prices");
  const supplier = await createSupplierFull({ name: `${TAG} Farm`, category: "vegetable" }, buyer);
  const product = await prisma.stockProduct.create({ data: { name: `${TAG} Tomato` } });
  await setSupplierPrices(supplier.id, { valid_from: todayLocalISO(), prices: [{ product_id: product.id, unit_price: "7.5" }] }, buyer);
  await setSupplierPrices(supplier.id, { valid_from: todayLocalISO(), prices: [{ product_id: product.id, unit_price: "7.75" }] }, buyer);

  const history = async (can: (p: Permission) => boolean) =>
    ((await profileSection("supplier", supplier.id, "history", can, windowOf(new URLSearchParams()))) as { data: { action: string; oldValue: string | null; newValue: string | null }[]; total: number });

  const seenByBuyer = await history(canOf(buyer.permissions));
  assert.deepEqual(seenByBuyer.data.map((l) => l.action).sort(), ["supplier_created", "supplier_price_corrected", "supplier_price_set"]);
  assert.equal(seenByBuyer.data.find((l) => l.action === "supplier_price_corrected")?.newValue, "7.75");

  const seenAtTheGate = await history(stockController);
  assert.deepEqual(seenAtTheGate.data.map((l) => l.action), ["supplier_created"], "no supplier_price_* row reaches the stock controller");
  assert.equal(seenAtTheGate.total, 1, "the count matches what is shown");
  assert.ok(!JSON.stringify(seenAtTheGate).includes("7.75") && !JSON.stringify(seenAtTheGate).includes("7.5"));

  // The stock module's audit reads the same supplier rows: same rule.
  assert.deepEqual((await stockAudit(supplier.id, stockController)).map((l) => l.action), ["supplier_created"]);
  assert.equal((await stockAudit(supplier.id, accountant)).length, 3);
});

test("a receipt's provisional unit cost leaves the stock audit only for those who may see stock cost", async () => {
  const supplier = await prisma.supplier.create({ data: { code: `SUP-8${String(Date.now()).slice(-7)}`, name: `${TAG} Gate Farm` } });
  const product = await prisma.stockProduct.create({ data: { name: `${TAG} Pepper` } });
  const { intake } = await recordIntake({ supplier_id: supplier.id, product_id: product.id, received_kg: 40, provisional_unit_cost: "9.25", location_id: "loc_cold_1" }, receiver);
  assert.equal(intake.costProvisional, true);

  const written = await prisma.auditLog.findFirstOrThrow({ where: { entityId: intake.id, action: "stock_intake_created" } });
  assert.match(written.newValue ?? "", / · سعر مؤقت 9\.2500$/, "the trail itself keeps the amount");

  const atTheGate = (await stockAudit(intake.id, stockController)).find((l) => l.action === "stock_intake_created");
  assert.ok(atTheGate?.newValue?.endsWith(" · سعر مؤقت"), atTheGate?.newValue ?? "");
  assert.ok(!atTheGate?.newValue?.includes("9.25"));
  assert.ok(atTheGate?.newValue?.startsWith(intake.receiptNumber), "the rest of the line is unchanged");

  const forFinance = (await stockAudit(intake.id, accountant)).find((l) => l.action === "stock_intake_created");
  assert.equal(forFinance?.newValue, written.newValue);
  // A receipt at an agreed cost is untouched.
  const agreed = (await recordIntake({ supplier_id: supplier.id, product_id: product.id, received_kg: 10, unit_cost: "6", location_id: "loc_cold_1" }, receiver)).intake;
  assert.deepEqual(await stockAudit(agreed.id, stockController), await stockAudit(agreed.id, accountant));
});

test("a cost-field change keeps the fact, not the amounts — its reason (written in costs) included", () => {
  const row = { action: "stock_lot_cost_revalued", entityType: "stock_lot", fieldChanged: "unitCost", oldValue: "10.0000", newValue: "12.0000", reason: "إعادة تقييم الاستلام RCV-1 (سعر مؤقت 10.0000) بفاتورة BILL-1", userName: "x" };
  assert.deepEqual(redactCosts({ logs: [row] }), { logs: [{ ...row, oldValue: null, newValue: null, reason: null }] });
  // Any other row keeps its reason.
  const other = { action: "stock_intake_updated", entityType: "stock_intake", fieldChanged: "receivedQty", oldValue: "40", newValue: "42", reason: "وزن تاني" };
  assert.deepEqual(redactCosts({ logs: [other] }), { logs: [other] });
});
