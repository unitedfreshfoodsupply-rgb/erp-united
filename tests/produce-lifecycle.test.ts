// E2E produce lifecycle: receive raw produce -> sort -> verify balances,
// permissions, reconciliation, rollback, legacy grade B, idempotency.

import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZPL-${Date.now()}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)

const n = (v: any) => Number(v ?? 0);

export async function main() {
  await login("hossam");

  section("1. RECEIVE RAW PRODUCE (NO GRADING)");
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} Sup` })).body.supplier;
  const product = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Tomato`, unit: "KG" })).body.product;
  const gradeBP = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} GradeB`, unit: "KG" })).body.product;

  const raw = await call("hossam", "POST", "/api/stock/intakes", {
    supplier_id: sup.id, product_id: product.id, received_date: today,
    received_kg: 500, unit_cost: 12,
  });
  check("raw intake 201", raw.status === 201);
  const intake = raw.body.intake;
  check("goodKg = 500 (no grading)", Math.abs(intake.goodKg - 500) < 0.001, intake.goodKg);
  check("gradeBQty = 0", Math.abs(intake.gradeBQty) < 0.001);
  check("wasteQty = 0", Math.abs(intake.wasteQty) < 0.001);

  section("2. PRE-SORT LEDGER");
  const preLed = await call("hossam", "GET", `/api/stock/ledger?product_id=${product.id}&limit=200`);
  const preMoves = preLed.body.movements.filter((m: any) => m.intakeId === intake.id);
  check("intake movement in ledger", preMoves.length >= 1);
  const preSum = preMoves.reduce((s: number, m: any) => s + n(m.quantityKg ?? m.quantity), 0);
  check("pre-sort balance ~500", Math.abs(preSum - 500) < 0.01, preSum);

  section("3. SORT INTO GOOD / GRADE B / WASTE");
  const sort = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 400, good_kg: 250, grade_b_kg: 100, waste_kg: 50,
    grade_b_product_id: gradeBP.id, reason: "فرز أولي",
  });
  check("sort 201", sort.status === 201, sort.body?.error);
  const doc = sort.body.document;
  check("doc type = grading", doc.type === "grading");
  check("sourceType = stock_intake", doc.sourceType === "stock_intake");
  check("sourceId = intake.id", doc.sourceId === intake.id);
  check("reason preserved", doc.reason === "فرز أولي");

  section("4. QUANTITY RECONCILIATION");
  const moves = doc.movements;
  check(">=4 movements", moves?.length >= 4, moves?.length);
  const sumAll = moves.reduce((s: number, m: any) => s + n(m.quantity), 0);
  check("all movements sum to zero", Math.abs(sumAll) < 0.001, sumAll);

  // Movement signs
  const sortOut = moves.find((m: any) => m.kind === "sorting_out");
  const sortIns = moves.filter((m: any) => m.kind === "sorting_in");
  check("sorting_out exists", !!sortOut);
  check("sorting_out quantity < 0", n(sortOut.quantity) < 0, sortOut.quantity);
  check("3 sorting_in movements", sortIns.length === 3, sortIns.length);
  for (const si of sortIns) check("sorting_in quantity > 0", n(si.quantity) > 0, `${si.kind} ${si.quantity}`);

  // Linkage
  for (const m of moves) {
    check(`${m.kind}: intakeId`, m.intakeId === intake.id);
    check(`${m.kind}: documentId set`, !!m.documentId);
  }

  // net effect on raw product: -400 + 250 (good) + 50 (waste) = -100
  const rawOut = n(sortOut.quantity);
  const rawIn = sortIns.filter((m: any) => m.productId === product.id).reduce((s: number, m: any) => s + n(m.quantity), 0);
  check("net raw product -100", Math.abs(rawOut + rawIn + 100) < 0.01, `${rawOut} + ${rawIn} = ${rawOut + rawIn}`);

  section("5. GRADE B SEPARATE SKU");
  const gbIn = sortIns.find((m: any) => m.productId === gradeBP.id);
  check("Grade B on separate product", !!gbIn);
  check("Grade B qty = 100", gbIn && Math.abs(n(gbIn.quantity) - 100) < 0.001);
  // Grade B product ledger
  const gbLed = await call("hossam", "GET", `/api/stock/ledger?product_id=${gradeBP.id}&limit=50`);
  const gbMoves = gbLed.body.movements.filter((m: any) => m.intakeId === intake.id);
  check("grade B product has sorting_in movement", gbMoves.some((m: any) => m.kind === "sorting_in"));
  const gbSum = gbMoves.reduce((s: number, m: any) => s + n(m.quantityKg ?? m.quantity), 0);
  check("grade B balance ~100", Math.abs(gbSum - 100) < 0.01, gbSum);

  section("6. WASTE AT loc_waste");
  const wasteIn = sortIns.find((m: any) => m.locationId === "loc_waste");
  check("waste at loc_waste", !!wasteIn);
  check("waste qty = 50", wasteIn && Math.abs(n(wasteIn.quantity) - 50) < 0.001);

  section("7. POST-SORT STOCK BALANCE");
  const postLed = await call("hossam", "GET", `/api/stock/ledger?product_id=${product.id}&limit=200`);
  const postAll = postLed.body.movements.filter((m: any) => m.intakeId === intake.id);
  const totalAdj = postAll.reduce((s: number, m: any) => s + n(m.quantityKg ?? m.quantity), 0);
  // gross: +500 intake, +(-400 out) +250 good +50 waste = +400
  check("overall product stock = 400", Math.abs(totalAdj - 400) < 0.01, totalAdj);

  section("8. LEGACY GRADE B (SAME SKU, loc_grade_b)");
  const raw2 = (await call("hossam", "POST", "/api/stock/intakes", {
    supplier_id: sup.id, product_id: product.id, received_date: today, received_kg: 200, unit_cost: 10,
  })).body.intake;
  const legSort = await call("hossam", "POST", `/api/stock/intakes/${raw2.id}/sort`, {
    input_kg: 100, good_kg: 60, grade_b_kg: 30, waste_kg: 10, reason: "فرز تقليدي",
  });
  check("legacy sort 201", legSort.status === 201);
  const legDoc = legSort.body.document;
  check("legacy doc type grading", legDoc.type === "grading");
  const legGb = legDoc.movements.find((m: any) => m.kind === "sorting_in" && m.locationId === "loc_grade_b");
  check("legacy grade B at loc_grade_b", !!legGb);
  check("legacy grade B on same product", legGb?.productId === product.id);

  section("9. API VALIDATION");
  // Unauthenticated
  const noAuth = await call(null, "POST", `/api/stock/intakes/${intake.id}/sort`, { input_kg: 10, good_kg: 10, grade_b_kg: 0, waste_kg: 0, reason: "x" });
  check("unauthenticated 401", noAuth.status === 401);

  // Invalid quantity
  const badQ = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, { input_kg: "abc", good_kg: 10, grade_b_kg: 0, waste_kg: 0, reason: "x" });
  check("non-numeric input 400", badQ.status === 400);

  const negQ = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, { input_kg: 10, good_kg: -5, grade_b_kg: 0, waste_kg: 0, reason: "x" });
  check("negative good 400", negQ.status === 400);

  const zeroQ = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, { input_kg: 0, good_kg: 0, grade_b_kg: 0, waste_kg: 0, reason: "x" });
  check("zero input 400", zeroQ.status === 400);

  const noR = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, { input_kg: 10, good_kg: 10, grade_b_kg: 0, waste_kg: 0 });
  check("missing reason 400", noR.status === 400);

  section("10. IDEMPOTENCY — DUPLICATE PREVENTION");
  const idemKey = `idem-${Date.now()}`;
  const first = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 10, good_kg: 10, grade_b_kg: 0, waste_kg: 0, idempotency_key: idemKey, reason: "تكرار",
  });
  check("first idempotent 201", first.status === 201);
  const second = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 10, good_kg: 10, grade_b_kg: 0, waste_kg: 0, idempotency_key: idemKey, reason: "تكرار",
  });
  check("replay 200 (not duplicate)", second.status === 200, second.status);
  check("same document id", second.body.document?.id === first.body.document?.id);

  section("11. ROLLBACK ON FAILURE");
  const countB = (await call("hossam", "GET", `/api/stock/ledger?product_id=${product.id}&limit=500`)).body.movements.length;
  const bad = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/sort`, {
    input_kg: 30, good_kg: 30, grade_b_kg: 5, waste_kg: 0, reason: "خطأ",
  });
  check("unbalanced sort 400", bad.status === 400);
  const countA = (await call("hossam", "GET", `/api/stock/ledger?product_id=${product.id}&limit=500`)).body.movements.length;
  check("no new movements after failure", countA === countB, `${countA} vs ${countB}`);

  finish("PRODUCE-LIFECYCLE");
}

main().then(() => finish("PRODUCE-LIFECYCLE")).catch((e) => { console.error(e); process.exit(1); });