// F-08 — grading UI acceptance: the exact contract the GradingForm sends, strict
// conservation + availability validation, duplicate-submit protection, RBAC
// (403 for floor roles) and cost-redaction (payload costs null for non-valuation
// users, visible to the accountant), and the cold-chain waste path (F-20).
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const TAG = `ZZUI${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
const n = (v: any) => Number(v ?? 0);

let db: PrismaClient | null = null;
async function sql() {
  if (!db) { assertTestDatabase(); db = new PrismaClient(); }
  return db;
}

const ledger = async (id: string) => (await call("hossam", "GET", `/api/stock/ledger?product_id=${id}&limit=300`)).body.movements ?? [];
const docs = async (actor: string, type = "grading") => (await call(actor, "GET", `/api/inventory/documents?type=${type}&limit=300`)).body.documents ?? [];
const product = async (id: string) => (await call("karim", "GET", `/api/inventory/products/${id}`)).body;
const atWaste = async (id: string) => n((((await product(id)).buckets) ?? []).filter((b: any) => b.locationCode === "WASTE").reduce((s: number, b: any) => s + n(b.quantity), 0));

async function main() {
  for (const u of ["admin", "sara", "hossam", "mona", "mostafa", "ahmed", "karim"]) await login(u);

  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const newProduct = async (name: string) => (await call("hossam", "POST", "/api/stock/products", { name, unit: "KG" })).body.product;
  const intake = (body: any) => call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, received_date: today, ...body });

  // =========================================================================
  section("A1. UI CONTRACT — the exact GradingForm payload → document + 4 movements");
  const a1g = await newProduct(`${TAG} A1good`);
  const a1b = await newProduct(`${TAG} A1gb`);
  await intake({ product_id: a1g.id, received_kg: 300, unit_cost: "4" });
  const i1 = (await intake({ product_id: a1g.id, received_kg: 200, unit_cost: "4" })).body.intake;
  const key1 = `${TAG}-a1`;
  const body1 = {
    input_kg: 200, good_kg: 140, grade_b_kg: 35, waste_kg: 25,
    grade_b_product_id: a1b.id, reason: `${TAG} فرز يومي`, business_date: today, idempotency_key: key1,
  };
  const r1 = await call("hossam", "POST", `/api/stock/intakes/${i1.id}/sort`, body1);
  check("UI payload → 201", r1.status === 201, [r1.status, r1.body?.error]);
  const d1 = r1.body.document;
  check("document posted + typed", d1.type === "grading" && d1.status === "posted", [d1.type, d1.status]);
  check("document number present", typeof d1.number === "string" && d1.number.length > 0, d1.number);
  check("4 movements (out + in×3)", d1.movements.length === 4, d1.movements.length);
  const kinds = d1.movements.map((m: any) => m.kind).sort();
  check("kinds = sorting_out + 3× sorting_in", kinds.join(",") === "sorting_in,sorting_in,sorting_in,sorting_out", kinds);
  // Signed conservation: out −200, in +140+35+25 → net 0 at the bucket level.
  const net = d1.movements.reduce((s: number, m: any) => s + n(m.quantity), 0);
  check("net quantity = 0 (conserved)", Math.abs(net) < 1e-9, net);
  // Remaining after the sort: the good (140) returned to the intake's own bucket and
  // is still sortable there; the waste left for the WASTE bucket (not sortable).
  const rem1 = (await ledger(a1g.id)).filter((m: any) => m.intakeId === i1.id && m.location?.code !== "WASTE").reduce((s: number, m: any) => s + n(m.quantityKg), 0);
  check("remaining of this receipt = 140 kg (good back in bucket)", Math.abs(rem1 - 140) < 1e-9, rem1);

  // =========================================================================
  section("A2. STRICT VALIDATION — unbalanced / oversize refused, nothing posted");
  const a2g = await newProduct(`${TAG} A2good`);
  await intake({ product_id: a2g.id, received_kg: 100, unit_cost: "4" });
  const i2 = (await intake({ product_id: a2g.id, received_kg: 80, unit_cost: "4" })).body.intake;
  const before2 = (await ledger(a2g.id)).length;
  const rBad = await call("hossam", "POST", `/api/stock/intakes/${i2.id}/sort`, { input_kg: 80, good_kg: 60, grade_b_kg: 5, waste_kg: 10, reason: `${TAG} mismatch` }); // 60+5+10=75 ≠ 80
  check("unbalanced → 400", rBad.status === 400, [rBad.status, rBad.body?.error]);
  const after2 = (await ledger(a2g.id)).length;
  check("no movements posted after rejection", after2 === before2, [before2, after2]);
  const docs2 = (await docs("hossam")).filter((d: any) => d.reason?.includes(`${TAG} mismatch`));
  check("no document for rejected input", docs2.length === 0, docs2.length);
  const rBig = await call("hossam", "POST", `/api/stock/intakes/${i2.id}/sort`, { input_kg: 100, good_kg: 100, grade_b_kg: 0, waste_kg: 0, reason: `${TAG} oversize` }); // 100 > 80 remaining
  check("input > remaining → 400", rBig.status === 400, [rBig.status, rBig.body?.error]);
  const rZero = await call("hossam", "POST", `/api/stock/intakes/${i2.id}/sort`, { input_kg: 0, good_kg: 0, grade_b_kg: 0, waste_kg: 0, reason: `${TAG} zero` });
  check("zero input → 400", rZero.status === 400, [rZero.status, rZero.body?.error]);
  const rNoReason = await call("hossam", "POST", `/api/stock/intakes/${i2.id}/sort`, { input_kg: 10, good_kg: 10, grade_b_kg: 0, waste_kg: 0 });
  check("missing reason → 400", rNoReason.status === 400, [rNoReason.status, rNoReason.body?.error]);

  // =========================================================================
  section("A4. IDEMPOTENCY — double submit (the UI retry path) → one document");
  const a4g = await newProduct(`${TAG} A4good`);
  await intake({ product_id: a4g.id, received_kg: 120, unit_cost: "4" });
  const i4 = (await intake({ product_id: a4g.id, received_kg: 60, unit_cost: "4" })).body.intake;
  const key4 = `${TAG}-idem`;
  const body4 = { input_kg: 60, good_kg: 45, grade_b_kg: 0, waste_kg: 15, reason: `${TAG} idem`, idempotency_key: key4 };
  const [p1, p2, p3] = await Promise.all([
    call("hossam", "POST", `/api/stock/intakes/${i4.id}/sort`, body4),
    call("hossam", "POST", `/api/stock/intakes/${i4.id}/sort`, body4),
    call("hossam", "POST", `/api/stock/intakes/${i4.id}/sort`, body4),
  ]);
  const ids = new Set([p1, p2, p3].filter((r: any) => r.status === 201 || r.status === 200).map((r: any) => r.body?.document?.id));
  check("three submits → one document id", ids.size === 1, [p1.status, p2.status, p3.status, [...ids]]);
  // With 3 concurrent submits and one idempotency key, exactly 1 receives 201
  // (first to commit); the other 2 receive 200 (idempotent replay). The order
  // is non‑deterministic (Promise.all racing), so we assert the set, not positions.
  const statuses = [p1.status, p2.status, p3.status];
  const created = statuses.filter((s) => s === 201).length;
  const replayed = statuses.filter((s) => s === 200).length;
  check(`first 201, replays 200 (created=${created} replayed=${replayed})`, created === 1 && replayed === 2, statuses);
  const a4Moves = (await ledger(a4g.id)).filter((m: any) => m.intakeId === i4.id && m.kind === "sorting_out");
  check("exactly one sorting_out (no duplicate post)", a4Moves.length === 1, a4Moves.length);

  // =========================================================================
  section("A5. RBAC — floor roles cannot sort; costs redacted for non-valuation");
  const a5g = await newProduct(`${TAG} A5good`);
  const a5b = await newProduct(`${TAG} A5gb`);
  const i5 = (await intake({ product_id: a5g.id, received_kg: 100, unit_cost: "6" })).body.intake;
  const floor = await call("mostafa", "POST", `/api/stock/intakes/${i5.id}/sort`, { input_kg: 100, good_kg: 80, grade_b_kg: 10, waste_kg: 10, grade_b_product_id: a5b.id, reason: `${TAG} floor` });
  check("LOADER → 403", floor.status === 403, [floor.status, floor.body?.error]);
  const prep = await call("ahmed", "POST", `/api/stock/intakes/${i5.id}/sort`, { input_kg: 100, good_kg: 80, grade_b_kg: 10, waste_kg: 10, grade_b_product_id: a5b.id, reason: `${TAG} floor` });
  check("PREPARER → 403", prep.status === 403, [prep.status, prep.body?.error]);
  // Controller sorts; his OWN response must have cost redaction applied.
  const r5 = await call("hossam", "POST", `/api/stock/intakes/${i5.id}/sort`, { input_kg: 100, good_kg: 80, grade_b_kg: 10, waste_kg: 10, grade_b_product_id: a5b.id, reason: `${TAG} ctrl` });
  check("STOCK_CONTROLLER sorts → 201", r5.status === 201, [r5.status, r5.body?.error]);
  const d5 = r5.body.document;
  check("controller's own payload hides cost values (null)", d5.payload?.goodUnitCost === null && d5.payload?.wasteLoss === null, [d5.payload?.goodUnitCost, d5.payload?.wasteLoss]);
  check("movement unitCost redacted for controller", d5.movements.every((m: any) => m.unitCost === null), d5.movements.map((m: any) => m.unitCost));
  // The same document read by the accountant shows the costs.
  const d5karim = (await docs("karim")).find((d: any) => d.id === d5.id);
  check("accountant sees payload costs", d5karim?.payload?.goodUnitCost != null && Math.abs(n(d5karim.payload.goodUnitCost) - 6) < 1e-9, d5karim?.payload?.goodUnitCost);
  check("accountant sees movement costs", (d5karim?.movements ?? []).some((m: any) => m.unitCost != null), (d5karim?.movements ?? []).map((m: any) => m.unitCost));
  // Floor user reading the documents list still sees no costs (hossam has stock.view
  // but not valuation; mostafa lacks stock.view entirely — 403 is covered by UAT).
  const d5floor = (await docs("hossam")).find((d: any) => d.id === d5.id);
  check("non-valuation user sees no costs via documents API", d5floor?.payload?.goodUnitCost === null && (d5floor?.movements ?? []).every((m: any) => m.unitCost === null), [d5floor?.payload?.goodUnitCost, (d5floor?.movements ?? []).map((m: any) => m.unitCost)]);

  // =========================================================================
  section("A6. COLD CHAIN — cold-chain product waste sort works (F-20/F-08)");
  const a6g = await newProduct(`${TAG} A6cold`);
  const p6 = await sql();
  await p6.stockProduct.update({ where: { id: a6g.id }, data: { coldChain: true } });
  const i6 = (await intake({ product_id: a6g.id, received_kg: 80, unit_cost: "7" })).body.intake;
  const r6 = await call("hossam", "POST", `/api/stock/intakes/${i6.id}/sort`, { input_kg: 80, good_kg: 60, grade_b_kg: 0, waste_kg: 20, reason: `${TAG} cold waste` });
  check("cold-chain waste sort → 201", r6.status === 201, [r6.status, r6.body?.error]);
  const wasteMove = r6.body.document.movements.find((m: any) => m.location?.code === "WASTE");
  check("waste movement at WASTE location (+20)", wasteMove && Math.abs(n(wasteMove.quantity) - 20) < 1e-9, wasteMove ? n(wasteMove.quantity) : "no WASTE move");
  check("waste on hand at WASTE = 20", Math.abs((await atWaste(a6g.id)) - 20) < 1e-9, await atWaste(a6g.id));

  // =========================================================================
  section("A5b. INTAKE-TIME GRADING FIELDS (Screen 1 contract)");
  const a7g = await newProduct(`${TAG} A7good`);
  const a7b = await newProduct(`${TAG} A7gb`);
  const r7 = await intake({ product_id: a7g.id, received_kg: 200, rejected_kg: 10, grade_b_qty: 30, waste_qty: 20, grade_b_product_id: a7b.id, unit_cost: "5", rejection_reason: `${TAG} جودة` });
  check("intake with grading fields → 201", r7.status === 201, [r7.status, r7.body?.error]);
  const intake7 = r7.body.intake;
  check("good = 200−10−30−20 = 140", Math.abs(n(intake7.goodKg) - 140) < 1e-9, intake7.goodKg);
  check("gradeBQty serialized", Math.abs(n(intake7.gradeBQty) - 30) < 1e-9, intake7.gradeBQty);
  check("wasteQty serialized", Math.abs(n(intake7.wasteQty) - 20) < 1e-9, intake7.wasteQty);
  check("gradeBProduct linked", intake7.gradeBProduct?.id === a7b.id, intake7.gradeBProduct?.id);
  // GB and waste buckets exist for the separate product? No — waste stays on the raw product at loc_waste; GB goes to its own product.
  const waste7 = (await ledger(a7g.id)).filter((m: any) => m.intakeId === intake7.id && m.location?.code === "WASTE");
  check("waste movement → WASTE", waste7.length === 1 && Math.abs(n(waste7[0].quantityKg) - 20) < 1e-9, waste7.map((m: any) => [m.location?.code, m.quantityKg]));
  const gb7 = (await ledger(a7b.id)).filter((m: any) => m.intakeId === intake7.id);
  check("GB movement on its own product (+30)", gb7.length === 1 && Math.abs(n(gb7[0].quantityKg) - 30) < 1e-9, gb7.map((m: any) => [m.productId, m.quantityKg]));

  await sql().then((x) => x.$disconnect());
  finish("GRADING-UI");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(1); });