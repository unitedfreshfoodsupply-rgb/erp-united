/* Releasing the purchase requests of a cancelled or closed PO (Nov 2026): each request was locked,
   counted, updated and audited one by one inside the PO's transaction (4–5 statements each). They
   are now locked in the same sequence in one statement and released in a fixed number of
   statements — the same statuses, versions and audit rows. (Each order's suggestion re-size that
   follows is unchanged; these requests serve no order.) */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma, type PurchaseOrder } from "@prisma/client";
import { prisma, inTx, actor, withSetting } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { advisoryXactLock } from "@/lib/dbLock";
import { writeAudit } from "@/lib/audit";
import { ApiError } from "@/lib/rbac";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { createCustomer } from "@/lib/sales/customers";
import { createOrder } from "@/lib/orders-service";
import { recordIntake } from "@/lib/stock-service";
import { syncOrderSuggestions } from "@/lib/purchasing/requests";
import { syncPoCoverageByOrder } from "@/lib/purchasing/receiving";
import { createPurchaseOrder, releasePoCoverage, submitPurchaseOrder } from "@/lib/purchasing/orders";

const TAG = `ZZPOR${Date.now()}`;
const today = todayLocalISO();
const buyer = actor("مشتريات", ["purchasing.orders.manage", "purchasing.prices.manage"], null, "BUYER");
let restore: (() => Promise<void>) | undefined;
let supplierId = "";
const products: string[] = [];

const users: Record<string, string> = {};
const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role], users[username], role), source: "manual" as const, permissions: ROLE_PERMISSIONS[role] as string[] });
let customerId = "";
const day = `2099-10-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;

before(async () => {
  restore = await withSetting("purchasing.po_approval_threshold", 100000000);
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-5${String(Date.now()).slice(-6)}1`, name: `${TAG} مورد`, category: "vegetable", paymentTermsDays: 0 } })).id;
  for (let i = 0; i < 40; i++) products.push((await prisma.stockProduct.create({ data: { name: `${TAG} صنف ${i}`, unit: "KG" } })).id);
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) users[u.username] = u.id;
  customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, as("mona", "SALES", "منى مبيعات") as never)).id;
});
after(async () => { await restore?.(); await prisma.$disconnect(); });

class Rollback extends Error {}
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  await assert.rejects(inTx(async (tx) => { await fn(tx); throw new Rollback(); }), (e) => { if (e instanceof Rollback) return true; throw e; });
}

test("a PO's requests are released in a fixed number of statements: 5 vs 40", async () => {
  async function measure(n: number) {
    const po = await createPurchaseOrder({ supplier_id: supplierId, lines: products.slice(0, n).map((p) => ({ product_id: p, quantity: 5, unit_price: "3" })) }, buyer as never);
    const lines = await prisma.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { lineNo: "asc" } });
    let queries = 0;
    await rolledBack(async (tx) => {
      for (const l of lines) {
        await tx.purchaseRequest.create({ data: { number: await nextDocumentNumber(tx, "purchasing.request", today), productId: l.productId, uomCode: "KG", quantity: 5, status: "ordered", purchaseOrderId: po.id, purchaseOrderLineId: l.id, requestedBy: "test", decidedBy: "approver", decidedAt: new Date() } });
      }
      const fresh = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
      queries = (await countQueries(() => releasePoCoverage(tx, fresh, "cancelled", `${TAG} المورد اعتذر`, buyer))).queries;
      const rows = await tx.purchaseRequest.findMany({ where: { productId: { in: lines.map((l) => l.productId) }, requestedBy: "test" } });
      assert.equal(rows.length, n);
      assert.ok(rows.every((r) => r.status === "approved" && r.purchaseOrderId === null && r.purchaseOrderLineId === null && r.version === 2), "every request back to approved, unlinked, one version up");
      const audits = await tx.auditLog.findMany({ where: { entityType: "purchase_request", entityId: { in: rows.map((r) => r.id) } } });
      assert.equal(audits.length, n);
      assert.ok(audits.every((a) => a.action === "purchase_request_reopened" && a.reason === `${TAG} المورد اعتذر` && a.newValue?.endsWith(`approved · ${fresh.number}`)));
    });
    return queries;
  }
  const small = await measure(5), large = await measure(40);
  assert.equal(large, small, `5 requests ${small}, 40 requests ${large}`);
});

/* ---------------------------------------------------------------------------------------------
   The one-by-one loop releasePoCoverage replaced (quality/perf-ux-2026-11, lib/purchasing/orders.ts),
   copied verbatim apart from receivedSoFar (private there) inlined, to compare the outcome. */
async function releaseOneByOne(tx: Tx, po: PurchaseOrder, how: "cancelled" | "closed", reason: string, actor: { id: string | null; name: string; role: string; deviceId?: string }, opts: { noteKept?: boolean } = {}) {
  const D = (x: Prisma.Decimal.Value) => new Prisma.Decimal(x);
  const receivedSoFar = async (db: Pick<Tx, "stockIntake">, poId: string) => {
    const rows = await db.stockIntake.groupBy({ by: ["purchaseOrderLineId"], where: { status: "posted", purchaseOrderLine: { poId } }, _sum: { goodQty: true, rejectedQty: true, receivedQty: true } });
    return new Map(rows.map((r) => [r.purchaseOrderLineId!, { accepted: D(r._sum.receivedQty ?? 0).minus(D(r._sum.rejectedQty ?? 0)) }]));
  };
  const rows = await tx.purchaseRequest.findMany({ where: { purchaseOrderId: po.id, status: "ordered" }, orderBy: { createdAt: "asc" } });
  const got = rows.length ? await receivedSoFar(tx, po.id) : new Map<string, { accepted: Prisma.Decimal }>();
  const resync = new Set<string>();
  for (const r of rows) {
    await advisoryXactLock(tx, `purchasing:request:${r.id}`);
    if (r.orderId && r.orderItemId) await advisoryXactLock(tx, `purchasing:order-suggestions:${r.orderId}`);
    const accepted = (r.purchaseOrderLineId ? got.get(r.purchaseOrderLineId)?.accepted : undefined) ?? D(0);
    if (accepted.gt(0)) {
      if (opts.noteKept !== false) await writeAudit({
        userId: actor.id, userName: actor.name, role: actor.role,
        action: "purchase_request_po_closed",
        entityType: "purchase_request", entityId: r.id, orderId: r.orderId,
        fieldChanged: "purchaseOrder", oldValue: po.number, newValue: `${r.number} · ${po.number} اتقفل بعد استلام ${accepted.toFixed()} من ${r.quantity.toFixed()} ${r.uomCode}`,
        reason, source: "user", deviceId: actor.deviceId,
      }, tx);
      if (r.orderId && r.orderItemId) resync.add(r.orderId);
      continue;
    }
    const otherOpen = r.orderItemId
      ? await tx.purchaseRequest.count({ where: { orderItemId: r.orderItemId, id: { not: r.id }, status: { in: ["pending_approval", "approved"] } } })
      : 0;
    const data = otherOpen
      ? { status: "cancelled", cancelReason: `أمر الشراء ${po.number} ${how === "closed" ? "اتقفل" : "اتلغى"}: ${reason}`, purchaseOrderId: null, purchaseOrderLineId: null }
      : { status: "approved", purchaseOrderId: null, purchaseOrderLineId: null };
    const res = await tx.purchaseRequest.updateMany({ where: { id: r.id, version: r.version, status: "ordered" }, data: { ...data, version: { increment: 1 } } });
    if (res.count !== 1) throw new ApiError(409, "طلب الشراء اتغيّر، حدّث الشاشة");
    await writeAudit({
      userId: actor.id, userName: actor.name, role: actor.role,
      action: otherOpen ? "purchase_request_cancelled" : "purchase_request_reopened",
      entityType: "purchase_request", entityId: r.id, orderId: r.orderId,
      fieldChanged: "status", oldValue: "ordered", newValue: `${r.number} · ${otherOpen ? "cancelled" : "approved"} · ${po.number}`,
      reason, source: "user", deviceId: actor.deviceId,
    }, tx);
    if (r.orderId && r.orderItemId) resync.add(r.orderId);
  }
  if (resync.size) {
    for (const orderId of resync) await syncOrderSuggestions(tx, orderId, actor, { forOrder: true });
  }
}

const heldOrder = (productIds: string[]) =>
  createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, allow_shortage: true, items: productIds.map((p) => ({ stock_product_id: p, product_name: "", quantity: 10, unit: "KG" })) } as never, as("mona", "SALES", "منى مبيعات") as never);

test("releasing a PO's requests: the same statuses, versions, audit rows and re-sized suggestions as one by one — two requests of the PO on one order line, a line with another open request, a received line", async () => {
  const purchaser = as("omar", "PURCHASER", "عمر مشتريات");
  const pA = (await prisma.stockProduct.create({ data: { name: `${TAG} أ`, nameAr: `${TAG} أ`, unit: "KG" } })).id;
  const pB = (await prisma.stockProduct.create({ data: { name: `${TAG} ب`, nameAr: `${TAG} ب`, unit: "KG" } })).id;
  const pC = (await prisma.stockProduct.create({ data: { name: `${TAG} ج`, nameAr: `${TAG} ج`, unit: "KG" } })).id;
  const order = await heldOrder([pA, pB]);
  const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
  const itemA = items.find((i) => i.stockProductId === pA)!, itemB = items.find((i) => i.stockProductId === pB)!;
  const auto = await prisma.purchaseRequest.findMany({ where: { orderId: order.id, orderItemId: { not: null } } });
  const autoA = auto.find((r) => r.orderItemId === itemA.id)!;
  assert.ok(autoA && auto.some((r) => r.orderItemId === itemB.id && r.status === "pending_approval"), "the held order raised a suggestion per line");
  const po = await createPurchaseOrder({ supplier_id: supplierId, lines: [{ product_id: pA, quantity: 5, unit_price: "3" }, { product_id: pA, quantity: 5, unit_price: "3" }, { product_id: pB, quantity: 10, unit_price: "3" }, { product_id: pC, quantity: 4, unit_price: "3" }] }, purchaser as never);
  await submitPurchaseOrder(po.id, purchaser as never);
  const [L1, L2, L3, L4] = await prisma.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { lineNo: "asc" } });
  await recordIntake({ purchase_order_line_id: L4.id, received_kg: 3, location_id: "loc_cold_1" } as never, as("hossam", "STOCK_CONTROLLER", "حسام مخازن") as never);
  const reason = `${TAG} المورد مش هيكمّل`;

  async function run(release: typeof releaseOneByOne) {
    type Snap = { requests: unknown[]; audits: unknown[]; version: number };
    let snap: Snap | undefined;
    await rolledBack(async (tx) => {
      // Line A: its own suggestion on L1 and a second request on L2 (the first reopens, the second is cancelled).
      await tx.purchaseRequest.update({ where: { id: autoA.id }, data: { status: "ordered", purchaseOrderId: po.id, purchaseOrderLineId: L1.id, notes: "A1", decidedBy: "approver", decidedAt: new Date() } });
      const base = { uomCode: "KG", requestedBy: "test", decidedBy: "approver", decidedAt: new Date(), status: "ordered", purchaseOrderId: po.id };
      await tx.purchaseRequest.create({ data: { ...base, number: `${TAG}-A2`, notes: "A2", productId: pA, quantity: 5, orderId: order.id, orderItemId: itemA.id, customerId, purchaseOrderLineId: L2.id } });
      // Line B: its suggestion stays open, so the PO's request on it is cancelled.
      await tx.purchaseRequest.create({ data: { ...base, number: `${TAG}-B`, notes: "B", productId: pB, quantity: 10, orderId: order.id, orderItemId: itemB.id, customerId, purchaseOrderLineId: L3.id } });
      // A manual request on a line that was partly received: kept on the PO, noted.
      await tx.purchaseRequest.create({ data: { ...base, number: `${TAG}-C`, notes: "C", productId: pC, quantity: 4, purchaseOrderLineId: L4.id } });
      const watched = { OR: [{ orderId: order.id }, { productId: pC, requestedBy: "test" }] };
      const auditWhere = (ids: string[]) => ({ OR: [{ orderId: order.id }, { entityType: "purchase_request", entityId: { in: ids } }] });
      const beforeRows = await tx.purchaseRequest.findMany({ where: watched });
      const beforeAudits = new Set((await tx.auditLog.findMany({ where: auditWhere(beforeRows.map((r) => r.id)), select: { id: true } })).map((a) => a.id));
      const fresh = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
      await release(tx, fresh, "closed", reason, purchaser);
      const rows = await tx.purchaseRequest.findMany({ where: watched, orderBy: [{ createdAt: "asc" }, { number: "asc" }] });
      const itemLabel = (id: string | null) => (id === itemA.id ? "A" : id === itemB.id ? "B" : id);
      const label = new Map(rows.map((r) => [r.id, r.notes ?? (r.id === autoA.id ? "A1" : auto.some((x) => x.id === r.id) ? "autoB" : `new:${itemLabel(r.orderItemId)}:${r.quantity.toFixed()}`)]));
      const byNumber = new Map(rows.map((r) => [r.number, label.get(r.id)!]));
      const plain = (v: string | null) => (v ?? "").split(" · ").map((x) => byNumber.get(x) ?? x).join(" · ");
      const lineLabel = (id: string | null) => ({ [L1.id]: "L1", [L2.id]: "L2", [L3.id]: "L3", [L4.id]: "L4" } as Record<string, string>)[id ?? ""] ?? id;
      const audits = (await tx.auditLog.findMany({ where: auditWhere(rows.map((r) => r.id)), orderBy: [{ timestamp: "asc" }, { id: "asc" }] })).filter((a) => !beforeAudits.has(a.id));
      snap = {
        requests: rows.map((r) => ({ label: label.get(r.id), item: itemLabel(r.orderItemId), status: r.status, quantity: r.quantity.toFixed(), version: r.version, po: r.purchaseOrderId === po.id, line: lineLabel(r.purchaseOrderLineId), cancelReason: r.cancelReason })).sort((a, b) => String(a.label).localeCompare(String(b.label))),
        audits: audits.map((a) => ({ action: a.action, entity: label.get(a.entityId) ?? a.entityType, fieldChanged: a.fieldChanged, oldValue: a.oldValue, newValue: plain(a.newValue), reason: a.reason, userId: a.userId })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        version: rows.find((r) => r.id === autoA.id)!.version,
      };
    });
    return snap!;
  }
  const oneByOne = await run(releaseOneByOne);
  const batched = await run((tx, po, how, why, who, opts) => releasePoCoverage(tx, po, how, why, who, opts).then(() => undefined));
  assert.deepEqual(batched, oneByOne);
  // And what that outcome is.
  const state = new Map((batched.requests as { label: string; status: string; po: boolean }[]).map((r) => [r.label, [r.status, r.po]]));
  assert.deepEqual([state.get("A1"), state.get("A2"), state.get("B"), state.get("C")], [["approved", false], ["cancelled", false], ["cancelled", false], ["ordered", true]], "the first request of line A reopens, the second and B's are cancelled, the received one stays on the PO");
  const actions = (batched.audits as { action: string; entity: string }[]).filter((a) => ["A1", "A2", "B", "C"].includes(a.entity)).map((a) => `${a.entity}:${a.action}`).sort();
  assert.deepEqual(actions.filter((a) => a.includes("purchase_request_")).filter((a) => /reopened|cancelled|po_closed/.test(a)), ["A1:purchase_request_reopened", "A2:purchase_request_cancelled", "B:purchase_request_cancelled", "C:purchase_request_po_closed"]);
});

test("re-sizing after a receipt: an order whose re-size fails is logged and the PO's other orders are still re-sized; the next re-size corrects it", async () => {
  const purchaser = as("omar", "PURCHASER", "عمر مشتريات");
  const pX = (await prisma.stockProduct.create({ data: { name: `${TAG} س`, nameAr: `${TAG} س`, unit: "KG" } })).id;
  const pY = (await prisma.stockProduct.create({ data: { name: `${TAG} ص`, nameAr: `${TAG} ص`, unit: "KG" } })).id;
  const oA = await heldOrder([pX]), oB = await heldOrder([pY]);
  const po = await createPurchaseOrder({ supplier_id: supplierId, lines: [{ product_id: pX, quantity: 6, unit_price: "3" }, { product_id: pY, quantity: 6, unit_price: "3" }] }, purchaser as never);
  await submitPurchaseOrder(po.id, purchaser as never);
  const [LX, LY] = await prisma.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { lineNo: "asc" } });
  // Each order's suggestion (10) was bought on the PO, which brings only 6: 4 are still short.
  for (const [o, line] of [[oA, LX], [oB, LY]] as const) {
    const [r] = await prisma.purchaseRequest.findMany({ where: { orderId: o.id, orderItemId: { not: null } } });
    await prisma.purchaseRequest.update({ where: { id: r.id }, data: { status: "ordered", purchaseOrderId: po.id, purchaseOrderLineId: line.id, decidedBy: "approver", decidedAt: new Date() } });
  }
  const open = async (orderId: string) => (await prisma.purchaseRequest.findMany({ where: { orderId, orderItemId: { not: null }, status: { in: ["pending_approval", "approved"] } } })).map((r) => r.quantity.toFixed());

  // Order B's re-size fails in the database (a trigger refusing its new suggestion).
  const fn = `zz_po_release_fail_${Date.now()}`;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."orderId" = '${oB.id}' THEN RAISE EXCEPTION 'refused by test'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "PurchaseRequest" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  const logged: unknown[] = [];
  const consoleError = console.error;
  try {
    console.error = (...args: unknown[]) => { logged.push(args[0]); };
    await syncPoCoverageByOrder(po.id, purchaser);
  } finally {
    console.error = consoleError;
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "PurchaseRequest"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  assert.deepEqual(await open(oA.id), ["4"], "order A is re-sized: the 4 the PO will not bring are raised");
  assert.deepEqual(await open(oB.id), [], "order B's re-size failed and rolled back on its own");
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), new RegExp(`order ${oB.id} after a receipt on PO ${po.id} failed`));

  // The next re-size corrects B and leaves A as it is.
  await syncPoCoverageByOrder(po.id, purchaser);
  assert.deepEqual([await open(oA.id), await open(oB.id)], [["4"], ["4"]]);
});
