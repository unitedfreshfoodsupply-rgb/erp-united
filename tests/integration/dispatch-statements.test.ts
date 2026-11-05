import { countQueries } from "./_query-count";
/* Dispatching an order, and taking a dispatched order back, cost a fixed number of database
   statements whatever the number of lines (PW-1 / PM-1, Nov 2026).

   Production runs ~37 ms per round trip on one pooled connection, inside a 20 s transaction:
   the per-line stock-out path (~22 statements a line) failed every order of 20+ lines. The
   batched path reads availability, reservations, buckets and valuations once per document and
   writes movements and layers in bulk, so 5 lines and 50 lines cost the same. Lines mix AVCO
   and FIFO products, lots in two locations (FEFO picks across buckets) and a packaging unit.
   Synthetic data on the test database. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, inTx, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { postMovements, type MoveInput } from "@/lib/inventory/ledger";
import { reverseDispatchIssue } from "@/lib/inventory/dispatch";
import { D } from "@/lib/inventory/decimal";
import { createCustomer } from "@/lib/sales/customers";
import { createOrder, moveOrderStatus, reopenOrder } from "@/lib/orders-service";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZDST${Date.now()}`;
const today = todayLocalISO();
const day = `2099-10-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role] as string[], ids[username], role), source: "manual" as const });
let sales: ReturnType<typeof as>, loader: ReturnType<typeof as>, sup: ReturnType<typeof as>;
let customerId = "";
let supplierId = "";
let seq = 0;

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  sales = as("mona", "SALES", "منى مبيعات");
  loader = as("mostafa", "LOADER", "مصطفى تحميل");
  sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${TAG} مورد` } })).id;
});
after(() => prisma.$disconnect());

/** `n` products, each with two lots in two cold rooms; every 3rd FIFO, every 5th sold by the crate. */
async function stockedProducts(n: number) {
  const moves: MoveInput[] = [];
  const out: { id: string; unit: string }[] = [];
  for (let i = 0; i < n; i++) {
    const k = ++seq;
    const fifo = i % 3 === 2;
    const p = await prisma.stockProduct.create({ data: { name: `${TAG} P${k}`, unit: "KG", ...(fifo ? { costingMethod: "fifo", removalStrategy: "fifo" } : {}) } });
    const crate = i % 5 === 4;
    if (crate) await prisma.productPackaging.create({ data: { productId: p.id, uomCode: "CRATE", qtyInBaseUnit: 5 } });
    const intake = await prisma.stockIntake.create({ data: { receiptNumber: `${TAG}-RC${k}`, receivedDate: today, supplierId, productId: p.id, receivedQty: 1, goodQty: 1, warehouseId: "wh_main", locationId: "loc_recv", recordedBy: "test" } });
    for (const [j, loc] of (["loc_cold_1", "loc_cold_2"] as const).entries()) {
      const lot = await prisma.stockLot.create({ data: { productId: p.id, lotNumber: `${TAG}-L${k}-${j}`, receivedDate: today, expiryDate: `2099-0${j + 1}-01` } });
      moves.push({ productId: p.id, warehouseId: "wh_main", locationId: loc, lotId: lot.id, quantity: D(6), kind: "intake", intakeId: intake.id, unitCost: D(10 + j), costSource: "purchase" });
    }
    out.push({ id: p.id, unit: crate ? "CRATE" : "KG" });
  }
  await inTx((tx) => postMovements(tx, moves, { actorId: null, actorName: "test", effectiveDate: today }));
  return out;
}

/** An order of `n` lines (each line picks from both lots of its product), loaded and ready to leave. */
async function loadedOrder(n: number) {
  const products = await stockedProducts(n);
  // 8 KG takes one whole lot and part of the next; 2 CRATE = 10 KG.
  const o = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items: products.map((p) => ({ stock_product_id: p.id, product_name: "", quantity: p.unit === "CRATE" ? 2 : 8, unit: p.unit })) } as never, sales as never);
  await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { preparationStatus: "done", loadingStatus: "done" } });
  await prisma.order.update({ where: { id: o.id }, data: { status: "loaded" } });
  return o.id;
}
const version = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).version;
const ship = { vehicle: "TRK-9", driverName: "سواق", crateCount: 4 };

test("dispatch and reopen: the stock-out and its reversal cost the same at 5 and 50 lines", async () => {
  const counts: Record<string, Record<number, number>> = { dispatch: {}, reverse: {}, reopen: {} };
  for (const n of [5, 50]) {
    const a = await loadedOrder(n);
    const v = await version(a);
    counts.dispatch[n] = (await countQueries(() => moveOrderStatus(a, "dispatched", loader as never, { ...ship, expectedVersion: v }))).queries;
    const issued = await prisma.stockMovement.count({ where: { document: { sourceType: "order", sourceId: a, type: "issue" } } });
    assert.equal(issued, n * 2, "every line picked from both of its lots");
    counts.reopen[n] = (await countQueries(() => reopenOrder(a, "ready_for_loading", sup as never, "اختبار", undefined))).queries;
    assert.equal(await prisma.stockMovement.count({ where: { document: { sourceType: "order", sourceId: a, reversalOfId: { not: null } } } }), n * 2, "every movement reversed");

    // The reversal on its own (lib/inventory/dispatch.ts), on a second dispatched order.
    const b = await loadedOrder(n);
    await moveOrderStatus(b, "dispatched", loader as never, { ...ship, expectedVersion: await version(b) });
    counts.reverse[n] = (await countQueries(() => inTx((tx) => reverseDispatchIssue(tx, b, "اختبار", { id: ids.sara, name: "سارة", role: "SUPERVISOR" } as never)))).queries;
  }
  console.log(`statements: ${JSON.stringify(counts)}`);
  assert.equal(counts.dispatch[50], counts.dispatch[5], `dispatch grows with lines: ${JSON.stringify(counts.dispatch)}`);
  assert.ok(counts.dispatch[50] <= 60, `dispatch: ${counts.dispatch[50]} statements`);
  assert.equal(counts.reverse[50], counts.reverse[5], `reversal grows with lines: ${JSON.stringify(counts.reverse)}`);
  assert.ok(counts.reverse[50] <= 40, `reversal: ${counts.reverse[50]} statements`);
});
