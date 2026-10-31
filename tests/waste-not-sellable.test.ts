// F-01 / F-20 remediation (authorized 2026-10-19): waste stock must never be
// available, reserved, allocated, picked, dispatched or fulfilled for customer
// sales, while waste intake/disposal (incl. cold-chain products) keeps working.
// T1-T14 from F01_WASTE_REMEDIATION_PLAN.md. Isolated TAG fixtures — never
// touches UAT or shared scenarios.

import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const TAG = `ZZWST${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
const n = (v: any) => Number(v ?? 0);

let db: PrismaClient | null = null;
async function sql() {
  if (!db) { assertTestDatabase(); db = new PrismaClient(); }
  return db;
}

const product = async (id: string) => (await call("karim", "GET", `/api/inventory/products/${id}`)).body;
const onHand = async (id: string) => n((await product(id)).onHand);
const atCode = async (id: string, code: string) => n(((await product(id)).buckets ?? []).filter((b: any) => b.locationCode === code).reduce((s: number, b: any) => s + n(b.quantity), 0));
const atWaste = (id: string) => atCode(id, "WASTE");
const ledger = async (id: string) => (await call("hossam", "GET", `/api/stock/ledger?product_id=${id}&limit=500`)).body.movements ?? [];

async function setting(key: string, value: unknown) {
  const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
  const r = await call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: TAG, expected_version: cur.version });
  if (r.status !== 200) throw new Error(`setting ${key}: ${JSON.stringify(r.body)}`);
}

// Full dispatch chain (skips prepare — no shortage flags raised; like UAT o5).
async function dispatchOrder(orderId: string, lineId: string, qty: number) {
  await call("sara", "POST", `/api/orders/${orderId}/status`, { to: "loading", reason: TAG });
  await call("mostafa", "POST", `/api/orders/${orderId}/items/${lineId}/load`, { quantity: qty, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${orderId}/status`, { to: "loaded", reason: TAG });
  return call("mostafa", "POST", `/api/orders/${orderId}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1, reason: TAG });
}

let custN = 0;
async function mkOrder(productId: string, productName: string, qty: number) {
  const cr = await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل ${productId.slice(-4)}-${++custN}` });
  const cust = cr.body.customer;
  if (!cust) throw new Error(`mkOrder[${productId.slice(-4)}] customer failed: ${cr.status} ${JSON.stringify(cr.body).slice(0, 200)}`);
  const or = await call("mona", "POST", "/api/orders", {
    customer_account_id: cust.id, customer_name: cust.name, delivery_date: today,
    items: [{ stock_product_id: productId, product_name: productName, quantity: qty }],
  });
  const o = or.body.order;
  if (!o) throw new Error(`mkOrder[${productId.slice(-4)}] order failed: ${or.status} ${JSON.stringify(or.body).slice(0, 300)}`);
  await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: "10", reason: TAG });
  return { order: o, line: o.items[0] };
}

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim"]) await login(u);
  // Note: do NOT touch inventory.dispatch_issue_policy at start — its pristine default
  // (lenient) is asserted by the shared inventory suite via isDefault===true.
  // inventory.adjustment_approval_threshold default is 0 — only changed inside T9 and
  // reset to pristine with value:null afterwards.

  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const newProduct = async (name: string) => (await call("hossam", "POST", "/api/stock/products", { name, unit: "KG" })).body.product;
  const intake = (body: any) => call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, received_date: today, ...body });

  // =========================================================================
  section("T1. WASTE-ONLY STOCK — NOT AVAILABLE, NOT DISPATCHABLE");
  const pT1 = await newProduct(`${TAG} T1 wasteonly`);
  await intake({ product_id: pT1.id, received_kg: 50, waste_qty: 50, unit_cost: "5" });
  const vT1 = await product(pT1.id);
  check("onHand = 50 (waste counted physically)", n(vT1.onHand) === 50, vT1.onHand);
  check("sellableOnHand = 0 (waste excluded)", n(vT1.sellableOnHand) === 0 && n(vT1.available) === 0, [vT1.sellableOnHand, vT1.available]);
  const o1 = await mkOrder(pT1.id, pT1.name, 10);
  const d1 = await dispatchOrder(o1.order.id, o1.line.id, 10);
  check("lenient dispatch completes with exception (never blocks the truck)", d1.status === 200, d1.status);
  const moves1 = (await ledger(pT1.id)).filter((m: any) => m.kind === "issue");
  check("NO issue movement from WASTE", !moves1.some((m: any) => n(m.quantity) < 0 && m.locationId === "loc_waste"), moves1.map((m: any) => [m.locationId, m.quantity]));
  check("onHand still 50 after dispatch attempt", (await onHand(pT1.id)) === 50, await onHand(pT1.id));

  // =========================================================================
  section("T2. MIXED STOCK — ORDER CANNOT TOUCH WASTE");
  const pT2 = await newProduct(`${TAG} T2 mixed`);
  await intake({ product_id: pT2.id, received_kg: 100, unit_cost: "5" });           // 100 sellable
  await intake({ product_id: pT2.id, received_kg: 50, waste_qty: 50, unit_cost: "5" }); // +50 waste
  const vT2 = await product(pT2.id);
  check("sellable 100, waste 50, onHand 150", n(vT2.sellableOnHand) === 100 && (await atWaste(pT2.id)) === 50 && n(vT2.onHand) === 150, [vT2.sellableOnHand, vT2.onHand]);
  const o2 = await mkOrder(pT2.id, pT2.name, 120);
  const d2 = await dispatchOrder(o2.order.id, o2.line.id, 120);
  check("over-request dispatches (lenient) with exception", d2.status === 200, d2.status);
  const moves2 = (await ledger(pT2.id)).filter((m: any) => m.kind === "issue");
  check("issued exactly 100 (sellable cap), ZERO from WASTE", Math.abs(moves2.reduce((s: number, m: any) => s + n(m.quantity), 0)) === 100 && !moves2.some((m: any) => m.locationId === "loc_waste"), moves2.map((m: any) => [m.locationId, m.quantity]));
  check("waste bucket untouched (50)", (await atWaste(pT2.id)) === 50, await atWaste(pT2.id));

  // =========================================================================
  section("T3. DIRECT API — SUPPLIER RETURN AUTO-ALLOCATE REFUSES WASTE");
  const pT3 = await newProduct(`${TAG} T3 supreturn`);
  await intake({ product_id: pT3.id, received_kg: 5, unit_cost: "5" });              // 5 sellable
  await intake({ product_id: pT3.id, received_kg: 10, waste_qty: 10, unit_cost: "5" }); // +10 waste
  const r3 = await call("hossam", "POST", "/api/inventory/returns", { direction: "supplier", supplier_id: sup.id, reason: `${TAG} r3`, lines: [{ product_id: pT3.id, quantity: 10 }] });
  check("10 kg return refused: only 5 sellable (waste not allocatable)", r3.status === 400, [r3.status, r3.body?.error]);
  const moves3 = (await ledger(pT3.id)).filter((m: any) => m.kind === "supplier_return");
  check("no supplier_return movement posted", moves3.length === 0);
  check("waste still 10", (await atWaste(pT3.id)) === 10);

  // =========================================================================
  section("T4. DIRECT API — RESERVATION CANNOT RESERVE WASTE");
  const pT4 = await newProduct(`${TAG} T4 reserve`);
  await intake({ product_id: pT4.id, received_kg: 10, waste_qty: 10, unit_cost: "5" });
  const r4 = await call("hossam", "POST", "/api/inventory/reservations", { product_id: pT4.id, quantity: 5, source_type: "manual", source_id: `${TAG}-rsv` });
  check("reserve 5 of 10 (all waste) -> 400", r4.status === 400, [r4.status, r4.body?.error]);
  // with sellable stock it still works
  await intake({ product_id: pT4.id, received_kg: 7, unit_cost: "5" });
  const r4b = await call("hossam", "POST", "/api/inventory/reservations", { product_id: pT4.id, quantity: 5, source_type: "manual", source_id: `${TAG}-rsv2` });
  check("reserve 5 with 7 sellable -> created", r4b.status === 201, [r4b.status, r4b.body?.error]);

  // =========================================================================
  section("T5. CONCURRENT ORDERS — COMBINED ISSUE NEVER EXCEEDS SELLABLE");
  const pT5 = await newProduct(`${TAG} T5 concurrent`);
  await intake({ product_id: pT5.id, received_kg: 100, unit_cost: "5" });
  await intake({ product_id: pT5.id, received_kg: 50, waste_qty: 50, unit_cost: "5" });
  const a5 = await mkOrder(pT5.id, pT5.name, 80);
  const b5 = await mkOrder(pT5.id, pT5.name, 80);
  const [d5a, d5b] = await Promise.all([dispatchOrder(a5.order.id, a5.line.id, 80), dispatchOrder(b5.order.id, b5.line.id, 80)]);
  check("both dispatches complete (lenient)", d5a.status === 200 && d5b.status === 200);
  const moves5 = (await ledger(pT5.id)).filter((m: any) => m.kind === "issue");
  const issued5 = Math.abs(moves5.reduce((s: number, m: any) => s + n(m.quantity), 0));
  check("combined issued = 100 (sellable cap), never waste", issued5 === 100 && moves5.every((m: any) => m.locationId !== "loc_waste"), { issued5, locs: moves5.map((m: any) => m.locationId) });
  check("waste untouched (50)", (await atWaste(pT5.id)) === 50);

  // =========================================================================
  section("T6. EXISTING RESERVATION + WASTE ADDED — FULFILMENT SKIPS WASTE");
  const pT6 = await newProduct(`${TAG} T6 rsv+dispatch`);
  await intake({ product_id: pT6.id, received_kg: 10, unit_cost: "5" });
  const rsv6 = await call("hossam", "POST", "/api/inventory/reservations", { product_id: pT6.id, quantity: 10, source_type: "manual", source_id: `${TAG}-rsv6` });
  check("reservation created (10 of 10 sellable)", rsv6.status === 201, [rsv6.status, rsv6.body?.error]);
  await intake({ product_id: pT6.id, received_kg: 40, waste_qty: 40, unit_cost: "5" }); // waste added after reservation
  const v6 = await product(pT6.id);
  check("available stays 0 with reservation — waste (40) never adds to available", n(v6.sellableOnHand) === 10 && n(v6.available) === 0 && (await atWaste(pT6.id)) === 40, [v6.sellableOnHand, v6.available]);
  const rel6 = await call("hossam", "POST", `/api/inventory/reservations/${rsv6.body.reservation.id}/release`, { reason: `${TAG} إفراج` });
  check("reservation released", rel6.status === 200, [rel6.status, rel6.body?.error]);
  check("available now 10 — sellable only, not 50", (await product(pT6.id)).available === "10", (await product(pT6.id)).available);
  const o6 = await mkOrder(pT6.id, pT6.name, 10);
  await dispatchOrder(o6.order.id, o6.line.id, 10);
  const moves6 = (await ledger(pT6.id)).filter((m: any) => m.kind === "issue");
  check("dispatched 10 from sellable, none from WASTE", Math.abs(moves6.reduce((s: number, m: any) => s + n(m.quantity), 0)) === 10 && moves6.every((m: any) => m.locationId !== "loc_waste"), moves6.map((m: any) => [m.locationId, m.quantity]));
  check("waste still 40", (await atWaste(pT6.id)) === 40);

  // =========================================================================
  section("T7. STRICT POLICY — ORDER WITH ONLY WASTE REFUSED AT DISPATCH");
  await setting("inventory.dispatch_issue_policy", "strict");
  const pT7 = await newProduct(`${TAG} T7 strict`);
  await intake({ product_id: pT7.id, received_kg: 20, waste_qty: 20, unit_cost: "5" });
  const o7 = await mkOrder(pT7.id, pT7.name, 10);
  const d7 = await dispatchOrder(o7.order.id, o7.line.id, 10);
  check("strict dispatch with only waste -> 409", d7.status === 409, [d7.status, d7.body?.error]);
  const moves7 = (await ledger(pT7.id)).filter((m: any) => m.kind === "issue");
  check("NO issue movement at all", moves7.length === 0);
  check("onHand unchanged (20 waste)", (await onHand(pT7.id)) === 20);
  await setting("inventory.dispatch_issue_policy", null); // reset to pristine default (lenient)

  // =========================================================================
  section("T8. DISPOSAL — SCRAP FROM loc_waste WORKS (explicit location)");
  const pT8 = await newProduct(`${TAG} T8 scrap`);
  await intake({ product_id: pT8.id, received_kg: 50, waste_qty: 50, unit_cost: "5" });
  check("waste 50 before scrap", (await atWaste(pT8.id)) === 50);
  // Accounts Health shows the waste still carried in stock value, per product (C-3).
  const wastePending = async () => (await call("karim", "GET", "/api/accounting/integrity")).body.integrity.checks.find((c: any) => c.key === "waste_pending");
  const wp1 = await wastePending();
  const wp1Row = wp1?.detail?.find((d: any) => d.productId === pT8.id);
  check("waste awaiting write-off listed, informational", wp1?.ok === true && wp1Row?.quantity === "50" && wp1Row?.value === "250.00", wp1Row);
  const s8 = await call("hossam", "POST", "/api/inventory/scrap", { reason: `${TAG} إعدام`, lines: [{ product_id: pT8.id, quantity: 50, location_id: "loc_waste" }] });
  check("scrap posted", s8.status === 201 && s8.body?.document?.status === "posted", [s8.status, s8.body?.error]);
  check("waste bucket zeroed", (await atWaste(pT8.id)) === 0 && (await onHand(pT8.id)) === 0, await onHand(pT8.id));
  const scrapMoves = (await ledger(pT8.id)).filter((m: any) => m.kind === "scrap");
  check("scrap movement from loc_waste recorded", scrapMoves.some((m: any) => m.locationId === "loc_waste"));
  const wp2 = await wastePending();
  check("written-off waste leaves the pending list", !wp2?.detail?.some((d: any) => d.productId === pT8.id));
  check("pending waste value drops by the write-off", Math.abs(Number(wp1.ledger) - Number(wp2.ledger) - 250) < 0.005, [wp1.ledger, wp2.ledger]);

  // =========================================================================
  section("T9. DISPOSAL ABOVE THRESHOLD — ADJUSTMENT WAITS FOR APPROVAL");
  await setting("inventory.adjustment_approval_threshold", 5);
  const pT9 = await newProduct(`${TAG} T9 approval`);
  await intake({ product_id: pT9.id, received_kg: 30, waste_qty: 30, unit_cost: "5" });
  // Waste stock is lot-tracked; an adjustment must name the lot (scrap allocates, adjustment with
  // location+lot targets the exact bucket).
  const lot9 = (await ledger(pT9.id)).find((m: any) => m.locationId === "loc_waste")?.lotId;
  check("waste lot identified", typeof lot9 === "string", lot9);
  const a9 = await call("hossam", "POST", "/api/inventory/adjustments", { reason: `${TAG} تسوية هالك`, lines: [{ product_id: pT9.id, quantity: -20, location_id: "loc_waste", lot_id: lot9 }] });
  check("20 kg waste write-off (threshold 5) -> pending_approval (201/202)", [201, 202].includes(a9.status) && a9.body?.document?.status === "pending_approval", [a9.status, a9.body?.document?.status, a9.body?.error]);
  const pending = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === a9.body.document.id);
  check("approval request exists (inventory.adjustment)", !!pending && pending.type === "inventory.adjustment", pending?.type);
  check("waste still 30 while pending", (await atWaste(pT9.id)) === 30);
  const dec9 = await call("admin", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve", comment: `${TAG} موافقة`, expected_version: pending.version });
  check("approval posted the write-off", dec9.status === 200 && (await atWaste(pT9.id)) === 10, [dec9.status, dec9.body?.error, await atWaste(pT9.id)]);
  await setting("inventory.adjustment_approval_threshold", null); // reset to pristine default (0)

  // =========================================================================
  section("T10. RETURNS — CUSTOMER RETURN DOES NOT TOUCH WASTE");
  const pT10 = await newProduct(`${TAG} T10 return`);
  await intake({ product_id: pT10.id, received_kg: 100, waste_qty: 10, unit_cost: "5" });
  const o10 = await mkOrder(pT10.id, pT10.name, 10);
  await dispatchOrder(o10.order.id, o10.line.id, 10);
  check("waste 10 before return", (await atWaste(pT10.id)) === 10);
  const ret10 = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: o10.order.id, reason: `${TAG} مرتجع`, lines: [{ product_id: pT10.id, quantity: 5 }] });
  check("customer return posted", ret10.status === 201, [ret10.status, ret10.body?.error]);
  const retM = (await ledger(pT10.id)).filter((m: any) => m.kind === "customer_return");
  check("return exists and never lands in WASTE", retM.some((m: any) => n(m.quantity) > 0) && retM.every((m: any) => m.locationId !== "loc_waste"));
  check("waste still 10", (await atWaste(pT10.id)) === 10);

  // =========================================================================
  section("T11. OTHER LOCATIONS UNAFFECTED — COLD ROOMS & GRADE B STILL SELLABLE");
  const pT11 = await newProduct(`${TAG} T11 coldroom`);
  await intake({ product_id: pT11.id, received_kg: 40, unit_cost: "5", location_id: "loc_cold_1" });
  const v11 = await product(pT11.id);
  check("cold-room stock fully sellable (40/40)", n(v11.sellableOnHand) === 40 && n(v11.available) === 40, [v11.sellableOnHand, v11.available]);
  const gb11 = await newProduct(`${TAG} T11 gradeb`);
  await intake({ product_id: gb11.id, received_kg: 60, grade_b_qty: 20, unit_cost: "5" }); // legacy: GB at loc_grade_b
  const v11b = await product(gb11.id);
  check("grade B bucket sellable (60 incl. 20 at GRADE-B)", n(v11b.sellableOnHand) === 60 && n(v11b.onHand) === 60, [v11b.sellableOnHand, v11b.onHand]);

  // =========================================================================
  section("T12. F-20 — COLD-CHAIN PRODUCTS CAN RECORD WASTE AT INTAKE AND SORT");
  const pT12 = await newProduct(`${TAG} T12 coldchain`);
  const dbc1 = await sql();
  await dbc1.stockProduct.update({ where: { id: pT12.id }, data: { coldChain: true } });
  const i12 = await intake({ product_id: pT12.id, received_kg: 100, waste_qty: 30, unit_cost: "5" });
  check("cold-chain intake with waste -> 201 (was 400)", i12.status === 201, [i12.status, i12.body?.error]);
  const m12a = (await ledger(pT12.id)).filter((m: any) => m.intakeId === i12.body.intake.id && m.locationId === "loc_waste");
  check("waste movement at loc_waste for cold-chain product", m12a.some((m: any) => n(m.quantity) === 30), m12a.map((m: any) => m.quantity));
  // cold-chain sort into waste
  const p12b = await newProduct(`${TAG} T12b coldsort`);
  const dbc2 = await sql();
  await dbc2.stockProduct.update({ where: { id: p12b.id }, data: { coldChain: true } });
  const i12b = (await intake({ product_id: p12b.id, received_kg: 100, unit_cost: "5" })).body.intake;
  const s12 = await call("hossam", "POST", `/api/stock/intakes/${i12b.id}/sort`, { input_kg: 100, good_kg: 80, grade_b_kg: 10, waste_kg: 10, reason: `${TAG} فرز تبريد` });
  check("cold-chain sort with waste -> 201", s12.status === 201, [s12.status, s12.body?.error]);
  const m12b = (await ledger(p12b.id)).filter((m: any) => m.kind === "sorting_in" && m.locationId === "loc_waste");
  check("cold-chain waste sorted into loc_waste (10)", m12b.some((m: any) => n(m.quantity) === 10), m12b.map((m: any) => m.quantity));

  // =========================================================================
  section("T13. RECONCILIATION — VALUATION AGREES, TRIAL BALANCE BALANCED");
  const valRows = (await call("karim", "GET", "/api/inventory/reports/valuation")).body.rows;
  for (const [p, label] of [[pT1, "T1"], [pT3, "T3"], [pT8, "T8"], [pT9, "T9"], [pT10, "T10"], [pT12, "T12"]] as const) {
    const vr = valRows.find((r: any) => r.productId === p.id);
    check(`${label} valuation qty == onHand`, n(vr?.quantity) === (await onHand(p.id)), { val: vr?.quantity, onHand: await onHand(p.id) });
  }
  const tb = (await call("karim", "GET", `/api/accounting/trial-balance?from=2000-01-01&to=${today}`)).body.trialBalance;
  check("trial balance balanced after all waste flows", tb.balanced === true && tb.totals.debit === tb.totals.credit, tb.totals);

  await sql().then((x) => x.$disconnect());
  finish("WASTE-NOT-SELLABLE");
}

main().then(() => finish("WASTE-NOT-SELLABLE")).catch((e) => { console.error("SUITE CRASHED", e); process.exit(1); });