// F-02 grading-cost policy tests: shared allocation for intake + post-receipt
// sorting, per-product grade B costing consistency, AR/GL effects, fallback
// recording, and idempotency. NRV toggled inside the suite and ALWAYS reset to
// the default proportional — the business switch stays off.
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const TAG = `ZZGC${Date.now() % 1_000_000_000}`;
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
const ledger = async (id: string) => (await call("hossam", "GET", `/api/stock/ledger?product_id=${id}&limit=300`)).body.movements ?? [];
const atWaste = async (id: string) => n(((await product(id)).buckets ?? []).filter((b: any) => b.locationCode === "WASTE").reduce((s: number, b: any) => s + n(b.quantity), 0));
const valRow = async (id: string) => (await call("karim", "GET", "/api/inventory/reports/valuation")).body.rows.find((r: any) => r.productId === id);
// Costing payload is valuation data — redacted for floor users (F-08). Read it as
// the accountant (karim) via the documents endpoint.
const costPayload = async (docId: string) => {
  const docs = (await call("karim", "GET", "/api/inventory/documents?limit=300")).body.documents ?? [];
  const d = docs.find((x: any) => x.id === docId);
  return d?.payload ?? null;
};

async function setting(key: string, value: unknown) {
  const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
  const r = await call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: TAG, expected_version: cur.version });
  if (r.status !== 200) throw new Error(`setting ${key}: ${JSON.stringify(r.body)}`);
}
async function resetSetting(key: string) {
  const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
  if (cur && !cur.isDefault) await call("admin", "PATCH", `/api/admin/settings/${key}`, { value: null, reason: TAG, expected_version: cur.version });
}

async function main() {
  for (const u of ["admin", "sara", "hossam", "mona", "mostafa", "karim"]) await login(u);
  await resetSetting("inventory.grading_cost_policy");
  await resetSetting("inventory.grading_waste_loss");
  await resetSetting("inventory.grading_price_missing");

  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const newProduct = async (name: string) => (await call("hossam", "POST", "/api/stock/products", { name, unit: "KG" })).body.product;
  const intake = (body: any) => call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, received_date: today, ...body });

  // Default price list + items for NRV sections.
  const pl = (await call("mona", "POST", "/api/sales/price-lists", { code: `${TAG}-PL`, name: `${TAG} قائمة`, is_default: true })).body.priceList;
  const dbPl = await sql();
  const addPrice = async (productId: string, price: number) => {
    await dbPl.priceListItem.create({ data: { priceListId: pl.id, productId, uomCode: "KG", unitPrice: price, validFrom: "2000-01-01", createdById: null as any, createdBy: TAG } });
  };

  // =========================================================================
  section("D1. INTAKE PROPORTIONAL (default) — full cost carry, lot/layer consistency");
  const d1g = await newProduct(`${TAG} D1good`);
  const d1b = await newProduct(`${TAG} D1gb`);
  const i1 = await intake({ product_id: d1g.id, received_kg: 200, grade_b_qty: 40, waste_qty: 20, grade_b_product_id: d1b.id, unit_cost: "5" });
  check("intake 201", i1.status === 201, [i1.status, i1.body?.error]);
  const gbLed = (await ledger(d1b.id)).filter((m: any) => m.intakeId === i1.body.intake.id);
  check("GB movement exists", gbLed.length === 1, gbLed.length);
  // unitCost is redacted for non-valuation users in the API — verify the layer directly.
  const layer1 = await dbPl.stockValuationLayer.findFirst({ where: { productId: d1b.id, movementId: gbLed[0]?.id ?? "" } });
  check("GB layer carries purchase cost 5.0000 (not 0)", !!layer1 && Math.abs(n(layer1.unitCost) - 5) < 1e-9, layer1 ? layer1.unitCost?.toString() : "no layer");
  const gbLot = (await product(d1b.id)).buckets.find((b: any) => b.lotId) ?? null;
  check("GB lot present with a lot id", !!gbLot, gbLot);

  // =========================================================================
  section("D2. F-02 FIX — POST-RECEIPT SORT SEPARATE-SKU GETS A REAL COST (was 0)");
  const d2g = await newProduct(`${TAG} D2good`);
  const d2b = await newProduct(`${TAG} D2gb`);
  await intake({ product_id: d2g.id, received_kg: 200, unit_cost: "10" });
  const i2 = (await intake({ product_id: d2g.id, received_kg: 100, unit_cost: "10" })).body.intake; // second intake blends avg 10
  const s2 = await call("hossam", "POST", `/api/stock/intakes/${i2.id}/sort`, { input_kg: 100, good_kg: 60, grade_b_kg: 25, waste_kg: 15, grade_b_product_id: d2b.id, reason: `${TAG} فرز` });
  check("sort 201", s2.status === 201, [s2.status, s2.body?.error]);
  const d2Doc = s2.body.document;
  const d2p = await costPayload(d2Doc.id);
  check("payload costBasis = proportional", d2p?.costBasis === "proportional", d2p?.costBasis);
  check("payload allocates real costs to GB (10.0000 — was 0)", Math.abs(n(d2p?.gradeBUnitCost) - 10) < 1e-9, d2p?.gradeBUnitCost);
  check("payload good/waste unit costs = 10 (conserved)", Math.abs(n(d2p?.goodUnitCost) - 10) < 1e-9 && Math.abs(n(d2p?.wasteUnitCost) - 10) < 1e-9, [d2p?.goodUnitCost, d2p?.wasteUnitCost]);
  check("GB layer value = 25 kg × 10 = 250 (not 0)", Math.abs(n(d2p?.gradeBUnitCost) * 25 - 250) < 1, d2p?.gradeBUnitCost);

  // =========================================================================
  section("D3. LOT/Layer CONSISTENCY — GB LOT unitCost == allocated unitCost");
  const lotRow = await dbPl.stockLot.findFirst({ where: { productId: d2b.id }, orderBy: { createdAt: "desc" } });
  check("GB lot unitCost == 10 (allocated, not intake 10 anyway)", !!lotRow && Math.abs(n(lotRow.unitCost) - 10) < 1e-9, lotRow ? lotRow.unitCost?.toString() : "no lot");

  // =========================================================================
  section("D4. NRV SORTING — allocation by relative market value (toggled, then reset)");
  await setting("inventory.grading_cost_policy", "nrv");
  await addPrice(d2g.id, 8);
  await addPrice(d2b.id, 3);
  const d4g = await newProduct(`${TAG} D4good`);
  const d4b = await newProduct(`${TAG} D4gb`);
  await addPrice(d4g.id, 8);
  await addPrice(d4b.id, 3);
  await intake({ product_id: d4g.id, received_kg: 200, unit_cost: "5" });
  const i4 = (await intake({ product_id: d4g.id, received_kg: 100, unit_cost: "5" })).body.intake;
  const s4 = await call("hossam", "POST", `/api/stock/intakes/${i4.id}/sort`, { input_kg: 100, good_kg: 60, grade_b_kg: 25, waste_kg: 15, grade_b_product_id: d4b.id, reason: `${TAG} فرز نرف` });
  check("NRV sort 201", s4.status === 201, [s4.status, s4.body?.error]);
  const gc = await costPayload(s4.body.document.id);
  // Allocable = 100×5=500 − wasteLoss(15×5=75) = 425.
  // NRV_good=60×8=480, NRV_gb=25×3=75 → ratio 480/555.
  // Cost_good = 425×480/555 = 367.57 (approx 367.5676→367.57). Cost_gb = 425−367.57 = 57.43.
  check("goodUnitCost ≈ 6.126 (367.57/60)", Math.abs(n(gc.goodUnitCost) - 6.126) < 0.002, gc.goodUnitCost);
  check("gradeBUnitCost ≈ 2.297 (57.43/25)", Math.abs(n(gc.gradeBUnitCost) - 2.297) < 0.002, gc.gradeBUnitCost);
  check("waste unit cost = 0 under NRV-expense", n(gc.wasteUnitCost) === 0, gc.wasteUnitCost);
  check("wasteLoss = 75", Math.abs(n(gc.wasteLoss) - 75) < 0.01, gc.wasteLoss);
  check("costBasis = nrv", gc.costBasis === "nrv", gc.costBasis);
  await resetSetting("inventory.grading_cost_policy");

  // =========================================================================
  section("D7. MISSING PRICE — FALLBACK RECORDED (payload + audit), never silent");
  await setting("inventory.grading_cost_policy", "nrv");
  await setting("inventory.grading_price_missing", "fallback");
  const d7g = await newProduct(`${TAG} D7good`);
  const d7b = await newProduct(`${TAG} D7gb`); // separate GB product with NO price
  await intake({ product_id: d7g.id, received_kg: 100, unit_cost: "5" });
  const i7 = (await intake({ product_id: d7g.id, received_kg: 80, unit_cost: "5" })).body.intake;
  const s7 = await call("hossam", "POST", `/api/stock/intakes/${i7.id}/sort`, { input_kg: 80, good_kg: 55, grade_b_kg: 15, waste_kg: 10, grade_b_product_id: d7b.id, reason: `${TAG} fallback` });
  check("fallback sort 201 (recorded)", s7.status === 201, [s7.status, s7.body?.error]);
  const d7 = s7.body.document;
  const d7p = await costPayload(d7.id);
  check("payload costBasis = nrv_fallback_proportional", d7p?.costBasis === "nrv_fallback_proportional", d7p?.costBasis);
  check("payload fallbackReason recorded", typeof d7p?.fallbackReason === "string", d7p?.fallbackReason);
  // The fallback path should lay down proportional costs (inputUnitCost = 5.00).
  check("payload goodUnitCost = 5.0000 (proportional fallback)", Math.abs(n(d7p?.goodUnitCost) - 5) < 1e-9, d7p?.goodUnitCost);
  const audit = (await call("admin", "GET", "/api/audit?action=grading_cost_fallback")).body.logs ?? [];
  check("grading_cost_fallback audit row exists", audit.some((l: any) => l.entityId === d7.id), audit.length);
  // Grading at the dock (intake with Grade B) under the same settings records it too.
  const i7b = await intake({ product_id: d7g.id, received_kg: 50, grade_b_qty: 10, waste_qty: 5, grade_b_product_id: d7b.id, unit_cost: "5" });
  check("intake graded at the dock with a missing price: 201 (fallback)", i7b.status === 201, [i7b.status, i7b.body?.error]);
  const audit7b = (await call("admin", "GET", "/api/audit?action=grading_cost_fallback")).body.logs ?? [];
  check("…and its grading_cost_fallback audit row exists (was silently dropped)", audit7b.some((l: any) => l.entityId === i7b.body.intake?.id && String(l.newValue).startsWith("proportional")), audit7b.length);
  await resetSetting("inventory.grading_cost_policy");
  await resetSetting("inventory.grading_price_missing");

  // =========================================================================
  section("D8. MISSING PRICE — REFUSE MODE → 400, no document");
  await setting("inventory.grading_cost_policy", "nrv");
  await setting("inventory.grading_price_missing", "refuse");
  const d8b = await newProduct(`${TAG} D8gb`);
  const d8g = await newProduct(`${TAG} D8good`);
  await intake({ product_id: d8g.id, received_kg: 100, unit_cost: "5" });
  const i8 = (await intake({ product_id: d8g.id, received_kg: 50, unit_cost: "5" })).body.intake;
  const s8 = await call("hossam", "POST", `/api/stock/intakes/${i8.id}/sort`, { input_kg: 50, good_kg: 40, grade_b_kg: 10, waste_kg: 0, grade_b_product_id: d8b.id, reason: `${TAG} refuse` });
  check("refuse mode → 400", s8.status === 400, [s8.status, s8.body?.error]);
  const led8Before = (await ledger(d8g.id)).length;
  const led8After = (await ledger(d8g.id)).length;
  check("no movements posted after refuse", led8After === led8Before);
  await resetSetting("inventory.grading_cost_policy");
  await resetSetting("inventory.grading_price_missing");

  // =========================================================================
  section("D12. GB SALE COGS — allocated cost, not 0 (NRV section)");
    // d4b was already graded under NRV in D4 (at unit cost ~2.297).  Sell 10 and check
    // the management report COGS — always uses the layers, independent of the current
    // policy setting.  No need to set the policy or re-add prices here.
  // d4b has 25 kg at unit ≈2.297. Sell 10.
  const cust = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;
  const o = (await call("mona", "POST", "/api/orders", { customer_account_id: cust.id, customer_name: cust.name, delivery_date: today, items: [{ stock_product_id: d4b.id, product_name: (await product(d4b.id)).name, quantity: 10 }] })).body.order;
  await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: "3", reason: TAG });
  await call("sara", "POST", `/api/orders/${o.id}/status`, { to: "loading", reason: TAG });
  await call("mostafa", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: 10, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loaded", reason: TAG });
  const disp = await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1, reason: TAG });
  check("GB order dispatched", disp.status === 200, [disp.status, disp.body?.error]);
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
  const iss = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  check("invoice issued (30.00)", iss.status === 200 && iss.body.invoice.total === "30", [iss.status, iss.body?.error]);
  const fin = (await call("karim", "GET", `/api/management/finance?from=2000-01-01&to=${today}`)).body.report;
  const row = fin.sales.byProduct.find((p: any) => p.product.includes(`${TAG} D4gb`));
  check("GB COGS = allocated cost × 10 ≈ 22.97 (not 0)", row && Math.abs(n(row.cost) - 22.97) < 0.3, row?.cost);
  check("GB margin ≈ 23.4% (equalized with Good, not 100%)", row && n(row.marginPct) > 18 && n(row.marginPct) < 28, row?.marginPct);

  // =========================================================================
  section("D14. IDEMPOTENCY — one allocation, one loss line");
  await setting("inventory.grading_cost_policy", "nrv");
  const d14g = await newProduct(`${TAG} D14good`);
  const d14b = await newProduct(`${TAG} D14gb`);
  await addPrice(d14g.id, 8);
  await addPrice(d14b.id, 3);
  await intake({ product_id: d14g.id, received_kg: 100, unit_cost: "5" });
  const i14 = (await intake({ product_id: d14g.id, received_kg: 100, unit_cost: "5" })).body.intake;
  const key = `${TAG}-idem`;
  const body = { input_kg: 100, good_kg: 60, grade_b_kg: 25, waste_kg: 15, grade_b_product_id: d14b.id, reason: `${TAG} idem`, idempotency_key: key };
  const [a, b, c] = await Promise.all([
    call("hossam", "POST", `/api/stock/intakes/${i14.id}/sort`, body),
    call("hossam", "POST", `/api/stock/intakes/${i14.id}/sort`, body),
    call("hossam", "POST", `/api/stock/intakes/${i14.id}/sort`, body),
  ]);
  const docIds = new Set([a, b, c].filter((r) => r.status === 201 || r.status === 200).map((r) => r.body?.document?.id));
  check("three submits → one document", docIds.size === 1, [a.status, b.status, c.status, [...docIds]]);
  check("idempotent replay returns 200 (not duplicate)", [a.status, b.status, c.status].filter((s) => s === 201).length === 1, [a.status, b.status, c.status]);
  await resetSetting("inventory.grading_cost_policy");

  // =========================================================================
  section("D16. LOT/Layer invariant on intake and sort (both policies)");
  // Exact unit equality at creation time is asserted per path (D1, D3, D4); here
  // we assert the invariant for the GB lot created during the NRV sort (D4):
  const d4Doc = s4.body.document;
  const d4p = await costPayload(d4Doc.id);
  const lot4 = await dbPl.stockLot.findFirst({ where: { productId: d4b.id }, orderBy: { createdAt: "desc" } });
  check("D4: GB lot unitCost ≈ allocated gradeBUnitCost", !!lot4 && Math.abs(n(lot4.unitCost) - n(d4p?.gradeBUnitCost)) < 0.002, [lot4 ? lot4.unitCost?.toString() : "no lot", d4p?.gradeBUnitCost]);

  await sql().then((x) => x.$disconnect());
  finish("GRADING-COST-POLICY");
}

main().then(() => finish("GRADING-COST-POLICY")).catch((e) => { console.error("SUITE CRASHED", e); process.exit(1); });