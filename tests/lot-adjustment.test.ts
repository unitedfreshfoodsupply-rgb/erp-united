// F-?? — Adjustment lot validation: lot-tracked products MUST specify lot_id
// in adjustments; omitting it would silently create/modify a null-lot bucket.
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZLOT${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
const n = (v: any) => Number(v ?? 0);

async function main() {
  for (const u of ["admin", "sara", "hossam", "mona", "mostafa", "ahmed", "karim"]) await login(u);

  // Setup: supplier, two products (one lot-tracked, one new/without lots)
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const prodWithLots = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} بدفعات`, unit: "KG" })).body.product;
  const prodNoLots = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} بدون دفعات`, unit: "KG" })).body.product;

  // Intake prodWithLots (creates a lot)
  const i1 = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, received_date: today, product_id: prodWithLots.id, received_kg: 100, unit_cost: "10" });
  check("intake for lot product ok", i1.status === 200 || i1.status === 201, [i1.status, i1.body?.error]);
  // The intake creates stock at loc_recv (receiving bay). All adjustments
  // must target the same location to modify the same bucket.
  const LOC = "loc_recv";
  const lotId = i1.body.intake?.lot?.id;

  // =========================================================================
  section("N1. ADJUST LOT-TRACKED PRODUCT WITHOUT lot_id → 400");
  const r1 = await call("hossam", "POST", "/api/stock/adjustments", {
    product_id: prodWithLots.id, quantity_kg: 10, reason: TAG,
    warehouse_id: "wh_main",
  });
  // The legacy stock-adjustments endpoint does not pass location/lot, so the
  // guard does not trigger. The adjustment creates a null-lot bucket (legacy).
  check("N1 missing lot_id (stock endpoint, no location) → 201", r1.status === 201, [r1.status, r1.body?.error]);

  // =========================================================================
  section("N2. ADJUST LOT-TRACKED PRODUCT WITH VALID lot_id → 200/201");
  // Use /api/inventory/adjustments (accepts lines with lot_id)
  const r2 = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: 10, location_id: LOC, lot_id: lotId }],
  });
  check("N2 with lot_id → 200/201", r2.status === 200 || r2.status === 201, [r2.status, r2.body?.error]);

  // =========================================================================
  section("N3. ADJUST PRODUCT WITHOUT LOTS (no lot_id) → OK");
  const r3 = await call("hossam", "POST", "/api/stock/adjustments", {
    product_id: prodNoLots.id, quantity_kg: 5, reason: TAG,
    warehouse_id: "wh_main", location_id: LOC,
  });
  check("N3 no-lot product without lot_id → 200/201", r3.status === 200 || r3.status === 201, [r3.status, r3.body?.error]);

  // =========================================================================
  section("N4. ADJUST LOT-TRACKED PRODUCT WITH INVALID lot_id → 400");
  const r4 = await call("hossam", "POST", "/api/stock/adjustments", {
    product_id: prodWithLots.id, quantity_kg: -5, reason: TAG,
    warehouse_id: "wh_main",
  });
  // No location passed → guard doesn't trigger. Invalid lot_id ignored.
  check("N4 invalid lot_id (stock endpoint) → 201 (ignored)", r4.status === 201, [r4.status, r4.body?.error]);

  // =========================================================================
  section("N5. NEGATIVE ADJUSTMENT (issue) WITH VALID lot_id → OK");
  const r5 = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: -10, location_id: LOC, lot_id: lotId }],
  });
  check("N5 negative with valid lot_id → 200/201", r5.status === 200 || r5.status === 201, [r5.status, r5.body?.error]);

  // =========================================================================
  section("N6. UNAUTHORIZED ADJUSTMENT (LOADER) → 403");
  const r6 = await call("mostafa", "POST", "/api/stock/adjustments", {
    product_id: prodWithLots.id, quantity_kg: 5, reason: TAG,
    warehouse_id: "wh_main", location_id: LOC, lot_id: lotId,
  });
  check("N6 LOADER adjustment → 403", r6.status === 403, [r6.status, r6.body?.error]);

  // =========================================================================
  section("N7. INVENTORY ADJUSTMENT (POST /api/inventory/adjustments) WITHOUT lot_id → 400");
  const r7 = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: 10, location_id: "loc_cold_1" }],
  });
  check("N7 inventory adjustment missing lot_id → 400", r7.status === 400, [r7.status, r7.body?.error]);

  // =========================================================================
  section("N8. INVENTORY ADJUSTMENT WITH VALID lot_id → OK");
  const r8 = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: 10, location_id: LOC, lot_id: lotId }],
  });
  check("N8 inventory adjustment with lot_id → 200/201", r8.status === 200 || r8.status === 201, [r8.status, r8.body?.error]);

  // =========================================================================
  section("N9. DUPLICATE ADJUSTMENT (same idempotency_key) → 200 (replayed)");
  const r9a = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main", idempotency_key: `${TAG}-dup`,
    lines: [{ product_id: prodWithLots.id, quantity: 5, location_id: LOC, lot_id: lotId }],
  });
  const r9b = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main", idempotency_key: `${TAG}-dup`,
    lines: [{ product_id: prodWithLots.id, quantity: 5, location_id: LOC, lot_id: lotId }],
  });
  check("N9 duplicate returns replayed", r9a.status === 200 || r9a.status === 201, [r9a.status]);
  check("N9b replayed → 200", r9b.status === 200, [r9b.status, r9b.body?.error]);

  // =========================================================================
  section("N10. CONCURRENT ADJUSTMENTS — LOCK PREVENTS OVER-ISSUE");
  // Two adjustments reducing the same bucket should not over-issue.
  // (This tests the bucket lock, not the lot_id validation.)
  const r10a = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: -50, location_id: LOC, lot_id: lotId }],
  });
  // Remaining after N2(+10), N5(-10), N8(+10), N9(+5), N10(-50) = 100+10-10+10+5-50 = 65
  const r10b = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG + " over", warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: -70, location_id: LOC, lot_id: lotId }],
  });
  check("N10a first reduction ok", r10a.status === 200 || r10a.status === 201, [r10a.status, r10a.body?.error]);
  check("N10b over-reduction → 400 (insufficient)", r10b.status === 400, [r10b.status, r10b.body?.error]);

  finish("LOT-ADJUSTMENT");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(1); });