/* Desk lists and dashboards without per-row queries (PS-5..PS-10, PM-9, Nov 2026). Each read path
   below used to run one or more queries per row (per purchase order, per customer order, per
   product, per receipt) or one query per figure, one after another on the single pooled
   connection. Each must return exactly what the per-row path returns — checked here against the
   per-row functions that are still in use (getPurchaseOrder, orderValue, sellableNow,
   effectiveSupplierPrice, the Prisma reads of the old dashboards) — in a number of statements that
   does not grow with the rows. Synthetic data on the test database. */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, actor, withSetting } from "./_db";
import { ROLE_PERMISSIONS, ALL_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { recordIntake, shiftDate as addDays, stockDashboard } from "@/lib/stock-service";
import { createPurchaseOrder, getPurchaseOrder, listPurchaseOrders, submitPurchaseOrder } from "@/lib/purchasing/orders";
import { listPurchaseRequests } from "@/lib/purchasing/requests";
import { billableReceipts } from "@/lib/purchasing/bills";
import { effectiveSupplierPrice } from "@/lib/purchasing/suppliers";
import { sellableNow } from "@/lib/sales/stock-commitment";
import { orderValue } from "@/lib/sales/pricing";
import { profileSection } from "@/lib/profiles/service";
import { myNotifications } from "@/lib/core/notifications";
import { homeSummary } from "@/lib/home/summary";
import { OPEN_STATUSES } from "@/lib/orderPresentation";
import { APPROVAL_TYPES, type ApprovalType } from "@/lib/core/approvals";
import { todayLocalISO } from "@/lib/localDate";

const TAG = `ZZREAD${Date.now()}`;
const today = todayLocalISO();
const ids: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role] as string[], ids[username], role), source: "manual" as const });
let buyer: ReturnType<typeof as>, stock: ReturnType<typeof as>, sales: ReturnType<typeof as>;
let supplierId = "", customerId = "";
let restoreThreshold: () => Promise<void> = async () => {};
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Prisma.Decimal) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const same = (a: unknown, b: unknown, msg?: string) => assert.deepEqual(JSON.parse(JSON.stringify(canon(a))), JSON.parse(JSON.stringify(canon(b))), msg);
const product = async (label: string) => (await prisma.stockProduct.create({ data: { name: `${TAG} ${label}`, nameAr: `${TAG} ${label}`, unit: "KG" } })).id;
const receive = (productId: string, kg: number, extra: Record<string, unknown> = {}) =>
  recordIntake({ supplier_id: supplierId, product_id: productId, received_kg: kg, location_id: "loc_cold_1", ...extra } as never, stock as never);
const allCan = () => true;

before(async () => {
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  buyer = as("omar", "PURCHASER", "عمر مشتريات");
  stock = as("hossam", "STOCK_CONTROLLER", "حسام مخازن");
  sales = as("mona", "SALES", "منى مبيعات");
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-7${String(Date.now()).slice(-7)}`, name: `${TAG} Farm`, category: "vegetable" } })).id;
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;
  restoreThreshold = await withSetting("purchasing.po_approval_threshold", 1000000);
});
after(async () => {
  await restoreThreshold();
  await prisma.$disconnect();
});

test("purchase-order list (PS-6): each row is getPurchaseOrder's, in a fixed number of statements", async () => {
  const p = await product("طماطم");
  const po = async (kg: number) => {
    const created = await createPurchaseOrder({ supplier_id: supplierId, lines: [{ product_id: p, quantity: kg, unit_price: "7" }, { product_id: p, quantity: 1, unit_price: "7" }] }, buyer as never);
    await submitPurchaseOrder(created.id, buyer as never);
    return created.id;
  };
  const first = await po(10);
  const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { poId: first }, orderBy: { lineNo: "asc" } });
  await recordIntake({ purchase_order_line_id: line.id, received_kg: 6, rejected_kg: 1, rejection_reason: TAG, location_id: "loc_cold_1" } as never, stock as never);
  const cost = async () => (await countQueries(() => listPurchaseOrders({ supplierId }, { permissions: ROLE_PERMISSIONS.PURCHASER as string[] }))).queries;
  const before = await cost();
  for (const kg of [3, 4, 5]) await po(kg);
  assert.equal(await cost(), before, "three more purchase orders, no more statements");
  for (const viewer of [{ permissions: ROLE_PERMISSIONS.PURCHASER as string[] }, { permissions: ROLE_PERMISSIONS.STOCK_CONTROLLER as string[] }]) {
    const listed = await listPurchaseOrders({ supplierId }, viewer);
    assert.equal(listed.length, 4);
    for (const row of listed) same(row, await getPurchaseOrder(row.id, viewer), `PO ${row.number} as in its detail`);
  }
  const received = (await listPurchaseOrders({ supplierId }, { permissions: ROLE_PERMISSIONS.PURCHASER as string[] })).find((x) => x.id === first)!;
  assert.deepEqual([received.lines[0].receivedGood, received.lines[0].rejected, received.lines[0].remaining], ["5", "1", "5"]);
});

test("customer profile orders (PS-7): each order's value is orderValue's, one price query for all", async () => {
  const items = (k: number) => Array.from({ length: k }, (_, i) => ({ productName: `${TAG} صنف ${i}`, unit: "KG", requiredQuantity: 10 + i, preparedQuantity: i % 2 ? 9.5 : null, loadedQuantity: i % 3 ? null : 8.25 }));
  const make = async (k: number, priced: number) => {
    const o = await prisma.order.create({ data: { orderNumber: `${TAG}-${Math.random().toString(36).slice(2, 8)}`, customerName: TAG, customerAccountId: customerId, deliveryDate: today, items: { create: items(k) } }, include: { items: true } });
    for (const [i, it] of o.items.slice(0, priced).entries()) {
      await prisma.orderItemPrice.create({ data: { orderItemId: it.id, unitPrice: `${12.3456 + i}`, discountPct: i % 2 ? "7.5" : "0", taxCode: i % 2 ? "T1" : "EX", taxRate: i % 2 ? "14" : "0", source: "manual", reason: TAG, setBy: TAG } });
    }
    return o.id;
  };
  await make(3, 3);
  await make(4, 2); // two lines without a price count as nothing
  await make(2, 0);
  const section = (w = { limit: 50 }) => profileSection("customer", customerId, "orders", allCan, w) as Promise<{ rows: { id: string; amount: string | null }[] }>;
  const { result, queries } = await countQueries(() => section());
  for (const row of result.rows) assert.equal(row.amount, (await orderValue(prisma, row.id)).total.toFixed(2), "orderValue's total");
  await make(5, 5);
  await make(1, 1);
  assert.equal((await countQueries(() => section())).queries, queries, "two more orders, no more statements");
  const unpriced = await profileSection("customer", customerId, "orders", (p) => p !== "sales.pricing.view", { limit: 50 }) as { rows: { amount: string | null }[] };
  assert.ok(unpriced.rows.length === 5 && unpriced.rows.every((r) => r.amount === null), "no amounts without sales.pricing.view");
});

test("purchase-request list (PS-8): what is sellable now, as sellableNow says, for all products at once", async () => {
  const products = [await product("خيار"), await product("بطاطس"), await product("بصل")];
  await receive(products[0], 40, { unit_cost: "5" });
  await receive(products[1], 12, { unit_cost: "5" });
  const po = await createPurchaseOrder({ supplier_id: supplierId, lines: products.map((p) => ({ product_id: p, quantity: 5, unit_price: "3" })) }, buyer as never);
  const lines = await prisma.purchaseOrderLine.findMany({ where: { poId: po.id } });
  for (const [i, p] of products.entries()) {
    const line = lines.find((l) => l.productId === p)!;
    await prisma.purchaseRequest.create({ data: { number: `${TAG}-PR-${i}`, status: "ordered", productId: p, uomCode: "KG", quantity: 5, requestedBy: TAG, decidedBy: TAG, decidedAt: new Date(), customerReference: TAG, purchaseOrderId: po.id, purchaseOrderLineId: line.id } });
  }
  await prisma.purchaseRequest.create({ data: { number: `${TAG}-PR-x`, status: "pending_approval", productId: products[2], uomCode: "KG", quantity: 5, requestedBy: TAG, customerReference: TAG } });
  const viewer = { ...buyer, permissions: ROLE_PERMISSIONS.PURCHASER as string[] };
  const { result, queries } = await countQueries(() => listPurchaseRequests({ q: TAG }, viewer as never));
  const mine = result.items.filter((r) => r.customerReference === TAG);
  assert.equal(mine.length, 4);
  // Every row of a product with an ordered request carries it (as before), the others none.
  const ordered = new Set(result.items.filter((r) => r.status === "ordered").map((r) => r.productId));
  for (const r of result.items) {
    assert.equal(r.availableNow, ordered.has(r.productId) ? (await sellableNow(prisma, r.productId)).available.toFixed() : null, `${r.number}`);
  }
  // Two more products with ordered requests: no more statements.
  const more = [await product("فلفل"), await product("خس")];
  for (const p of more) await receive(p, 7, { unit_cost: "5" });
  const po2 = await createPurchaseOrder({ supplier_id: supplierId, lines: more.map((p) => ({ product_id: p, quantity: 5, unit_price: "3" })) }, buyer as never);
  for (const [i, line] of (await prisma.purchaseOrderLine.findMany({ where: { poId: po2.id } })).entries()) {
    await prisma.purchaseRequest.create({ data: { number: `${TAG}-PR-m${i}`, status: "ordered", productId: line.productId, uomCode: "KG", quantity: 5, requestedBy: TAG, decidedBy: TAG, decidedAt: new Date(), customerReference: TAG, purchaseOrderId: po2.id, purchaseOrderLineId: line.id } });
  }
  const again = await countQueries(() => listPurchaseRequests({ q: TAG }, viewer as never));
  assert.equal(again.result.items.filter((r) => r.status === "ordered").length, 5);
  assert.equal(again.queries, queries, "five products instead of three, the same statements");
  const lone = await prisma.purchaseRequest.create({ data: { number: `${TAG}-PR-y`, status: "pending_approval", productId: await product("ليمون"), uomCode: "KG", quantity: 1, requestedBy: TAG, customerReference: TAG } });
  assert.equal((await listPurchaseRequests({ q: TAG }, viewer as never)).items.find((r) => r.id === lone.id)?.availableNow, null);
  assert.deepEqual(mine.filter((r) => r.status === "ordered").map((r) => r.availableNow).sort(), ["0", "12", "40"]);
});

test("billable receipts (PS-9): each receipt's agreed price as effectiveSupplierPrice gives it, prices read once", async () => {
  const p = await product("مانجو"), q = await product("جوافة");
  const d = (k: number) => addDays(today, -k);
  for (const [prod, from, to, price] of [[p, d(30), d(6), "20"], [p, d(5), null, "22.5"], [q, d(30), null, "9"]] as const) {
    await prisma.supplierPrice.create({ data: { supplierId, productId: prod, uomCode: "KG", unitPrice: price, validFrom: from, validTo: to, createdBy: TAG } });
  }
  await receive(p, 10, { received_date: d(7) });
  await receive(p, 10, { received_date: d(2), unit_cost: "22.5" });
  await receive(q, 5, { received_date: d(1), unit_cost: "8" });
  const cost = async () => (await countQueries(() => billableReceipts(supplierId))).queries;
  const before = await cost();
  await receive(p, 3, { received_date: d(3) });
  await receive(q, 4);
  assert.equal(await cost(), before, "two more receipts, no more statements");
  const rows = await billableReceipts(supplierId);
  const intakes = await prisma.stockIntake.findMany({ where: { id: { in: rows.map((r) => r.intakeId) } }, include: { product: true } });
  for (const r of rows) {
    const i = intakes.find((x) => x.id === r.intakeId)!;
    if (i.purchaseOrderLineId || i.costProvisional) continue;
    const sp = await effectiveSupplierPrice(prisma, { supplierId, product: i.product, uom: i.product.unit, date: i.receivedDate });
    const expected = i.unitCost != null
      ? { price: D(i.unitCost).toString(), source: sp && D(sp.unitPrice).equals(i.unitCost) ? "supplier_price" : "receipt" }
      : sp ? { price: D(sp.unitPrice).toString(), source: "supplier_price" } : { price: null, source: null };
    assert.deepEqual({ price: r.expectedUnitPrice, source: r.priceSource }, expected, `receipt ${r.receiptNumber}`);
  }
});

test("the bell (PS-10): the newest notifications and the unread count in one statement, rows as Prisma returns them", async () => {
  const user = ids.karim;
  const base = Date.now();
  for (let i = 0; i < 7; i++) {
    await prisma.notification.create({ data: { recipientId: user, type: "test.read_paths", title: `${TAG} ${i}`, body: i % 2 ? null : "نص", link: i % 3 ? `/x/${i}` : null, dedupeKey: `${TAG}-${i}`, readAt: i < 3 ? new Date(base - i * 1000) : null, createdAt: new Date(base - i * 60_000) } });
  }
  for (const opts of [{ limit: 20 }, { limit: 2 }, { unreadOnly: true, limit: 5 }, {}, { limit: 1000 }, { limit: -4 }]) {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const expected = {
      items: await prisma.notification.findMany({ where: { recipientId: user, ...("unreadOnly" in opts ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: limit }),
      unread: await prisma.notification.count({ where: { recipientId: user, readAt: null } }),
    };
    const { result, queries } = await countQueries(() => myNotifications(user, opts));
    assert.equal(queries, 1);
    assert.deepEqual(result, expected, JSON.stringify(opts));
  }
  assert.deepEqual(Object.keys((await myNotifications(user, { limit: 1 })).items[0]), Object.values(Prisma.NotificationScalarFieldEnum), "every column of the model, in its order");
  assert.deepEqual(await myNotifications("nobody"), { items: [], unread: 0 });
});

test("home dashboard (PM-9): every figure as the separate queries gave it, in one statement besides the agings", async () => {
  const viewers = [
    { id: ids.admin, permissions: new Set<string>(ALL_PERMISSIONS) },
    { id: ids.karim, permissions: new Set<string>(ROLE_PERMISSIONS.ACCOUNTANT) },
    { id: ids.sara, permissions: new Set<string>(ROLE_PERMISSIONS.SUPERVISOR) },
    { id: ids.hossam, permissions: new Set<string>(ROLE_PERMISSIONS.STOCK_CONTROLLER) },
  ];
  for (const v of viewers) {
    const got = await homeSummary(v);
    const can = (...p: string[]) => p.some((x) => v.permissions.has(x));
    const count = (key: string) => got.actions.find((a) => a.key === key)?.count ?? 0;
    const decidable = (Object.keys(APPROVAL_TYPES) as ApprovalType[]).filter((t) => v.permissions.has(APPROVAL_TYPES[t].approvePermission));
    if (decidable.length) assert.equal(count("approvals"), await prisma.approvalRequest.count({ where: { status: "pending", type: { in: decidable }, NOT: { requestedById: v.id } } }));
    if (can("sales.invoices.manage")) assert.equal(count("draft-invoices"), await prisma.salesInvoice.count({ where: { status: "draft" } }));
    if (can("purchasing.bills.manage")) assert.equal(count("draft-bills"), await prisma.supplierBill.count({ where: { status: "draft" } }));
    if (can("orders.approve")) assert.equal(count("orders-review"), await prisma.order.count({ where: { status: { in: OPEN_STATUSES }, needsReview: true } }));
    if (can("orders.view", "reports.view")) {
      const rows = await prisma.order.groupBy({ by: ["status"], where: { status: { in: OPEN_STATUSES } }, _count: { _all: true } });
      same(got.operations, {
        byStatus: Object.fromEntries(rows.map((r) => [r.status, r._count._all])), open: rows.reduce((s, r) => s + r._count._all, 0),
        late: await prisma.order.count({ where: { status: { in: OPEN_STATUSES }, deliveryDate: { lt: today } } }),
        dispatchedToday: (await prisma.inventoryDocument.findMany({ where: { type: "issue", status: "posted", businessDate: today, sourceType: "order" }, select: { sourceId: true }, distinct: ["sourceId"] })).length,
      });
    } else assert.equal(got.operations, undefined);
    if (can("stock.view")) {
      const kg = (await prisma.stockIntake.aggregate({ where: { status: "posted", receivedDate: today, product: { unit: "KG" } }, _sum: { receivedQty: true, goodQty: true, gradeBQty: true, wasteQty: true, rejectedQty: true } }))._sum;
      assert.deepEqual({ ...got.stock, lowStock: 0 }, {
        receiptsToday: await prisma.stockIntake.count({ where: { status: "posted", receivedDate: today } }), receivedTodayKg: D(kg.receivedQty).toFixed(0),
        activeProducts: await prisma.stockProduct.count({ where: { active: true } }),
        gradedToday: { good: D(kg.goodQty).toFixed(1), gradeB: D(kg.gradeBQty).toFixed(1), waste: D(kg.wasteQty).toFixed(1), rejected: D(kg.rejectedQty).toFixed(1) },
        lowStock: 0, openExceptions: await prisma.stockIssueException.count({ where: { status: "open" } }),
      });
    } else assert.equal(got.stock, undefined);
    if (can("purchasing.requests.view")) assert.deepEqual(got.purchaseRequests, { open: await prisma.purchaseRequest.count({ where: { status: { in: ["pending_approval", "approved"] } } }) });
    if (can("reports.finance")) {
      const cash = await prisma.$queryRaw<{ type: string; b: Prisma.Decimal | null }[]>`
        SELECT c."type", sum(l."debit" - l."credit") AS b FROM "CashAccount" c JOIN "JournalLine" l ON l."accountId" = c."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId"
        WHERE c."active" AND e."date" <= ${today} GROUP BY c."type"`;
      const of = (t: string) => D(cash.find((r) => r.type === t)?.b ?? 0);
      assert.deepEqual(got.cash, { cash: of("cash").toFixed(2), bank: of("bank").toFixed(2), total: of("cash").plus(of("bank")).toFixed(2) });
      assert.ok(got.sales && got.receivables && got.payables);
    } else assert.equal(got.sales, undefined);
  }
  const stockOnly = await countQueries(() => homeSummary({ id: ids.hossam, permissions: new Set<string>(ROLE_PERMISSIONS.STOCK_CONTROLLER) }));
  assert.equal(stockOnly.queries, 1, "a viewer without the finance sections: one statement");
});

test("customer and supplier summaries (PM-9): the same counts and sums from one statement each", async () => {
  const cust = await profileSection("customer", customerId, "summary", allCan, { limit: 50 }) as Record<string, unknown>;
  const year = `${today.slice(0, 4)}-01-01`;
  const [inv, invYear, cn, cnYear, rc] = await Promise.all([
    prisma.salesInvoice.aggregate({ where: { customerId, status: "issued" }, _sum: { net: true } }),
    prisma.salesInvoice.aggregate({ where: { customerId, status: "issued", issueDate: { gte: year } }, _sum: { net: true } }),
    prisma.creditNote.aggregate({ where: { customerId }, _sum: { net: true } }),
    prisma.creditNote.aggregate({ where: { customerId, issueDate: { gte: year } }, _sum: { net: true } }),
    prisma.customerReceipt.aggregate({ where: { customerId, reversal: { is: null } }, _sum: { amount: true } }),
  ]);
  const last = await prisma.order.findFirst({ where: { customerAccountId: customerId, status: { not: "cancelled" } }, orderBy: [{ deliveryDate: "desc" }], select: { deliveryDate: true } });
  assert.deepEqual({ ...cust, receivable: null }, {
    orders: await prisma.order.count({ where: { customerAccountId: customerId } }),
    openOrders: await prisma.order.count({ where: { customerAccountId: customerId, status: { notIn: ["dispatched", "cancelled"] } } }),
    lastOrderDate: last?.deliveryDate ?? null, receivable: null,
    netSales: D(inv._sum.net).minus(D(cn._sum.net)).toFixed(2), netSalesThisYear: D(invYear._sum.net).minus(D(cnYear._sum.net)).toFixed(2),
    received: D(rc._sum.amount).toFixed(2), lastReceiptDate: null, paymentTermsDays: 0, creditLimit: null, creditHold: false,
  });
  const limited = await profileSection("customer", customerId, "summary", (p) => p === "orders.view" || p === "sales.customers.view", { limit: 50 });
  assert.deepEqual(Object.keys(limited), ["orders", "openOrders", "lastOrderDate"], "only what the viewer may see");

  const sup = await profileSection("supplier", supplierId, "summary", allCan, { limit: 50 }) as Record<string, unknown>;
  const lastReceipt = await prisma.stockIntake.findFirst({ where: { supplierId, status: "posted" }, orderBy: [{ receivedDate: "desc" }], select: { receivedDate: true } });
  assert.deepEqual({ receipts: sup.receipts, lastReceiptDate: sup.lastReceiptDate, unbilledReceipts: sup.unbilledReceipts, purchaseOrders: sup.purchaseOrders, openPurchaseOrders: sup.openPurchaseOrders }, {
    receipts: await prisma.stockIntake.count({ where: { supplierId, status: "posted" } }), lastReceiptDate: lastReceipt?.receivedDate ?? null,
    unbilledReceipts: await prisma.stockIntake.count({ where: { supplierId, status: "posted", billLines: { none: { bill: { status: { in: ["draft", "pending_approval", "approved", "posted"] } } } } } }),
    purchaseOrders: await prisma.purchaseOrder.count({ where: { supplierId } }), openPurchaseOrders: await prisma.purchaseOrder.count({ where: { supplierId, status: { in: ["approved", "sent", "partially_received"] } } }),
  });
  assert.ok((sup.receipts as number) > 0 && (sup.purchaseOrders as number) > 0, "the earlier tests gave this supplier receipts and orders");
  await assert.rejects(profileSection("customer", "nope", "summary", allCan, { limit: 50 }), /مش موجود/);
});

test("stock dashboard (PS-5): no receipt list, and the period totals as one aggregate per window gives them", async () => {
  const dash = await stockDashboard(today);
  assert.equal("todayIntakes" in dash, false);
  const windows = [[dash.today, today], [dash.week, addDays(today, -6)], [dash.month, `${today.slice(0, 7)}-01`]] as const;
  for (const [got, from] of windows) {
    const agg = await prisma.stockIntake.aggregate({ where: { status: "posted", receivedDate: { gte: from, lte: today } }, _sum: { receivedQty: true, rejectedQty: true, goodQty: true, crateCount: true }, _count: { _all: true } });
    const num = (v: Prisma.Decimal | null) => (v == null ? 0 : Number(v.toFixed(3)));
    assert.deepEqual({ from: got.from, to: got.to, receivedKg: got.receivedKg, rejectedKg: got.rejectedKg, goodKg: got.goodKg, crates: got.crates, intakeCount: got.intakeCount }, {
      from, to: today, receivedKg: num(agg._sum.receivedQty), rejectedKg: num(agg._sum.rejectedQty), goodKg: num(agg._sum.goodQty), crates: agg._sum.crateCount ?? 0, intakeCount: agg._count._all,
    });
  }
});
