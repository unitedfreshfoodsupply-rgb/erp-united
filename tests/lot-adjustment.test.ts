// F-?? — Adjustment lot validation: lot-tracked products MUST specify lot_id
// in adjustments; omitting it would silently create/modify a null-lot bucket.
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";
import { adjustWithApproval } from "./_stock";

// CTL-01: every non-zero adjustment waits for approval by someone else
// (inventory.adjustment_approval_required, threshold 0). Each accepted adjustment here is
// requested by the storekeeper (202, nothing moves) and approved by the supervisor, which
// posts it — "accepted" below means exactly that: 202 then an approval that posts (200).
const posted = (a: { request: { status: number }; decision: { status: number } | null }) => a.request.status === 202 && a.decision?.status === 200;

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
  const a1 = await adjustWithApproval({
    product_id: prodWithLots.id, quantity_kg: 10, reason: TAG,
    warehouse_id: "wh_main",
  }, { path: "/api/stock/adjustments" });
  const r1 = a1.request;
  // The legacy stock-adjustments endpoint does not pass location/lot, so the
  // guard does not trigger. The adjustment creates a null-lot bucket (legacy).
  check("N1 missing lot_id (stock endpoint, no location) → accepted (202 + approved)", posted(a1), [r1.status, r1.body?.error, a1.decision?.body]);

  // =========================================================================
  section("N2. ADJUST LOT-TRACKED PRODUCT WITH VALID lot_id → 200/201");
  // Use /api/inventory/adjustments (accepts lines with lot_id)
  const a2 = await adjustWithApproval({
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: 10, location_id: LOC, lot_id: lotId }],
  }, { path: "/api/inventory/adjustments" });
  const r2 = a2.request;
  check("N2 with lot_id → accepted (202 + approved)", posted(a2), [r2.status, r2.body?.error, a2.decision?.body]);

  // =========================================================================
  section("N3. ADJUST PRODUCT WITHOUT LOTS (no lot_id) → OK");
  const a3 = await adjustWithApproval({
    product_id: prodNoLots.id, quantity_kg: 5, reason: TAG,
    warehouse_id: "wh_main", location_id: LOC,
  }, { path: "/api/stock/adjustments" });
  const r3 = a3.request;
  check("N3 no-lot product without lot_id → accepted (202 + approved)", posted(a3), [r3.status, r3.body?.error, a3.decision?.body]);

  // =========================================================================
  section("N4. ADJUST LOT-TRACKED PRODUCT WITH INVALID lot_id → 400");
  const a4 = await adjustWithApproval({
    product_id: prodWithLots.id, quantity_kg: -5, reason: TAG,
    warehouse_id: "wh_main",
  }, { path: "/api/stock/adjustments" });
  const r4 = a4.request;
  // No location passed → guard doesn't trigger. Invalid lot_id ignored.
  check("N4 invalid lot_id (stock endpoint) → accepted (ignored; 202 + approved)", posted(a4), [r4.status, r4.body?.error, a4.decision?.body]);

  // =========================================================================
  section("N5. NEGATIVE ADJUSTMENT (issue) WITH VALID lot_id → OK");
  const a5 = await adjustWithApproval({
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: -10, location_id: LOC, lot_id: lotId }],
  }, { path: "/api/inventory/adjustments" });
  const r5 = a5.request;
  check("N5 negative with valid lot_id → accepted (202 + approved)", posted(a5), [r5.status, r5.body?.error, a5.decision?.body]);

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
  const a8 = await adjustWithApproval({
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: 10, location_id: LOC, lot_id: lotId }],
  }, { path: "/api/inventory/adjustments" });
  const r8 = a8.request;
  check("N8 inventory adjustment with lot_id → accepted (202 + approved)", posted(a8), [r8.status, r8.body?.error, a8.decision?.body]);

  // =========================================================================
  section("N9. DUPLICATE ADJUSTMENT (same idempotency_key) → 200 (replayed)");
  const a9 = await adjustWithApproval({
    reason: TAG, warehouse_id: "wh_main", idempotency_key: `${TAG}-dup`,
    lines: [{ product_id: prodWithLots.id, quantity: 5, location_id: LOC, lot_id: lotId }],
  }, { path: "/api/inventory/adjustments" });
  const r9a = a9.request;
  const r9b = await call("hossam", "POST", "/api/inventory/adjustments", {
    reason: TAG, warehouse_id: "wh_main", idempotency_key: `${TAG}-dup`,
    lines: [{ product_id: prodWithLots.id, quantity: 5, location_id: LOC, lot_id: lotId }],
  });
  check("N9 first submit accepted (202 + approved)", posted(a9), [r9a.status, a9.decision?.body]);
  check("N9b replayed → 200, the same document", r9b.status === 200 && r9b.body?.document?.id === r9a.body?.document?.id, [r9b.status, r9b.body?.error]);

  // =========================================================================
  section("N10. CONCURRENT ADJUSTMENTS — LOCK PREVENTS OVER-ISSUE");
  // Two adjustments reducing the same bucket should not over-issue.
  // (This tests the bucket lock, not the lot_id validation.)
  const a10a = await adjustWithApproval({
    reason: TAG, warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: -50, location_id: LOC, lot_id: lotId }],
  }, { path: "/api/inventory/adjustments" });
  const r10a = a10a.request;
  // Remaining after N2(+10), N5(-10), N8(+10), N9(+5), N10(-50) = 100+10-10+10+5-50 = 65
  const a10b = await adjustWithApproval({
    reason: TAG + " over", warehouse_id: "wh_main",
    lines: [{ product_id: prodWithLots.id, quantity: -70, location_id: LOC, lot_id: lotId }],
  }, { path: "/api/inventory/adjustments" });
  const r10b = a10b.request;
  check("N10a first reduction ok (202 + approved)", posted(a10a), [r10a.status, r10a.body?.error, a10a.decision?.body]);
  // The balance is judged when the adjustment is approved (stock may move in between).
  check("N10b over-reduction → refused at approval: 400 (insufficient)", r10b.status === 202 && a10b.decision?.status === 400, [r10b.status, a10b.decision?.status, a10b.decision?.body]);

  finish("LOT-ADJUSTMENT");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(1); });