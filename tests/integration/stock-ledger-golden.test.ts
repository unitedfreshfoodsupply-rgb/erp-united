/* Same rows, same amounts (PW-1, Nov 2026).

   postMovements — the one stock-ledger write path — and the order dispatch/reopen built on it were
   batched so a document costs a fixed number of statements whatever its number of lines. This
   file runs representative movement sets through them and compares every row they write with
   the values the per-move code wrote on the same inputs: movements (kind, bucket, quantity, unit
   cost, posting order), valuation layers (value, cost source, price variance, FIFO remaining),
   the GL entry, the reservations, and every refusal with its message.

   tests/fixtures/stock-ledger-golden.json holds those values. It was captured from the code
   before the change (GOLDEN_CAPTURE=1 writes it instead of comparing): AVCO, FIFO and standard
   products, several buckets and lots, FIFO outflows across several layers (and a layer made in
   the same call), zero-cost stock, a reversal, packaging units, two lines of one product, and
   the negative-bucket and other refusals. Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { StockMovement } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { postMovements, type MoveInput } from "@/lib/inventory/ledger";
import { D } from "@/lib/inventory/decimal";
import { createCustomer } from "@/lib/sales/customers";
import { createOrder, moveOrderStatus, reopenOrder } from "@/lib/orders-service";
import { todayLocalISO } from "@/lib/localDate";

const FIXTURE = path.join(__dirname, "..", "fixtures", "stock-ledger-golden.json");
const CAPTURE = process.env.GOLDEN_CAPTURE === "1";
const TAG = `ZZGOLD${Date.now()}`;
const today = todayLocalISO();
const plusDays = (n: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ctx = { actorId: null, actorName: "golden", effectiveDate: today };
const WH = "wh_main";

// ---- labels: ids differ on every run, names do not -------------------------------
const names = new Map<string, string>();
const labelOf = new Map<string, string>();
const locCode = new Map<string, string>();
const scrub = (s: string | null | undefined) => (s == null ? s : s.split(TAG).join("TAG").replace(/(INV|ISS|RET|ADJ|LOT|JE|TRF|SRT|UN)-[0-9-]+/g, "$1-#"));
const lbl = (id: string | null) => (id == null ? null : labelOf.get(id) ?? names.get(id) ?? "?");
const s = (d: { toString(): string } | null | undefined) => (d == null ? null : D(d.toString()).toString());

async function product(key: string, data: Record<string, unknown> = {}) {
  const p = await prisma.stockProduct.create({ data: { name: `${TAG} ${key}`, unit: "KG", ...data } });
  names.set(p.id, key);
  return p.id;
}
async function lot(key: string, productId: string, receivedDate: string, expiryDate: string | null, unitCost: string | null = null) {
  const l = await prisma.stockLot.create({ data: { productId, lotNumber: `${TAG}-${key}`, receivedDate, expiryDate, unitCost } });
  names.set(l.id, key);
  return l.id;
}

/** The document / receipt each movement belongs to (the ledger's source-matches-kind rule). */
let sourceSeq = 0;
async function sources(productIds: string[]) {
  const n = ++sourceSeq;
  const supplier = await prisma.supplier.create({ data: { code: `SUP-8${String(Date.now() + n).slice(-7)}`, name: `${TAG} مورد ${n}` } });
  const d = await prisma.inventoryDocument.create({ data: { number: `${TAG}-DOC${n}`, type: "adjustment", status: "posted", warehouseId: WH, businessDate: today, reason: `${TAG} golden`, createdBy: "golden", postedAt: new Date() } });
  const intakes = new Map<string, string>();
  for (const [i, productId] of productIds.entries()) {
    const r = await prisma.stockIntake.create({ data: { receiptNumber: `${TAG}-RC${n}-${i}`, receivedDate: today, supplierId: supplier.id, productId, receivedQty: 1, goodQty: 1, warehouseId: WH, locationId: "loc_recv", recordedBy: "golden" } });
    intakes.set(productId, r.id);
  }
  return { doc: d.id, intakes };
}

/** Everything one call wrote, by label. */
async function snapshot(step: string, rows: StockMovement[]) {
  rows.forEach((r, i) => labelOf.set(r.id, `${step}#${i}`));
  const ids = rows.map((r) => r.id);
  const layers = new Map((await prisma.stockValuationLayer.findMany({ where: { movementId: { in: ids } } })).map((l) => [l.movementId, l]));
  const postings = await prisma.stockValuationPosting.findMany({ where: { movementId: { in: ids } } });
  const entryIds = [...new Set(postings.map((p) => p.entryId).filter((x): x is string => !!x))];
  const entries = await prisma.journalEntry.findMany({ where: { id: { in: entryIds } }, include: { lines: { include: { account: { select: { code: true } } } } } });
  const productIds = [...new Set(rows.map((r) => r.productId))].sort((a, b) => names.get(a)!.localeCompare(names.get(b)!));
  const all = await prisma.stockValuationLayer.findMany({ where: { productId: { in: productIds } }, include: { movement: { select: { seq: true } } }, orderBy: { movement: { seq: "asc" } } });
  const buckets = await prisma.stockMovement.groupBy({ by: ["productId", "locationId", "lotId"], where: { productId: { in: productIds } }, _sum: { quantity: true } });
  return {
    moves: rows.map((r) => {
      const l = layers.get(r.id)!;
      return {
        label: labelOf.get(r.id),
        product: names.get(r.productId),
        location: locCode.get(r.locationId) ?? r.locationId,
        lot: lbl(r.lotId),
        kind: r.kind,
        qty: s(r.quantity),
        unitCost: s(r.unitCost),
        reason: scrub(r.reason),
        effectiveDate: r.effectiveDate === today ? "today" : r.effectiveDate,
        layer: { qty: s(l.quantity), unitCost: s(l.unitCost), value: s(l.value), remainingQty: s(l.remainingQty), costSource: l.costSource, priceVariance: s(l.priceVariance) },
      };
    }),
    // Ledger posting order (FIFO and "what happened first" read it).
    seqOrder: [...rows].sort((a, b) => (a.seq < b.seq ? -1 : 1)).map((r) => labelOf.get(r.id)),
    postings: { movements: postings.length, entries: entryIds.length, unposted: postings.filter((p) => !p.entryId).length },
    journal: entries.map((e) => ({
      description: scrub(e.description),
      sourceType: e.sourceType,
      sourceIsFirstMovement: e.sourceId === `mv:${rows[0]?.id}`,
      date: e.date === today ? "today" : e.date,
      total: s(e.total),
      lines: e.lines
        .map((x) => ({ account: x.account.code, debit: s(x.debit), credit: s(x.credit), description: x.description }))
        .sort((a, b) => `${a.account}|${a.debit}|${a.credit}|${a.description}`.localeCompare(`${b.account}|${b.debit}|${b.credit}|${b.description}`)),
    })),
    // FIFO state after the call: what every layer of the touched products has left.
    remaining: all.map((l) => `${lbl(l.movementId)}=${s(l.remainingQty)}`),
    totals: Object.fromEntries(productIds.map((p) => {
      const ls = all.filter((l) => l.productId === p);
      return [names.get(p), { qty: s(ls.reduce((a, l) => a.plus(D(l.quantity.toString())), D(0))), value: s(ls.reduce((a, l) => a.plus(D(l.value.toString())), D(0))) }];
    })),
    buckets: buckets
      .map((b) => `${names.get(b.productId)}@${locCode.get(b.locationId) ?? b.locationId}/${lbl(b.lotId) ?? "-"}=${s(b._sum.quantity)}`)
      .sort(),
  };
}

const results: Record<string, unknown> = {};
async function post(step: string, moves: MoveInput[]) {
  const rows = await inTx((tx) => postMovements(tx, moves, ctx));
  results[step] = await snapshot(step, rows);
  return rows;
}
async function refused(step: string, moves: MoveInput[]) {
  let err: { status?: number; message?: string } | null = null;
  try {
    await inTx((tx) => postMovements(tx, moves, ctx));
  } catch (e) {
    err = e as { status?: number; message?: string };
  }
  assert.ok(err, `${step}: expected a refusal`);
  const left = await prisma.stockMovement.count({ where: { reason: `${TAG} ${step}` } });
  results[step] = { status: err.status ?? null, message: scrub(err.message ?? String(err)), rowsLeft: left };
}

after(async () => {
  if (CAPTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`golden values written to ${FIXTURE}`);
  }
  await prisma.$disconnect();
});

function compare(keys: string[]) {
  if (CAPTURE) return;
  const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const k of keys) assert.deepEqual(results[k], expected[k], `${k}: differs from the per-move ledger`);
}

test("postMovements writes the same movements, layers, FIFO consumption and GL lines as the per-move ledger", async () => {
  for (const l of await prisma.storageLocation.findMany()) locCode.set(l.id, l.code);
  const A = await product("A-avco");
  const F = await product("F-fifo", { costingMethod: "fifo", removalStrategy: "fifo" });
  const S = await product("S-standard", { costingMethod: "standard", standardCost: 7 });
  const S0 = await product("S0-standard-zero", { costingMethod: "standard", standardCost: 0 });
  const Z = await product("Z-zero-cost");
  const N = await product("N-not-tracked", { stockTracked: false });
  const { doc, intakes } = await sources([A, F, S, S0, Z, N]);
  const LA1 = await lot("LA1", A, plusDays(-3), plusDays(4), "10");
  const LF1 = await lot("LF1", F, plusDays(-5), plusDays(6), "5");
  const LF2 = await lot("LF2", F, plusDays(-4), plusDays(8), "8");
  const R = (step: string) => `${TAG} ${step}`;
  const mv = (productId: string, locationId: string, lotId: string | null, quantity: string, kind: MoveInput["kind"], step: string, extra: Partial<MoveInput> = {}): MoveInput => ({ productId, warehouseId: WH, locationId, lotId, quantity: D(quantity), kind, reason: R(step), ...(kind.startsWith("intake") ? { intakeId: intakes.get(productId) } : { documentId: doc }), ...extra });

  await post("recv-A", [
    mv(A, "loc_cold_1", LA1, "10", "intake", "recv-A", { unitCost: D(10), costSource: "purchase" }),
    mv(A, "loc_cold_2", null, "20", "intake", "recv-A", { unitCost: D(13), costSource: "purchase" }),
  ]);
  await post("recv-F", [
    mv(F, "loc_cold_1", LF1, "10", "intake", "recv-F", { unitCost: D(5), costSource: "purchase" }),
    mv(F, "loc_cold_1", LF2, "10", "intake", "recv-F", { unitCost: D(8), costSource: "purchase" }),
    mv(F, "loc_cold_2", null, "5", "intake", "recv-F", { unitCost: D(6), costSource: "purchase" }),
  ]);
  // AVCO in and out in one call: each move is valued on what the ones before it left, and a
  // bucket is drawn down to exactly zero across three moves.
  await post("mixed-A", [
    mv(A, "loc_cold_1", LA1, "-5", "issue", "mixed-A"),
    mv(A, "loc_cold_2", null, "3", "adjustment", "mixed-A"),
    mv(A, "loc_cold_1", LA1, "-4", "scrap", "mixed-A"),
    mv(A, "loc_cold_2", null, "-12.345", "issue", "mixed-A"),
    mv(A, "loc_cold_1", LA1, "-1", "issue", "mixed-A"),
    mv(A, "loc_cold_2", null, "2.5", "customer_return", "mixed-A", { unitCost: D("11.1111"), costSource: "lot" }),
  ]);
  // FIFO: lot-first consumption, an outflow across several layers, and a layer received in the
  // same call consumed by a later move of that call.
  const fifo = await post("fifo-multi", [
    mv(F, "loc_cold_1", LF1, "-7", "issue", "fifo-multi"),
    mv(F, "loc_cold_2", null, "-5", "issue", "fifo-multi"),
    mv(F, "loc_cold_2", null, "7", "intake", "fifo-multi", { unitCost: D(9), costSource: "purchase" }),
    mv(F, "loc_cold_1", LF2, "-9", "issue", "fifo-multi"),
    mv(F, "loc_cold_2", null, "-4", "issue", "fifo-multi"),
    mv(F, "loc_cold_2", null, "-2", "issue", "fifo-multi"),
  ]);
  // A removal at a price its caller knows still consumes FIFO layers.
  await post("fifo-given-cost", [mv(F, "loc_cold_1", LF1, "-1", "adjustment", "fifo-given-cost", { unitCost: D(9), costSource: "lot" })]);
  await post("standard", [
    mv(S, "loc_cold_1", null, "10", "intake", "standard", { unitCost: D(9), costSource: "purchase" }),
    mv(S, "loc_cold_1", null, "-4", "issue", "standard"),
    mv(S, "loc_cold_2", null, "2", "transfer_in", "standard", { unitCost: D(8), costSource: "lot" }),
    mv(S, "loc_cold_1", null, "-1", "supplier_return", "standard", { unitCost: D("9.5"), costSource: "lot" }),
  ]);
  // Stock with no cost behind it leaves at zero, never at an invented cost; taking everything
  // takes all of the value.
  await post("zero-cost", [
    mv(Z, "loc_cold_1", null, "5", "adjustment", "zero-cost"),
    mv(Z, "loc_cold_1", null, "-2", "issue", "zero-cost"),
    mv(Z, "loc_cold_1", null, "3", "intake", "zero-cost", { unitCost: D(4), costSource: "purchase" }),
    mv(Z, "loc_cold_1", null, "-6", "issue", "zero-cost"),
    mv(Z, "loc_cold_1", null, "1", "adjustment", "zero-cost"),
  ]);
  // A document reversal: each movement exactly undone, newest first; the reversed intake goes
  // back out consuming FIFO layers that the earlier moves of the same call put back.
  await post("reversal", [...fifo].reverse().map((m, i) => ({
    productId: m.productId, warehouseId: m.warehouseId, locationId: m.locationId, lotId: m.lotId, quantity: D(m.quantity.toString()).negated(),
    kind: m.kind === "issue" ? "customer_return" : "adjustment", documentId: doc, reason: R(`reversal ${i}`), unitCost: m.unitCost == null ? null : D(m.unitCost.toString()), costSource: "lot", reverses: m.id,
  })));
  // Several products in one call: per-product state and one entry per counter account.
  await post("multi-product", [
    mv(A, "loc_cold_2", null, "-3", "issue", "multi-product"),
    mv(F, "loc_cold_1", LF1, "4", "customer_return", "multi-product", { unitCost: D(5), costSource: "lot" }),
    mv(S, "loc_cold_2", null, "-2", "scrap", "multi-product"),
    mv(A, "loc_cold_1", LA1, "6", "intake", "multi-product", { unitCost: D("12.75"), costSource: "purchase" }),
    mv(F, "loc_cold_1", LF1, "-5", "transfer_out", "multi-product"),
    mv(A, "loc_cold_2", null, "-0.001", "adjustment", "multi-product"),
    mv(Z, "loc_cold_1", null, "-1", "scrap", "multi-product"),
    mv(A, "loc_quarantine", LA1, "2", "customer_return", "multi-product", { unitCost: D(12), costSource: "lot" }),
  ]);

  // Refusals: same check, same message, nothing written.
  await refused("neg-bucket", [mv(A, "loc_cold_1", LA1, "-1000", "issue", "neg-bucket")]);
  await refused("neg-running-in-then-out", [
    mv(A, "loc_cold_1", null, "1", "adjustment", "neg-running-in-then-out"),
    mv(A, "loc_cold_1", null, "-1.001", "issue", "neg-running-in-then-out"),
  ]);
  const lf1 = D((await prisma.stockMovement.aggregate({ where: { productId: F, locationId: "loc_cold_1", lotId: LF1 }, _sum: { quantity: true } }))._sum.quantity?.toString() ?? "0");
  await refused("neg-running-out-then-out", [
    mv(F, "loc_cold_1", LF1, lf1.negated().toString(), "issue", "neg-running-out-then-out"),
    mv(F, "loc_cold_1", LF1, "-0.001", "issue", "neg-running-out-then-out"),
  ]);
  await refused("zero-qty", [mv(A, "loc_cold_1", null, "0", "adjustment", "zero-qty")]);
  await refused("too-precise", [mv(A, "loc_cold_1", null, "1.0001", "adjustment", "too-precise")]);
  await refused("standard-no-cost", [mv(A, "loc_cold_1", null, "1", "adjustment", "standard-no-cost"), mv(S0, "loc_cold_1", null, "1", "adjustment", "standard-no-cost")]);
  await refused("not-tracked", [mv(N, "loc_cold_1", null, "1", "adjustment", "not-tracked")]);
  await refused("wrong-location", [{ ...mv(A, "loc_cold_1", null, "1", "adjustment", "wrong-location"), warehouseId: "wh_nowhere" }]);
  await refused("reverses-mismatch", [mv(F, "loc_cold_1", LF1, "-1", "issue", "reverses-mismatch", { reverses: fifo[0].id })]);
  // Which refusal wins when two moves are wrong: the first one in input order.
  await refused("bad-reason-before-negative", [{ ...mv(A, "loc_cold_2", null, "1", "adjustment", "x"), reason: 5 as never }, mv(A, "loc_cold_2", null, "-1000", "issue", "bad-reason-before-negative")]);
  await refused("negative-before-bad-reason", [mv(A, "loc_cold_2", null, "-1000", "issue", "negative-before-bad-reason"), { ...mv(A, "loc_cold_2", null, "1", "adjustment", "x"), reason: 5 as never }]);
  await refused("std-cost-after-negative", [mv(A, "loc_cold_2", null, "-1000", "issue", "std-cost-after-negative"), mv(S0, "loc_cold_1", null, "1", "adjustment", "std-cost-after-negative")]);

  compare([
    "recv-A", "recv-F", "mixed-A", "fifo-multi", "fifo-given-cost", "standard", "zero-cost", "reversal", "multi-product",
    "neg-bucket", "neg-running-in-then-out", "neg-running-out-then-out", "zero-qty", "too-precise", "standard-no-cost", "not-tracked", "wrong-location",
    "reverses-mismatch", "bad-reason-before-negative", "negative-before-bad-reason", "std-cost-after-negative",
  ]);
});

test("dispatch and reopen issue, reverse and re-reserve the same stock at the same cost", async () => {
  const ids: Record<string, string> = {};
  for (const u of await prisma.user.findMany({ select: { id: true, username: true } })) ids[u.username] = u.id;
  const as = (username: string, role: keyof typeof ROLE_PERMISSIONS, name: string) => ({ ...actor(name, ROLE_PERMISSIONS[role] as string[], ids[username], role), source: "manual" as const });
  const sales = as("mona", "SALES", "منى مبيعات");
  const loader = as("mostafa", "LOADER", "مصطفى تحميل");
  const sup = as("sara", "SUPERVISOR", "سارة مشرفة");
  const customerId = (await createCustomer({ name: `${TAG} Hotel`, name_ar: `${TAG} فندق` }, sales as never)).id;

  const D1 = await product("D1-avco-fefo");
  const D2 = await product("D2-fifo", { costingMethod: "fifo", removalStrategy: "fifo" });
  const D3 = await product("D3-pieces", { unit: "PIECE" });
  const D4 = await product("D4-service", { stockTracked: false });
  await prisma.productPackaging.create({ data: { productId: D3, uomCode: "CRATE", qtyInBaseUnit: 12 } });
  const L1 = await lot("D1-L1", D1, plusDays(-2), plusDays(5));
  const L2 = await lot("D1-L2", D1, plusDays(-3), plusDays(2));
  const LX = await lot("D1-LX-expired", D1, plusDays(-9), plusDays(-1));
  const LQ = await lot("D1-LQ-quarantine", D1, plusDays(-1), plusDays(6));
  const M1 = await lot("D2-M1", D2, plusDays(-6), null);
  const M2 = await lot("D2-M2", D2, plusDays(-2), null);
  const P1 = await lot("D3-P1", D3, plusDays(-1), plusDays(10));
  const { intakes } = await sources([D1, D2, D3]);
  const recv = (productId: string, locationId: string, lotId: string | null, q: string, cost: string): MoveInput => ({ productId, warehouseId: WH, locationId, lotId, quantity: D(q), kind: "intake", intakeId: intakes.get(productId), unitCost: D(cost), costSource: "purchase", reason: `${TAG} setup` });
  await post("dispatch-setup", [
    recv(D1, "loc_cold_2", null, "3", "10"),
    recv(D1, "loc_cold_1", L1, "10", "12"),
    recv(D1, "loc_cold_2", L2, "10", "11"),
    recv(D1, "loc_cold_1", LX, "5", "9"),
    recv(D1, "loc_quarantine", LQ, "4", "10"),
    recv(D2, "loc_cold_1", M1, "8", "5"),
    recv(D2, "loc_cold_2", M2, "6", "7"),
    recv(D3, "loc_cold_1", P1, "60", "2"),
  ]);

  const day = `2099-11-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
  const line = (productId: string, quantity: number, unit = "KG") => ({ stock_product_id: productId, product_name: "", quantity, unit });
  const o = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items: [line(D1, 12), line(D2, 10), line(D3, 2, "CRATE"), line(D1, 6), line(D4, 1)] } as never, sales as never);
  const items = await prisma.orderItem.findMany({ where: { orderId: o.id }, orderBy: { id: "asc" } });
  // Line labels by what they carry (ids sort differently on every run).
  const itemLabel = new Map(items.map((i) => [i.id, `${names.get(i.stockProductId ?? "") ?? "?"}:${i.requiredQuantity}${i.unit}`]));
  const toLoaded = async () => {
    for (const i of items) await prisma.orderItem.update({ where: { id: i.id }, data: { preparedQuantity: i.requiredQuantity, loadedQuantity: i.requiredQuantity, preparationStatus: "done", loadingStatus: "done" } });
    await prisma.order.update({ where: { id: o.id }, data: { status: "loaded" } });
  };
  const reservations = async () =>
    (await prisma.stockReservation.findMany({ where: { sourceType: "order", sourceId: o.id } }))
      .map((r) => `${itemLabel.get(r.sourceLineId ?? "")}=${s(r.quantity)}:${r.status}:${scrub(r.closedReason)}`)
      .sort();
  const docMoves = async (documentId: string) => prisma.stockMovement.findMany({ where: { documentId }, orderBy: { seq: "asc" } });
  const version = async () => (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).version;
  const ship = { vehicle: "TRK-1", driverName: "سواق", crateCount: 3 };

  results["order-reserved"] = await reservations();
  await toLoaded();
  await moveOrderStatus(o.id, "dispatched", loader as never, { ...ship, expectedVersion: await version() });
  const issue = await prisma.inventoryDocument.findFirstOrThrow({ where: { type: "issue", sourceType: "order", sourceId: o.id, reversalOfId: null } });
  results["dispatch"] = { doc: { status: issue.status, reason: scrub(issue.reason) }, ...(await snapshot("dispatch", await docMoves(issue.id))), reservations: await reservations() };

  await reopenOrder(o.id, "ready_for_loading", sup as never, "golden reopen", await version());
  const reversal = await prisma.inventoryDocument.findFirstOrThrow({ where: { reversalOfId: issue.id } });
  const original = await prisma.inventoryDocument.findUniqueOrThrow({ where: { id: issue.id } });
  results["reopen"] = { doc: { type: reversal.type, status: reversal.status, reason: scrub(reversal.reason), original: original.status }, ...(await snapshot("reopen", await docMoves(reversal.id))), reservations: await reservations() };

  await toLoaded();
  await moveOrderStatus(o.id, "dispatched", loader as never, { ...ship, expectedVersion: await version() });
  const again = await prisma.inventoryDocument.findFirstOrThrow({ where: { type: "issue", status: "posted", sourceType: "order", sourceId: o.id, reversalOfId: null } });
  results["redispatch"] = { ...(await snapshot("redispatch", await docMoves(again.id))), reservations: await reservations() };

  // More on the truck than the books hold: refused, with every shortfall listed.
  const o2 = await createOrder({ customer_account_id: customerId, customer_name: "", delivery_date: day, items: [line(D1, 1), line(D2, 1)] } as never, sales as never);
  const items2 = await prisma.orderItem.findMany({ where: { orderId: o2.id } });
  for (const i of items2) await prisma.orderItem.update({ where: { id: i.id }, data: { loadedQuantity: 40, loadingStatus: "done", preparationStatus: "done" } });
  await prisma.order.update({ where: { id: o2.id }, data: { status: "loaded" } });
  type Refusal = { status?: number; message?: string; code?: string; details?: { shortfalls: { productId: string; productName: string; requested: string; available: string; reason: string }[] } };
  let err: Refusal | null = null;
  try {
    await moveOrderStatus(o2.id, "dispatched", loader as never, ship);
  } catch (e) {
    err = e as Refusal;
  }
  assert.ok(err, "the over-loaded order is refused");
  results["dispatch-shortfall"] = {
    status: err.status, code: err.code, message: scrub(err.message),
    shortfalls: err.details?.shortfalls.map((x) => ({ product: names.get(x.productId), name: scrub(x.productName), requested: x.requested, available: x.available, reason: x.reason })),
    status_after: (await prisma.order.findUniqueOrThrow({ where: { id: o2.id } })).status,
  };

  compare(["dispatch-setup", "order-reserved", "dispatch", "reopen", "redispatch", "dispatch-shortfall"]);
});
