/* Regression suite for the shortage-approval flow.
   Guards two things in lib/orders-service.ts:

   1. (recomputeOrderFlags) No Prisma lookups against fields that don't exist on
      ApprovalDecision — the original regression threw a PrismaClientValidationError
      ("Unknown argument `status`") when ANY shortage was recorded (92/100 kg).

   2. (CRIT-2, user spec) ANY shortage — even inside the tolerance band where
      needsReview stays false — is a live gate: the order cannot advance to
      ready_for_loading/loaded without an audited supervisor approval. Flags are
      re-derived from actual quantities on every write, so a fresh variance at a
      later stage (e.g. a still-short load) demands its own approval decision.
*/
import { call, login, makeChecker } from "./_harness";
import { stockUp } from "./_stock";

async function main() {
  const { check, section, finish } = makeChecker();
  const TAG = `sa${Date.now() % 100000}`;
  let n = 0;

  for (const u of ["admin", "ahmed", "sara", "mostafa"]) await login(u);

  const makeOrder = async (qty: number) => {
    n += 1;
    const cust = (await call("admin", "POST", "/api/sales/customers", { name: `${TAG}-c${n}` })).body.customer;
    const prod = (await call("admin", "POST", "/api/stock/products", { name: `${TAG}-m${n}`, unit: "KG" })).body.product;
    await stockUp(prod.id, qty); // WF-01: a confirmed line must be fully reservable
    const created = await call("sara", "POST", "/api/orders", {
      customer_account_id: cust.id, customer_name: cust.name, delivery_date: "2026-12-02",
      items: [{ stock_product_id: prod.id, product_name: prod.name, quantity: qty, unit: "KG" }],
    });
    const order = created.body.order;
    const moved = await call("ahmed", "POST", `/api/orders/${order.id}/status`, { to: "preparing", expected_version: order.version });
    return moved.body.order;
  };
  const prepare = async (order: any, qty: number, markDone = false) =>
    call("ahmed", "POST", `/api/orders/${order.id}/items/${order.items[0].id}/prepare`, { quantity: qty, ...(markDone ? { mark_done: true } : {}) });
  const getOrder = async (id: string) => (await call("sara", "GET", `/api/orders/${id}`)).body.order;
  const advance = (order: any, to: string, who = "ahmed") =>
    call(who, "POST", `/api/orders/${order.id}/status`, { to, expected_version: order.version });

  section("0. THRESHOLD AT 10% (within-tolerance shortage path)");
  const set = await call("admin", "PATCH", "/api/admin/settings/orders.shortage_review_threshold_pct", {
    value: 10, reason: `${TAG} test threshold`,
  });
  check("set threshold to 10", set.status === 200, set.status);

  section("1. WITHIN-TOLERANCE SHORTAGE (92/100) IS RECORDED, NOT A PRISMA ERROR");
  const o1 = await makeOrder(100);
  check("order 1 in preparing", o1?.status === "preparing", o1?.status);

  // THE REGRESSION: this used to return 400 "نوع حقل غير متوقع" (Prisma
  // validation error) instead of a normal flag update.
  const r1 = await prepare(o1, 92);
  check("prepare 92/100 succeeds (not a Prisma error)", r1.status === 200, r1.status);
  check("shortage flagged within tolerance", r1.body?.flags?.shortage === true, r1.body?.flags);
  check("no review required inside 10% tolerance", r1.body?.flags?.needsReview === false, r1.body?.flags);
  const o1b = await getOrder(o1.id);
  check("order row shows shortage=true", o1b?.shortage === true, o1b?.shortage);

  section("2. MARK DONE + REPEATED REQUEST STAY STABLE (re-run recompute)");
  const r1b = await prepare(o1, 92, true);
  check("mark item done succeeds", r1b.status === 200 && r1b.body?.item?.preparationStatus === "done", r1b.body?.item?.preparationStatus);
  const o1b2 = await getOrder(o1.id);
  check("shortage stays flagged after mark-done (recompute rerun)", o1b2?.shortage === true && o1b2?.needsReview === false, { s: o1b2?.shortage, r: o1b2?.needsReview });
  const r1x = await prepare(o1, 92);
  check("repeated prepare returns 200, not a Prisma error", r1x.status === 200, r1x.status);

  section("3. WITHIN-TOLERANCE SHORTAGE STILL BLOCKS ADVANCE (CRIT-2 gate)");
  const o1c = await getOrder(o1.id);
  const adv = await advance(o1c, "ready_for_loading");
  check("advance without approval blocked (409)", adv.status === 409, adv.status);

  section("4. SUPERVISOR APPROVES THE SHORTAGE (decision 1)");
  const appr = await call("sara", "POST", `/api/orders/${o1.id}/approve`, {
    reason: `${TAG} approved decision 1`, expected_version: o1c.version,
  });
  check("supervisor approval succeeds", appr.status === 200, appr.status);
  const o1d = appr.body?.order ?? o1c;
  check("approval cleared shortage flag", o1d?.shortage === false, o1d?.shortage);
  check("approval cleared needsReview flag", o1d?.needsReview === false, o1d?.needsReview);

  section("5. ORDER ADVANCES TO LOADING AFTER APPROVAL");
  const o1e = await getOrder(o1.id);
  const ready = await advance(o1e, "ready_for_loading");
  check("advance to ready_for_loading after approval", ready.status === 200, ready.status);
  const loading = await advance(ready.body.order, "loading", "mostafa");
  check("advance to loading after approval", loading.status === 200, loading.status);

  section("6. STILL-SHORT LOAD RE-DERIVES THE GATE (per-stage approval)");
  const o1f = loading.body.order;
  const lr = await call("mostafa", "POST", `/api/orders/${o1f.id}/items/${o1f.items[0].id}/load`, { quantity: 92, mark_done: true });
  check("load 92 succeeds", lr.status === 200, lr.status);
  const o1g = await getOrder(o1.id);
  check("load-stage shortage re-flagged (fresh variance = fresh decision)", o1g?.shortage === true && o1g?.needsReview === false, { s: o1g?.shortage, r: o1g?.needsReview });
  const advL = await advance(o1g, "loaded", "mostafa");
  check("loaded blocked without a second approval (409)", advL.status === 409, advL.status);

  section("7. SECOND APPROVAL RELEASES THE ORDER (decision 2)");
  const o1h = await getOrder(o1.id);
  const appr2 = await call("sara", "POST", `/api/orders/${o1.id}/approve`, {
    reason: `${TAG} approved decision 2`, expected_version: o1h.version,
  });
  check("second approval succeeds", appr2.status === 200, appr2.status);
  const o1i = appr2.body?.order ?? o1h;
  check("flags cleared again", o1i?.shortage === false && o1i?.needsReview === false, { s: o1i?.shortage, r: o1i?.needsReview });
  const advLoaded = await advance(o1i, "loaded", "mostafa");
  check("order advances to loaded after second approval", advLoaded.status === 200, advLoaded.status);

  section("8. OVER-TOLERANCE SHORTAGE (85/100 = 15%) REQUIRES REVIEW AND APPROVAL");
  const o2 = await makeOrder(100);
  const r2 = await prepare(o2, 85);
  check("prepare 85/100 succeeds", r2.status === 200, r2.status);
  check("shortage flagged over tolerance", r2.body?.flags?.shortage === true, r2.body?.flags);
  check("needsReview flagged over tolerance", r2.body?.flags?.needsReview === true, r2.body?.flags);
  const o2b = await getOrder(o2.id);
  const adv2 = await advance(o2b, "ready_for_loading");
  check("over-tolerance order blocked without approval (409)", adv2.status === 409, adv2.status);
  const appr3 = await call("sara", "POST", `/api/orders/${o2.id}/approve`, {
    reason: `${TAG} approve over-tolerance`, expected_version: o2b.version,
  });
  check("over-tolerance approval succeeds", appr3.status === 200, appr3.status);

  section("9. ALTERNATE PATHS: EDIT REQUIRED QUANTITY ALSO AVOIDS THE BUG");
  const o3 = await makeOrder(100);
  const r3 = await prepare(o3, 90);
  check("prepare 90/100 succeeds", r3.status === 200, r3.status);
  const o3b = await getOrder(o3.id);
  const edit = await call("sara", "POST", `/api/orders/${o3.id}/items/${o3b.items[0].id}/required`, {
    quantity: 95, reason: `${TAG} edit reason`, expected_version: o3b.items[0].version,
  });
  check("edit required quantity succeeds (flags recomputed)", edit.status === 200, edit.status);

  section("10. RESET THRESHOLD TO DEFAULT");
  const v = (await call("admin", "GET", "/api/admin/settings")).body.settings.find(
    (s: any) => s.key === "orders.shortage_review_threshold_pct"
  )?.version;
  const reset = await call("admin", "PATCH", "/api/admin/settings/orders.shortage_review_threshold_pct", {
    value: null, reason: `${TAG} reset`, expected_version: v,
  });
  check("threshold reset to default", reset.status === 200 && reset.body?.setting?.isDefault === true, reset.body);

  finish("SHORTAGE-APPROVAL");
}

main().catch((e) => {
  console.error("CRASH:", e);
  process.exit(1);
});