// Grade B separate SKU: intake routes Grade B output to a distinct product
// when grade_b_product_id is set, instead of the same product at loc_grade_b.

import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZGRB-${Date.now()}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)

export async function main() {
  await login("hossam");
  section("1. SETUP: products");

  // Create the main produce product (e.g. raw tomatoes)
  const mainP = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} raw`, unit: "KG" })).body.product;

  // Create the Grade B product with its own identity (separate SKU)
  const gradeBP = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} grade-b`, unit: "KG" })).body.product;

  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} Sup` })).body.supplier;

  section("2. INTAKE WITH SEPARATE GRADE B SKU");
  const r = await call("hossam", "POST", "/api/stock/intakes", {
    supplier_id: sup.id,
    product_id: mainP.id,
    received_date: today,
    received_kg: 200,
    grade_b_qty: 50,
    waste_qty: 20,
    rejected_kg: 10,
    grade_b_product_id: gradeBP.id,
    unit_cost: 8,
  });
  check("intake with separate grade B product -> 201", r.status === 201, r.body?.error);
  const intake = r.body.intake;
  if (!intake) return;
  check("goodKg = 200 − 50 − 20 − 10 = 120", Math.abs(intake.goodKg - 120) < 0.001, intake.goodKg);
  check("waste = 20", Math.abs(intake.wasteQty - 20) < 0.001);
  check("gradeB = 50", Math.abs(intake.gradeBQty - 50) < 0.001);
  check("gradeBProduct returned in response", intake.gradeBProduct?.id === gradeBP.id);

  section("3. GRADE B MOVEMENT ON SEPARATE PRODUCT");
  const led = await call("hossam", "GET", `/api/stock/ledger?product_id=${gradeBP.id}&limit=100`);
  const gbMoves = led.body.movements?.filter((m: any) => m.intakeId === intake.id) ?? [];
  check("Grade B product has 1 intake movement", gbMoves.length === 1, gbMoves.length);
  check("quantity matches gradeBQty", Math.abs(gbMoves[0]?.quantityKg - 50) < 0.001, gbMoves[0]?.quantityKg);
  check("movement links to intake", gbMoves[0]?.intakeId === intake.id);
  // Cost is stored correctly in the DB (verified via DB query: unitCost=8.0000).
  // The API redacts it for non-valuation users — not a costing defect.

  section("4. MAIN PRODUCT MOVEMENTS");
  const mainLed = await call("hossam", "GET", `/api/stock/ledger?product_id=${mainP.id}&limit=100`);
  const allMain = mainLed.body.movements?.filter((m: any) => m.intakeId === intake.id) ?? [];
  check("main product has movements for good + waste", allMain.length === 2, allMain.length);

  section("5. GRADE B WITHOUT SEPARATE PRODUCT (LEGACY MODE) — REFUSED");
  // Nov 2026: the legacy mode kept Grade B on the first-grade product at loc_grade_b, where it was
  // counted, picked and priced as first grade. A Grade B quantity now names its own product.
  const r2 = await call("hossam", "POST", "/api/stock/intakes", {
    supplier_id: sup.id,
    product_id: mainP.id,
    received_date: today,
    received_kg: 100,
    grade_b_qty: 30,
    unit_cost: 8,
  });
  check("grade B without grade_b_product_id -> 400", r2.status === 400 && r2.body?.code === "grade_b_product_required", r2.body);
  const r3 = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: mainP.id, received_date: today, received_kg: 100, grade_b_qty: 30, grade_b_product_id: mainP.id, unit_cost: 8 });
  check("grade B on the first-grade product itself -> 400", r3.status === 400 && r3.body?.code === "grade_b_same_product", r3.body);
}

main().then(() => finish("GRADE-B-SEPARATE-SKU")).catch((e) => { console.error(e); process.exit(1); });