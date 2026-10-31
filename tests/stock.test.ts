/* Stock module: role isolation, CRUD, derived calculations, ledger integrity,
   adjustments, concurrency, aggregation, supplier performance, audit. */
import { call, page, login, BASE, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZTEST-${Date.now()}`;
const { check, section, finish } = makeChecker();
const near = (a: number, b: number, eps = 0.0005) => Math.abs(a - b) < eps;
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); };
const isDenied = (p: { status: number; html: string }) => p.status === 200 && p.html.includes("مالكش صلاحية للصفحة دي");

async function ledgerSum(productId: string) {
  const r = await call("hossam","GET",`/api/stock/ledger?product_id=${productId}&limit=500`);
  return r.body.currentStock.find((s: any) => s.productId === productId)?.balanceKg ?? 0;
}

async function main() {
  section("1. THE STOCK ROLE");
  check("unauthenticated stock API -> 401", (await call(null,"GET","/api/stock/dashboard")).status === 401);
  let r = await login("hossam");
  check("STOCK_CONTROLLER can log in", r.status===200 && r.body?.user?.role==="STOCK_CONTROLLER", r.body);
  check("Arabic name on the role", r.body?.user?.name === "حسام");
  check("wrong password -> 401", (await call(null,"POST","/api/auth/login",{username:"hossam",password:"nope"})).status === 401);
  for (const u of ["ahmed","mostafa","sara"]) await login(u);
  check("stock user reaches /stock", (await page("hossam","/stock")).status === 200);
  check("/ redirects the stock role to /stock", ((await page("hossam","/")).location ?? "").includes("/stock"));

  section("2. RBAC ISOLATION");
  check("STOCK_CONTROLLER cannot list orders", (await call("hossam","GET","/api/orders")).status === 403);
  check("STOCK_CONTROLLER cannot create orders", (await call("hossam","POST","/api/orders",{customer_name:"X",delivery_date:today,items:[{product_name:"M",quantity:1}]})).status === 403);
  check("STOCK_CONTROLLER cannot read order audit", (await call("hossam","GET","/api/audit")).status === 403);
  check("STOCK_CONTROLLER cannot read intelligence", (await call("hossam","GET","/api/supervisor/intelligence")).status === 403);
  check("STOCK_CONTROLLER cannot read reports", (await call("hossam","GET","/api/reports/daily")).status === 403);
  check("STOCK_CONTROLLER cannot read production", (await call("hossam","GET","/api/production/daily")).status === 403);
  check("stock role denied on /prep", isDenied(await page("hossam","/prep")));
  check("PREPARER cannot read stock dashboard", (await call("ahmed","GET","/api/stock/dashboard")).status === 403);
  check("LOADER cannot record an intake", (await call("mostafa","POST","/api/stock/intakes",{supplier_id:"x",product_id:"y",received_kg:1})).status === 403);
  check("PREPARER cannot add a supplier", (await call("ahmed","POST","/api/stock/suppliers",{name:"x"})).status === 403);
  check("SUPERVISOR keeps stock oversight", (await call("sara","GET","/api/stock/dashboard")).status === 200);
  check("PREPARER denied on /stock page", isDenied(await page("ahmed","/stock")));

  section("3. SUPPLIERS & PRODUCTS");
  check("blank supplier name -> 400", (await call("hossam","POST","/api/stock/suppliers",{name:"   "})).status === 400);
  r = await call("hossam","POST","/api/stock/suppliers",{name:`${TAG} مزرعة النيل`,phone:"01000000000"});
  check("create supplier -> 201", r.status===201, r.body);
  const supA = r.body.supplier;
  check("supplier starts active, version 1", supA.active===true && supA.version===1);
  const supB = (await call("hossam","POST","/api/stock/suppliers",{name:`${TAG} مورد الوادي`})).body.supplier;
  check("duplicate supplier name -> 409", (await call("hossam","POST","/api/stock/suppliers",{name:`${TAG} مزرعة النيل`})).status === 409);

  const prodA = (await call("hossam","POST","/api/stock/products",{name:`${TAG} Mango`,unit:"KG"})).body.product;
  const prodB = (await call("hossam","POST","/api/stock/products",{name:`${TAG} Strawberry`,unit:"KG"})).body.product;
  check("products created", !!prodA?.id && !!prodB?.id, { prodA, prodB });
  check("duplicate product name -> 409", (await call("hossam","POST","/api/stock/products",{name:`${TAG} Mango`,unit:"KG"})).status === 409);
  r = await call("hossam","PATCH",`/api/stock/suppliers/${supA.id}`,{phone:"01111111111",expected_version:supA.version});
  check("update supplier", r.status===200 && r.body.supplier.phone==="01111111111");
  check("stale supplier version -> 409", (await call("hossam","PATCH",`/api/stock/suppliers/${supA.id}`,{phone:"0999",expected_version:supA.version})).status === 409);

  section("4. INTAKE VALIDATION");
  const bad = (body: any) => call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodA.id,received_date:today,...body});
  check("received_kg = 0 -> 400", (await bad({received_kg:0})).status === 400);
  check("negative received -> 400", (await bad({received_kg:-5})).status === 400);
  check("negative rejected -> 400", (await bad({received_kg:10,rejected_kg:-1})).status === 400);
  check("rejected > received -> 400", (await bad({received_kg:10,rejected_kg:11})).status === 400);
  check("negative crates -> 400", (await bad({received_kg:10,crate_count:-2})).status === 400);
  check("fractional crates -> 400", (await bad({received_kg:10,crate_count:2.5})).status === 400);
  check("bad date format -> 400", (await bad({received_kg:10,received_date:"14/09/2026"})).status === 400);
  check("unknown supplier -> 404", (await call("hossam","POST","/api/stock/intakes",{supplier_id:"nope",product_id:prodA.id,received_kg:10})).status === 404);
  check("unknown product -> 404", (await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:"nope",received_kg:10})).status === 404);
  const tmp = (await call("hossam","POST","/api/stock/products",{name:`${TAG} Paused`,unit:"KG"})).body.product;
  await call("hossam","PATCH",`/api/stock/products/${tmp.id}`,{active:false,expected_version:tmp.version});
  check("inactive product rejected on intake", (await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:tmp.id,received_kg:5})).status === 400);

  section("5. DERIVED CALCULATIONS");
  r = await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodA.id,received_date:today,received_kg:100,rejected_kg:12.5,crate_count:20,notes:"وصلت الصبح"});
  check("create intake -> 201", r.status===201, r.body);
  const in1 = r.body.intake;
  check("receipt number format", /^RC-\d{8}-\d{4}$/.test(in1.receiptNumber), in1.receiptNumber);
  check("goodKg derived server-side", near(in1.goodKg, 87.5), in1.goodKg);
  check("recordedBy captured", in1.recordedBy === "حسام");
  r = await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodA.id,received_date:today,received_kg:50,rejected_kg:10,goodKg:999,good_kg:999});
  check("client-supplied goodKg ignored", near(r.body.intake.goodKg, 40), r.body.intake.goodKg);
  const in3 = (await call("hossam","POST","/api/stock/intakes",{supplier_id:supB.id,product_id:prodB.id,received_date:today,received_kg:30,rejected_kg:0})).body.intake;
  check("zero rejected is valid", near(in3.goodKg,30));
  const in4 = (await call("hossam","POST","/api/stock/intakes",{supplier_id:supB.id,product_id:prodB.id,received_date:today,received_kg:20,rejected_kg:20})).body.intake;
  check("100% rejected adds no stock", in4.goodKg === 0);
  check("float arithmetic stays exact", near((await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodA.id,received_date:today,received_kg:0.3,rejected_kg:0.1})).body.intake.goodKg, 0.2));

  section("5b. PRODUCE GRADING (good / Grade B / waste / rejected)");
  const prodG = (await call("hossam","POST","/api/stock/products",{name:`${TAG} GradingTest`,unit:"KG"})).body.product;
  const badG = (body: any) => call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodG.id,received_date:today,...body});
  check("gradeB + waste + rejected > received -> 400", (await badG({received_kg:100,grade_b_qty:60,waste_qty:50,rejected_kg:10})).status === 400);
  const gradR = await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodG.id,received_date:today,received_kg:100,grade_b_qty:30,waste_qty:20,rejected_kg:10,unit_cost:5});
  check("graded intake -> 201", gradR.status===201, gradR.body);
  const gi = gradR.body.intake;
  check("good = received − gradeB − waste − rejected (40)", near(gi.goodKg, 40), gi.goodKg);
  check("grading splits surfaced on the intake", near(gi.gradeBQty,30) && near(gi.wasteQty,20) && near(gi.rejectedQty,10), [gi.gradeBQty, gi.wasteQty, gi.rejectedQty]);
  const gradLed = await call("hossam","GET",`/api/stock/ledger?product_id=${prodG.id}&limit=500`);
  const gm = gradLed.body.movements.filter((m: any)=>m.intakeId===gi.id);
  check("graded intake wrote good+gradeB+waste movements", gm.filter((m:any)=>m.kind==="intake").length===3, gm.map((m:any)=>[m.kind,m.quantityKg,m.locationId]));
  check("gradeB movement sits in the grade-B location", gm.some((m:any)=>m.locationId==="loc_grade_b"&&near(m.quantityKg,30)), gm.map((m:any)=>[m.locationId,m.quantityKg]));
  check("waste movement sits in the waste location at cost", gm.some((m:any)=>m.locationId==="loc_waste"&&near(m.quantityKg,20)), gm.map((m:any)=>[m.locationId,m.quantityKg]));
  check("good movement in a receiving location", gm.some((m:any)=>m.locationId!=="loc_grade_b"&&m.locationId!=="loc_waste"&&near(m.quantityKg,40)), gm.map((m:any)=>[m.locationId,m.quantityKg]));
  const waste0 = (await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodG.id,received_date:today,received_kg:100,grade_b_qty:10,rejected_kg:5})).body.intake;
  check("waste defaults to zero when omitted", near(waste0.wasteQty,0) && near(waste0.goodKg,85), [waste0.wasteQty, waste0.goodKg]);
  check("gradeB defaults to zero when omitted", near((await call("hossam","POST","/api/stock/intakes",{supplier_id:supB.id,product_id:prodG.id,received_date:today,received_kg:50,rejected_kg:0})).body.intake.gradeBQty,0));

  section("6. LEDGER INTEGRITY");
  let led = await call("hossam","GET",`/api/stock/ledger?product_id=${prodA.id}&limit=500`);
  check("intake wrote one movement", led.body.movements.filter((m: any)=>m.kind==="intake"&&m.intakeId===in1.id).length === 1);
  const m1 = led.body.movements.find((m: any)=>m.intakeId===in1.id);
  check("movement equals goodKg", near(m1.quantityKg, 87.5));
  check("movement links to the receipt", m1.intake?.receiptNumber === in1.receiptNumber);
  check("100%-rejected receipt wrote NO movement", (await call("hossam","GET",`/api/stock/ledger?product_id=${prodB.id}&limit=500`)).body.movements.filter((m: any)=>m.intakeId===in4.id).length === 0);
  const balA1 = await ledgerSum(prodA.id);
  check("balance = sum of movements", near(balA1, 87.5+40+0.2), balA1);

  check("edit without reason -> 400", (await call("hossam","PATCH",`/api/stock/intakes/${in1.id}`,{rejected_kg:20})).status === 400);
  check("edit with stale version -> 409", (await call("hossam","PATCH",`/api/stock/intakes/${in1.id}`,{rejected_kg:20,reason:"x",expected_version:99})).status === 409);
  r = await call("hossam","PATCH",`/api/stock/intakes/${in1.id}`,{rejected_kg:20,reason:"إعادة وزن بعد الفرز",expected_version:in1.version});
  check("correct a posted receipt", r.status===200 && near(r.body.intake.goodKg,80), r.body);
  led = await call("hossam","GET",`/api/stock/ledger?product_id=${prodA.id}&limit=500`);
  const corr = led.body.movements.filter((m: any)=>m.kind==="intake_correction"&&m.intakeId===in1.id);
  check("correction wrote exactly one compensating entry", corr.length===1);
  check("correction is the DELTA only", near(corr[0]?.quantityKg, -7.5), corr[0]?.quantityKg);
  check("original entry untouched", led.body.movements.some((m: any)=>m.kind==="intake"&&m.intakeId===in1.id&&near(m.quantityKg,87.5)));
  check("balance reflects the correction", near(await ledgerSum(prodA.id), balA1-7.5));

  check("void without reason -> 400", (await call("hossam","POST",`/api/stock/intakes/${in1.id}/void`,{})).status === 400);
  const beforeVoid = await ledgerSum(prodA.id);
  const curForVoid = (await call("hossam","GET",`/api/stock/intakes/${in1.id}`)).body.intake;
  r = await call("hossam","POST",`/api/stock/intakes/${in1.id}/void`,{reason:"اتسجل بالغلط",expected_version:curForVoid.version});
  check("void a receipt", r.status===200 && r.body.intake.status==="voided");
  led = await call("hossam","GET",`/api/stock/ledger?product_id=${prodA.id}&limit=500`);
  const voidMove = led.body.movements.find((m: any)=>m.kind==="intake_void"&&m.intakeId===in1.id);
  check("void wrote a reversing entry", !!voidMove);
  check("reversal equals NET contribution (87.5-7.5=80)", near(voidMove?.quantityKg, -80), voidMove?.quantityKg);
  check("balance returns to pre-receipt level", near(await ledgerSum(prodA.id), beforeVoid-80));
  check("voided receipt is not deleted", (await call("hossam","GET",`/api/stock/intakes/${in1.id}`)).status === 200);
  check("re-voiding -> 400", (await call("hossam","POST",`/api/stock/intakes/${in1.id}/void`,{reason:"تاني"})).status === 400);
  check("editing a voided receipt -> 400", (await call("hossam","PATCH",`/api/stock/intakes/${in1.id}`,{rejected_kg:5,reason:"x"})).status === 400);
  check("voided hidden from default list", !(await call("hossam","GET",`/api/stock/intakes?date=${today}`)).body.intakes.some((i: any)=>i.id===in1.id));
  check("voided visible with include_voided", (await call("hossam","GET",`/api/stock/intakes?date=${today}&include_voided=1`)).body.intakes.some((i: any)=>i.id===in1.id));

  section("7. ADJUSTMENTS");
  check("adjustment without reason -> 400", (await call("hossam","POST","/api/stock/adjustments",{product_id:prodB.id,quantity_kg:5})).status === 400);
  check("zero-quantity adjustment -> 400", (await call("hossam","POST","/api/stock/adjustments",{product_id:prodB.id,quantity_kg:0,reason:"x"})).status === 400);
  check("unknown product -> 404", (await call("hossam","POST","/api/stock/adjustments",{product_id:"nope",quantity_kg:5,reason:"x"})).status === 404);
  const balBBefore = await ledgerSum(prodB.id);
  r = await call("hossam","POST","/api/stock/adjustments",{product_id:prodB.id,quantity_kg:-4,reason:"تلف أثناء التخزين"});
  check("negative adjustment accepted", r.status===201 && near(r.body.movement.quantityKg,-4));
  check("adjustment reduces the balance", near(await ledgerSum(prodB.id), balBBefore-4));
  check("positive adjustment accepted", (await call("hossam","POST","/api/stock/adjustments",{product_id:prodB.id,quantity_kg:2.5,reason:"جرد: فرق زيادة"})).status === 201);
  check("adjustment below zero refused", (await call("hossam","POST","/api/stock/adjustments",{product_id:prodB.id,quantity_kg:-99999,reason:"محاولة"})).status === 400);
  check("balance unchanged after refusal", near(await ledgerSum(prodB.id), balBBefore-4+2.5));

  section("7b. NO PATH TO NEGATIVE STOCK");
  // Before Phase 1 only a manual adjustment was held to the zero floor; voiding or
  // correcting a receipt downward could still drive a balance negative once that
  // receipt's stock had been taken out by an adjustment.
  const prodC = (await call("hossam","POST","/api/stock/products",{name:`${TAG} Guava`,unit:"KG"})).body.product;
  const recC = (await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodC.id,received_date:today,received_kg:10,rejected_kg:0})).body.intake;
  check("receipt puts 10 kg in", near(await ledgerSum(prodC.id), 10));
  check("adjustment takes 8 kg out", (await call("hossam","POST","/api/stock/adjustments",{product_id:prodC.id,quantity_kg:-8,reason:"صرف للتجهيز"})).status === 201);
  r = await call("hossam","PATCH",`/api/stock/intakes/${recC.id}`,{received_kg:5,reason:"وزن غلط",expected_version:recC.version});
  check("downward correction below zero -> 400", r.status === 400, r.body);
  r = await call("hossam","POST",`/api/stock/intakes/${recC.id}/void`,{reason:"اتسجل بالغلط",expected_version:recC.version});
  check("void that would go negative -> 400", r.status === 400, r.body);
  check("balance untouched by the refusals", near(await ledgerSum(prodC.id), 2));
  r = await call("hossam","PATCH",`/api/stock/intakes/${recC.id}`,{received_kg:9,reason:"وزن مصحح",expected_version:recC.version});
  check("downward correction that stays >= 0 accepted", r.status === 200 && near(await ledgerSum(prodC.id), 1), r.body);
  const auditC = (await call("hossam","GET","/api/stock/audit")).body.logs.filter((l: any)=>l.entityId===recC.id && l.action==="stock_intake_updated");
  check("accepted correction audited atomically (receivedKg + goodKg rows)", auditC.length >= 2, auditC.map((l: any)=>l.fieldChanged));

  section("8. CONCURRENCY");
  const burst = await Promise.all([1,2,3,4,5].map(()=>call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodA.id,received_date:today,received_kg:10,rejected_kg:1})));
  check("5 simultaneous intakes all succeed", burst.every((b)=>b.status===201), burst.map((b)=>b.status));
  check("5 distinct receipt numbers", new Set(burst.map((b)=>b.body?.intake?.receiptNumber)).size === 5);
  const burstIds = burst.map((b)=>b.body.intake.id);
  led = await call("hossam","GET",`/api/stock/ledger?product_id=${prodA.id}&limit=500`);
  check("every concurrent intake wrote exactly one entry", burstIds.every((id)=>led.body.movements.filter((m: any)=>m.intakeId===id&&m.kind==="intake").length===1));
  const target = (await call("hossam","GET",`/api/stock/intakes/${burstIds[0]}`)).body.intake;
  const dblEdit = await Promise.all([
    call("hossam","PATCH",`/api/stock/intakes/${target.id}`,{rejected_kg:2,reason:"تصحيح أ",expected_version:target.version}),
    call("hossam","PATCH",`/api/stock/intakes/${target.id}`,{rejected_kg:3,reason:"تصحيح ب",expected_version:target.version}),
  ]);
  check("double edit: exactly one wins", dblEdit.filter((x)=>x.status===200).length===1, dblEdit.map((x)=>x.status));
  check("the loser gets 409", dblEdit.some((x)=>x.status===409));
  led = await call("hossam","GET",`/api/stock/ledger?product_id=${prodA.id}&limit=500`);
  check("double edit wrote ONE correction", led.body.movements.filter((m: any)=>m.kind==="intake_correction"&&m.intakeId===target.id).length===1);
  const target2 = (await call("hossam","GET",`/api/stock/intakes/${burstIds[1]}`)).body.intake;
  const dblVoid = await Promise.all([
    call("hossam","POST",`/api/stock/intakes/${target2.id}/void`,{reason:"إلغاء أ",expected_version:target2.version}),
    call("hossam","POST",`/api/stock/intakes/${target2.id}/void`,{reason:"إلغاء ب",expected_version:target2.version}),
  ]);
  check("double void: exactly one wins", dblVoid.filter((x)=>x.status===200).length===1, dblVoid.map((x)=>x.status));
  const balBeforeConc = await ledgerSum(prodA.id);
  const concAdj = await Promise.all([1,2,3,4,5].map(()=>call("hossam","POST","/api/stock/adjustments",{product_id:prodA.id,quantity_kg:1,reason:"تسوية متزامنة"})));
  check("5 simultaneous adjustments recorded", concAdj.every((a)=>a.status===201));
  check("no adjustment lost — balance moved by exactly +5", near(await ledgerSum(prodA.id), balBeforeConc+5));

  section("9. LEDGER IS THE ONLY SOURCE OF TRUTH");
  const dash = await call("hossam","GET",`/api/stock/dashboard?date=${today}`);
  check("dashboard 200", dash.status===200);
  const ledgerAll = await call("hossam","GET","/api/stock/ledger?limit=1000");
  for (const p of [prodA.id, prodB.id]) {
    const fromLedger = ledgerAll.body.movements.filter((m: any)=>m.productId===p).reduce((s: number,m: any)=>s+m.quantityKg,0);
    const reported = dash.body.currentStock.find((s: any)=>s.productId===p)?.balanceKg ?? 0;
    check("reported balance == sum of that product's ledger rows", near(fromLedger, reported, 0.002), { p, fromLedger, reported });
  }

  section("10. AGGREGATION");
  const todays = (await call("hossam","GET",`/api/stock/intakes?date=${today}&limit=500`)).body.intakes;
  const expReceived = todays.reduce((s: number,i: any)=>s+i.receivedKg,0);
  const expGood = todays.reduce((s: number,i: any)=>s+i.goodKg,0);
  check("today's received total matches", near(dash.body.today.receivedKg, expReceived, 0.002));
  check("today's good total matches", near(dash.body.today.goodKg, expGood, 0.002));
  check("intake count excludes voided", dash.body.today.intakeCount === todays.length);
  check("yield % = good / received", near(dash.body.today.yieldPct, Math.round((expGood/expReceived)*1000)/10, 0.11));
  check("week window is 7 days ending today", dash.body.week.from === shift(today,-6) && dash.body.week.to === today);
  check("month window starts on the 1st", dash.body.month.from === `${today.slice(0,7)}-01`);
  const oldIntake = (await call("hossam","POST","/api/stock/intakes",{supplier_id:supA.id,product_id:prodA.id,received_date:shift(today,-40),received_kg:777,rejected_kg:7})).body.intake;
  const dash2 = await call("hossam","GET",`/api/stock/dashboard?date=${today}`);
  check("a 40-day-old receipt stays out of today's total", near(dash2.body.today.receivedKg, expReceived, 0.002));
  check("...and out of the rolling week", near(dash2.body.week.receivedKg, dash.body.week.receivedKg, 0.002));
  check("...but still counts in current stock", near(await ledgerSum(prodA.id), balBeforeConc+5+770));

  section("11. SUPPLIER PERFORMANCE");
  const dash3 = await call("hossam","GET",`/api/stock/dashboard?date=${today}`);
  const perfA = dash3.body.supplierPerformance.find((p: any)=>p.supplierId===supA.id);
  check("supplier with deliveries appears", !!perfA);
  const monthFrom = `${today.slice(0,7)}-01`;
  const supAIntakes = (await call("hossam","GET",`/api/stock/intakes?from=${monthFrom}&to=${today}&supplier_id=${supA.id}&limit=500`)).body.intakes;
  check("supplier received total matches its receipts", near(perfA.receivedKg, supAIntakes.reduce((s: number,i: any)=>s+i.receivedKg,0), 0.002));
  check("supplier delivery count matches", perfA.intakeCount === supAIntakes.length);
  check("supplier yield = its good / its received", near(perfA.yieldPct, Math.round((perfA.goodKg/perfA.receivedKg)*1000)/10, 0.11));
  const empty = (await call("hossam","POST","/api/stock/suppliers",{name:`${TAG} مورد بدون توريدات`})).body.supplier;
  const dash4 = await call("hossam","GET",`/api/stock/dashboard?date=${today}`);
  check("supplier with no deliveries is absent, not 0%", !dash4.body.supplierPerformance.some((p: any)=>p.supplierId===empty.id));
  check("supplier performance sorted by volume", dash4.body.supplierPerformance.every((p: any,i: number,a: any[])=>i===0||a[i-1].receivedKg>=p.receivedKg));

  section("12. DASHBOARD SHAPE");
  const d = dash4.body;
  for (const k of ["today","week","month","currentStock","totalStockKg","recentMovements","supplierPerformance","todayByProduct","todayIntakes"]) {
    check(`dashboard includes ${k}`, d[k] !== undefined);
  }
  check("totalStockKg == sum of balances", near(d.totalStockKg, d.currentStock.reduce((s: number,p: any)=>s+p.balanceKg,0), 0.002));
  check("recent movements newest-first", d.recentMovements.every((m: any,i: number,a: any[])=>i===0||new Date(a[i-1].occurredAt)>=new Date(m.occurredAt)));
  check("todayIntakes are all today's", d.todayIntakes.every((i: any)=>i.receivedDate===today));

  section("13. AUDIT");
  const audit = await call("hossam","GET","/api/stock/audit");
  const acts = new Set(audit.body.logs.map((l: any)=>l.action));
  for (const a of ["supplier_created","product_created","stock_intake_created","stock_intake_updated","stock_intake_voided","stock_adjustment_created"]) {
    check(`audit records ${a}`, acts.has(a), [...acts]);
  }
  check("audit rows carry actor and role", audit.body.logs.every((l: any)=>l.userName&&l.role));
  check("stock audit contains no order rows", audit.body.logs.every((l: any)=>!["order","order_item"].includes(l.entityType)));
  check("PREPARER cannot read the stock audit", (await call("ahmed","GET","/api/stock/audit")).status === 403);

  section("14. PAGES RENDER");
  for (const path of ["/stock","/stock/entries","/stock/ledger","/stock/setup"]) {
    const res = await page("hossam", path);
    check(`${path} renders 200`, res.status===200, res.status);
    check(`${path} is RTL Arabic`, /dir="rtl"|dir='rtl'/.test(res.html));
  }
  check("/stock not public", [301,302,307,401,403].includes((await page(null,"/stock")).status));

  finish("STOCK MODULE");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
