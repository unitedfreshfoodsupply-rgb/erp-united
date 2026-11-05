/**
 * Load test: the awaiting-stock arrival check behind a stock receipt (release gate D-3, Nov 2026).
 * Not part of test:e2e; run by hand against a disposable LOCAL database:
 *
 *   setup:   tsx tests/load/stock-arrival.load.ts setup <held> <out.json>
 *   measure: PRISMA_LOG_QUERIES=1 tsx tests/load/stock-arrival.load.ts measure <out.json> <concurrent>
 *
 * setup saves <held> orders awaiting stock on one new product (one 1 KG line each, via createOrder
 * with allow_shortage) and a control product with none. measure (run it with DATABASE_URL pointing
 * at tests/load/pg-latency-proxy.mjs to simulate a remote database, ?connection_limit=1 like
 * production) times one receipt of the control product, one receipt that covers every held order,
 * then <concurrent> receipts of the held product at once, while a probe times an unrelated read
 * every 100 ms. It then checks every held order was told, once, and nothing was reserved.
 */
import fs from "node:fs";
import { assertTestDatabase } from "../_guard";
assertTestDatabase();

import { prisma } from "@/lib/prisma";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { createOrder } from "@/lib/orders-service";
import { recordIntake } from "@/lib/stock-service";

type Setup = { tag: string; held: number; heldProductId: string; controlProductId: string; supplierId: string; orderIds: string[] };

async function users() {
  const ids: Record<string, string> = {};
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ id: ids[username], name, role, permissions: ROLE_PERMISSIONS[role] as string[], source: "manual" as const });
  return { sales: as("mona", "SALES", "منى مبيعات"), stock: as("hossam", "STOCK_CONTROLLER", "حسام مخازن") };
}

async function setup(held: number, out: string) {
  const { sales } = await users();
  const tag = `ZZLOAD${Date.now()}`;
  const product = async (label: string) => (await prisma.stockProduct.create({ data: { name: `${tag} ${label}`, nameAr: `${tag} ${label}`, unit: "KG" } })).id;
  const heldProductId = await product("held");
  const controlProductId = await product("control");
  const supplierId = (await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${tag} Farm`, category: "vegetable" } })).id;
  const customerId = (await createCustomer({ name: `${tag} Hotel`, name_ar: `${tag} فندق` }, sales as never)).id;
  const orderIds: string[] = [];
  const t0 = Date.now();
  for (let i = 0; i < held; i++) {
    const o = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: "2099-12-01", allow_shortage: true, items: [{ stock_product_id: heldProductId, product_name: "", quantity: 1, unit: "KG" }] } as never, sales as never);
    if (o.stockStatus !== "awaiting_stock") throw new Error(`order ${o.id} not held`);
    orderIds.push(o.id);
  }
  const s: Setup = { tag, held, heldProductId, controlProductId, supplierId, orderIds };
  fs.writeFileSync(out, JSON.stringify(s));
  console.log(JSON.stringify({ setup: { tag, held, seconds: (Date.now() - t0) / 1000 } }));
}

let queries = 0;

async function timed<T>(fn: () => Promise<T>) {
  const q0 = queries;
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ok: true as const, ms: Math.round(performance.now() - t0), queries: queries - q0, value };
  } catch (err) {
    return { ok: false as const, ms: Math.round(performance.now() - t0), queries: queries - q0, error: `${(err as { code?: string }).code ?? ""} ${(err as Error).message}`.slice(0, 300) };
  }
}

async function measure(file: string, concurrent: number) {
  const s: Setup = JSON.parse(fs.readFileSync(file, "utf8"));
  const { stock } = await users();
  (prisma as unknown as { $on: (e: "query", cb: () => void) => void }).$on("query", () => { queries++; });
  const receive = (productId: string, kg: number) => () => recordIntake({ supplier_id: s.supplierId, product_id: productId, received_kg: kg, unit_cost: "5", location_id: "loc_cold_1" } as never, stock as never);

  // An unrelated read every 100 ms: how long other requests wait while receipts run.
  const probe = { samples: 0, maxMs: 0, over1s: 0, failed: 0 };
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const t0 = performance.now();
      try { await prisma.user.count(); } catch { probe.failed++; }
      const ms = performance.now() - t0;
      probe.samples++; probe.maxMs = Math.max(probe.maxMs, Math.round(ms)); if (ms > 1000) probe.over1s++;
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  await prisma.user.count(); // warm the connection
  const control = await timed(receive(s.controlProductId, 5));
  const covering = await timed(receive(s.heldProductId, s.held));
  const t0 = performance.now();
  const q0 = queries;
  const burst = await Promise.all(Array.from({ length: concurrent }, () => timed(receive(s.heldProductId, 1))));
  const burstMs = Math.round(performance.now() - t0);
  const burstQueries = queries - q0;
  probing = false;
  await prober;

  const told = await prisma.notification.groupBy({ by: ["entityId"], where: { entityType: "order", entityId: { in: s.orderIds }, type: "order.stock_ready" }, _count: { _all: true } });
  const dup = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM (SELECT "recipientId", "dedupeKey" FROM "Notification" WHERE "entityType" = 'order' AND "entityId" = ANY(${s.orderIds}) AND "dedupeKey" IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d`;
  const reserved = await prisma.stockReservation.count({ where: { sourceType: "order", sourceId: { in: s.orderIds }, status: "active" } });
  const stillHeld = await prisma.order.count({ where: { id: { in: s.orderIds }, stockStatus: "awaiting_stock", status: "new" } });
  const openSuggestions = await prisma.purchaseRequest.groupBy({ by: ["orderItemId"], where: { orderId: { in: s.orderIds }, status: { in: ["pending_approval", "approved"] } }, _count: { _all: true } });

  const strip = <T extends { value?: unknown }>(r: T) => { const { value: _v, ...rest } = r; return rest; };
  console.log(JSON.stringify({
    held: s.held,
    concurrent,
    controlReceipt: strip(control),
    coveringReceipt: strip(covering),
    burst: { wallMs: burstMs, ok: burst.filter((b) => b.ok).length, failed: burst.filter((b) => !b.ok).map((b) => b.error), msEach: burst.map((b) => b.ms), queries: burstQueries },
    probe,
    checks: {
      ordersTold: told.length,
      ordersNotTold: s.held - told.length,
      duplicateNotifications: Number(dup[0]?.n ?? 0),
      reservations: reserved,
      stillHeld,
      linesWithMoreThanOneOpenSuggestion: openSuggestions.filter((g) => g._count._all > 1).length,
    },
  }));
}

const [mode, a, b] = process.argv.slice(2);
(mode === "setup" ? setup(Number(a), b) : mode === "measure" ? measure(a, Number(b ?? 1)) : Promise.reject(new Error("mode: setup | measure")))
  .then(() => prisma.$disconnect())
  .catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
