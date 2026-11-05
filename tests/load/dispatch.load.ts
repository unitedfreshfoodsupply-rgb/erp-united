/**
 * Load test: dispatching orders, reopening a dispatched order, and dispatching a trip (PW-1, Nov 2026).
 * Not part of test:e2e; run by hand against a disposable LOCAL database:
 *
 *   setup:   tsx tests/load/dispatch.load.ts setup <out.json> [sizes=5,20,40,60] [tripOrders=5] [tripLines=20]
 *   measure: PRISMA_LOG_QUERIES=1 tsx tests/load/dispatch.load.ts measure <out.json>
 *
 * setup saves, per size, a loaded order of that many lines (each line picks from two lots of its
 * own product; every 3rd product FIFO, every 5th line sold by the crate), plus a loaded trip of
 * <tripOrders> orders of <tripLines> lines. measure (run it with DATABASE_URL pointing at
 * tests/load/pg-latency-proxy.mjs to simulate the production pooler, ?connection_limit=1) times,
 * per order, the dispatch and then the reopen of the dispatched order, and then the trip dispatch,
 * counting the statements each sends. A step that fails prints its error and the run goes on.
 */
import fs from "node:fs";
import { assertTestDatabase } from "../_guard";
assertTestDatabase();

import { prisma } from "@/lib/prisma";
import { inTx } from "@/lib/tx";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { createOrder, moveOrderStatus, reopenOrder } from "@/lib/orders-service";
import { confirmLoaded, createTrip, dispatchTrip, startLoading } from "@/lib/operations/trips";
import { postMovements, type MoveInput } from "@/lib/inventory/ledger";
import { D } from "@/lib/inventory/decimal";
import { todayLocalISO } from "@/lib/localDate";

type Setup = { tag: string; orders: { lines: number; id: string }[]; trip: { id: string; orders: number; lines: number } };

async function users() {
  const ids: Record<string, string> = {};
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ id: ids[username], name, role, permissions: ROLE_PERMISSIONS[role] as string[], source: "manual" as const });
  return { sales: as("mona", "SALES", "منى مبيعات"), loader: as("mostafa", "LOADER", "مصطفى تحميل"), sup: as("sara", "SUPERVISOR", "سارة مشرفة") };
}

async function setup(out: string, sizes: number[], tripOrders: number, tripLines: number) {
  const { sales, sup, loader } = await users();
  const tag = `ZZLOADD${Date.now()}`;
  const today = todayLocalISO();
  const customerId = (await createCustomer({ name: `${tag} Hotel`, name_ar: `${tag} فندق` }, sales as never)).id;
  const supplierId = (await prisma.supplier.create({ data: { code: `SUP-3${String(Date.now()).slice(-7)}`, name: `${tag} Farm` } })).id;
  let k = 0;
  async function loadedOrder(n: number) {
    const moves: MoveInput[] = [];
    const items: { stock_product_id: string; product_name: string; quantity: number; unit: string }[] = [];
    for (let i = 0; i < n; i++) {
      const fifo = ++k % 3 === 0;
      const p = await prisma.stockProduct.create({ data: { name: `${tag} P${k}`, unit: "KG", ...(fifo ? { costingMethod: "fifo", removalStrategy: "fifo" } : {}) } });
      const crate = i % 5 === 4;
      if (crate) await prisma.productPackaging.create({ data: { productId: p.id, uomCode: "CRATE", qtyInBaseUnit: 5 } });
      const intake = await prisma.stockIntake.create({ data: { receiptNumber: `${tag}-RC${k}`, receivedDate: today, supplierId, productId: p.id, receivedQty: 1, goodQty: 1, warehouseId: "wh_main", locationId: "loc_recv", recordedBy: "load" } });
      for (const [j, loc] of (["loc_cold_1", "loc_cold_2"] as const).entries()) {
        const lot = await prisma.stockLot.create({ data: { productId: p.id, lotNumber: `${tag}-L${k}-${j}`, receivedDate: today, expiryDate: `2099-0${j + 1}-01` } });
        moves.push({ productId: p.id, warehouseId: "wh_main", locationId: loc, lotId: lot.id, quantity: D(6), kind: "intake", intakeId: intake.id, unitCost: D(10 + j), costSource: "purchase" });
      }
      items.push({ stock_product_id: p.id, product_name: "", quantity: crate ? 2 : 8, unit: crate ? "CRATE" : "KG" });
    }
    await inTx((tx) => postMovements(tx, moves, { actorId: null, actorName: "load", effectiveDate: today }));
    const o = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: "2099-07-01", items } as never, sales as never);
    for (const i of await prisma.orderItem.findMany({ where: { orderId: o.id } })) {
      await prisma.orderItem.update({ where: { id: i.id }, data: { preparedQuantity: i.requiredQuantity, loadedQuantity: i.requiredQuantity, preparationStatus: "done", loadingStatus: "done" } });
    }
    await prisma.order.update({ where: { id: o.id }, data: { status: "loaded", crateCount: 3 } });
    return o.id;
  }
  const orders = [];
  for (const n of sizes) orders.push({ lines: n, id: await loadedOrder(n) });
  const tripOrderIds = [];
  for (let i = 0; i < tripOrders; i++) tripOrderIds.push(await loadedOrder(tripLines));
  const vehicle = await prisma.vehicle.create({ data: { code: `${tag}-V`, plate: `${tag}-P`, type: "truck" } });
  const driver = await prisma.driver.create({ data: { name: `${tag} سواق` } });
  const trip = await createTrip({ vehicle_id: vehicle.id, driver_id: driver.id, order_ids: tripOrderIds }, sup as never);
  await startLoading(trip.id, loader as never);
  await confirmLoaded(trip.id, loader as never);
  const s: Setup = { tag, orders, trip: { id: trip.id, orders: tripOrders, lines: tripLines } };
  fs.writeFileSync(out, JSON.stringify(s, null, 2));
  console.log(`setup: ${sizes.join(", ")}-line orders and a ${tripOrders}×${tripLines} trip → ${out}`);
}

async function measure(file: string) {
  const s: Setup = JSON.parse(fs.readFileSync(file, "utf8"));
  const { loader, sup } = await users();
  let statements = 0;
  (prisma as unknown as { $on: (e: "query", cb: () => void) => void }).$on("query", () => { statements++; });
  await prisma.user.count(); // connect first
  const timed = async (label: string, fn: () => Promise<unknown>) => {
    const at = statements;
    const t0 = performance.now();
    let result = "ok";
    try {
      await fn();
    } catch (e) {
      result = `FAILED: ${String((e as { code?: string }).code ?? "")} ${String((e as Error).message ?? e).split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 120)}`;
    }
    const row = { label, ms: Math.round(performance.now() - t0), statements: statements - at, result };
    console.log(JSON.stringify(row));
  };
  const version = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).version;
  for (const o of s.orders) {
    await timed(`dispatch, ${o.lines} lines`, async () => moveOrderStatus(o.id, "dispatched", loader as never, { vehicle: "TRK", driverName: "سواق", crateCount: 3, expectedVersion: await version(o.id) }));
    const { status } = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    await timed(`reopen ${status} -> ready_for_loading, ${o.lines} lines`, async () => reopenOrder(o.id, "ready_for_loading", sup as never, "قياس", await version(o.id)));
  }
  await timed(`trip dispatch, ${s.trip.orders} orders × ${s.trip.lines} lines`, () => dispatchTrip(s.trip.id, {}, loader as never));
}

(async () => {
  const [mode, a, b, c, d] = process.argv.slice(2);
  if (mode === "setup") await setup(a, (b ?? "5,20,40,60").split(",").map(Number), Number(c ?? 5), Number(d ?? 20));
  else if (mode === "measure") await measure(a);
  else throw new Error("usage: setup <out.json> [sizes] [tripOrders] [tripLines] | measure <out.json>");
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
