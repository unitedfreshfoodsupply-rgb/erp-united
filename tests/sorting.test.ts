// Post-receipt sorting: takes raw stock from an intake and splits into
// good-grade, Grade B (separate SKU), and waste with exact reconciliation.

import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZSRT-${Date.now()}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)

export async function main() {
  await login("hossam");
  section("1. SETUP");

  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} Sup` })).body.supplier;
  const product = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Raw`, unit: "KG" })).body.product;
  const gradeBP = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} GradeB`, unit: "KG" })).body.product;

  // Receive raw produce WITHOUT grading (grade_b=0, waste=0)
  const raw = await call("hossam", "POST", "/api/stock/intakes", {
    supplier_id: sup.id, product_id: product.id, received_date: today,
    received_kg: 300, unit_cost: 10,
  });
  check("raw intake created", raw.status === 201);
  const intake = raw.body.intake;

  section("2. QUANTITY RECONCILIATION");
  // Outputs must equal input exactly — 3-dp.
  const badSum = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 200, good_kg: 100, grade_b_kg: 60, waste_kg: 30, reason: "فرز اختبار",
  });
  check("rejects unbalanced sort (100+60+30=190 ≠ 200)", badSum.status === 400);

  const badEmpty = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 0, good_kg: 0, grade_b_kg: 0, waste_kg: 0, reason: "فاضي",
  });
  check("rejects zero input_kg", badEmpty.status === 400);

  section("3. INSUFFICIENT STOCK");
  const over = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 999, good_kg: 999, grade_b_kg: 0, waste_kg: 0, reason: "أكتر من المتاح",
  });
  check("rejects sort > available balance", over.status === 400);

  section("4. SUCCESSFUL SORT WITH SEPARATE GRADE B SKU");
  const sorted = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 200, good_kg: 120, grade_b_kg: 50, waste_kg: 30,
    grade_b_product_id: gradeBP.id, reason: "فرز اليوم",
  });
  check("sort -> 201", sorted.status === 201, sorted.body?.error);
  const doc = sorted.body.document;
  check("document type is grading", doc.type === "grading");
  check("sourceType links to intake", doc.sourceType === "stock_intake");
  check("sourceId links to intake", doc.sourceId === intake.id);
  check("document has movements", doc.movements?.length >= 4);
  const out = doc.movements.find((m: any) => m.kind === "sorting_out");
  const ins = doc.movements.filter((m: any) => m.kind === "sorting_in");
  check("sorting_out exists", !!out);
  check("sorting_in count >= 3", ins.length >= 3);
  check("out quantity = 200", Math.abs(Number(out.quantity) + 200) < 0.001, out.quantity);
  // All quantities reconcile: sum of all movements = 0
  const allQty = doc.movements.reduce((s: number, m: any) => s + Number(m.quantity), 0);
  check("movements sum to zero (reconciliation)", Math.abs(allQty) < 0.001, allQty);

  // Grade B movement landed on a different product
  const gbIn = ins.find((m: any) => m.kind === "sorting_in" && m.productId === gradeBP.id);
  check("Grade B on separate product", !!gbIn, gbIn?.productId);
  check("Grade B quantity = 50", gbIn && Math.abs(Number(gbIn.quantity) - 50) < 0.001);

  // Waste movement
  const wasteIn = ins.find((m: any) => m.locationId === "loc_waste");
  check("waste at loc_waste", !!wasteIn);
  check("waste quantity = 30", wasteIn && Math.abs(Number(wasteIn.quantity) - 30) < 0.001);

  section("5. SOURCE TRACEABILITY — LEDGER");
  const led = await call("hossam", "GET", `/api/stock/ledger?product_id=${product.id}&limit=200`);
  const sortMoves = led.body.movements.filter((m: any) => m.intakeId === intake.id && (m.kind === "sorting_out" || m.kind === "sorting_in"));
  check("sorting_out in ledger", sortMoves.filter((m: any) => m.kind === "sorting_out").length >= 1);
  check("sorting_in in ledger", sortMoves.filter((m: any) => m.kind === "sorting_in").length >= 1);
  // Grade B (50kg) went to a different product, so it's absent from this product's
  // ledger. Document-level reconciliation is tested above (allQty sum to zero).

  section("6. GRADE B IS ITS OWN PRODUCT (no legacy same-product bucket)");
  // Nov 2026: a second grade kept on the first-grade product (loc_grade_b) was priced and sold
  // as first grade. A Grade B quantity now names its Grade B product, which is not the raw one.
  const intake2 = (await call("hossam", "POST", "/api/stock/intakes", {
    supplier_id: sup.id, product_id: product.id, received_date: today, received_kg: 100, unit_cost: 10,
  })).body.intake;
  const legSort = await call("hossam", "POST", `/api/stock/intakes/${intake2.id}/sort`, {
    input_kg: 80, good_kg: 50, grade_b_kg: 20, waste_kg: 10, reason: "فرز تقليدي",
  });
  check("grade B without its product -> 400", legSort.status === 400 && legSort.body?.code === "grade_b_product_required", legSort.body);
  const sameSort = await call("hossam", "POST", `/api/stock/intakes/${intake2.id}/sort`, {
    input_kg: 80, good_kg: 50, grade_b_kg: 20, waste_kg: 10, grade_b_product_id: product.id, reason: "فرز تقليدي",
  });
  check("grade B on the first-grade product itself -> 400", sameSort.status === 400 && sameSort.body?.code === "grade_b_same_product", sameSort.body);
  const graded = await call("hossam", "POST", `/api/stock/intakes/${intake2.id}/sort`, {
    input_kg: 80, good_kg: 50, grade_b_kg: 20, waste_kg: 10, grade_b_product_id: gradeBP.id, reason: "فرز",
  });
  check("graded onto the Grade B product -> 201", graded.status === 201, graded.body?.error);
  const again = await call("hossam", "POST", `/api/stock/intakes/${intake2.id}/sort`, {
    input_kg: 50, good_kg: 50, grade_b_kg: 0, waste_kg: 0, reason: "فرز تاني لنفس الكمية",
  });
  check("the same kilos are not graded twice: 80 of 100 graded, 50 more -> 400", again.status === 400 && again.body?.code === "already_graded", again.body);
  const rest = await call("hossam", "POST", `/api/stock/intakes/${intake2.id}/sort`, {
    input_kg: 20, good_kg: 15, grade_b_kg: 0, waste_kg: 5, reason: "الباقي",
  });
  check("the 20 kg left ungraded can still be graded -> 201", rest.status === 201, rest.body?.error);

  section("7. ROLLBACK ON FAILURE — ATOMICITY");
  // If a sort fails partway through, no movements should persist. Try a bad
  // sort (reconciliation fail) after a good one and verify no new movements.
  const ledgerBefore = (await call("hossam", "GET", `/api/stock/ledger?product_id=${product.id}&limit=200`));
  const countBefore = ledgerBefore.body.movements.length;
  const failRecon = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 50, good_kg: 50, grade_b_kg: 5, waste_kg: 0, reason: "خطأ في الكميات",
  });
  check("rejects unbalanced sort (50+5+0=55 ≠ 50)", failRecon.status === 400);
  const ledgerAfter = (await call("hossam", "GET", `/api/stock/ledger?product_id=${product.id}&limit=200`));
  check("no new movements after failed sort", ledgerAfter.body.movements.length === countBefore);

  finish("SORTING");
}

main().then(() => finish("SORTING")).catch((e) => { console.error(e); process.exit(1); });