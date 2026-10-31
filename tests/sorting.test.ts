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

  section("6. LEGACY GRADE B SORT (SAME PRODUCT, LOC_GRADE_B)");
  const intake2 = (await call("hossam", "POST", "/api/stock/intakes", {
    supplier_id: sup.id, product_id: product.id, received_date: today, received_kg: 100, unit_cost: 10,
  })).body.intake;
  const legSort = await call("hossam", "POST", `/api/stock/intakes/${intake2.id}/sort`, {
    input_kg: 80, good_kg: 50, grade_b_kg: 20, waste_kg: 10, reason: "فرز تقليدي",
  });
  check("legacy sort -> 201", legSort.status === 201);
  const legDoc = legSort.body.document;
  const legGbIn = legDoc.movements.find((m: any) => m.kind === "sorting_in" && m.locationId === "loc_grade_b");
  check("legacy Grade B at loc_grade_b", !!legGbIn);
  check("legacy Grade B on same product", legGbIn?.productId === product.id);

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