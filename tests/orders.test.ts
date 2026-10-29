/* Order pipeline regression: login, RBAC, creation, idempotency, concurrent numbering,
   the full lifecycle, optimistic concurrency, supervisor actions, audit, reports,
   live sync and print views. */
import { call, login, page, cookieFor, BASE, makeChecker } from "./_harness";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();

const customerCards = new Map<string, Promise<any>>();
const productCards = new Map<string, Promise<any>>();
async function customerCard(name: string) {
  let pending = customerCards.get(name);
  if (!pending) {
    pending = call("admin", "POST", "/api/sales/customers", { name }).then((r) => {
      if (r.status !== 201) throw new Error(`Could not create test customer card: ${JSON.stringify(r.body)}`);
      return r.body.customer;
    });
    customerCards.set(name, pending);
  }
  return pending;
}
async function productCard(name: string, unit = "KG") {
  const key = `${name}\u0000${unit}`;
  let pending = productCards.get(key);
  if (!pending) {
    pending = (async () => {
      const r = await call("admin", "POST", "/api/stock/products", { name, unit });
      if (r.status === 201) return r.body.product;
      const list = await call("admin", "GET", `/api/stock/products?q=${encodeURIComponent(name)}`);
      const found = list.body?.products?.find((p: any) => p.name === name && (!unit || p.unit === unit));
      if (found) return found;
      throw new Error(`Could not create test product card: ${JSON.stringify(r.body)}`);
    })();
    productCards.set(key, pending);
  }
 return pending;
}
async function manualOrder(input: any) {
  const tag = `ZZ${Date.now()}`;
  const opts = { ...input };
  if (!opts.customer_name) opts.customer_name = `${tag} تحقق`;
  const customer = await customerCard(opts.customer_name);
  const items = await Promise.all(opts.items.map(async (item: any) => {
    const product = await productCard(item.product_name, item.unit ?? "KG");
    return { ...item, stock_product_id: product.id };
  }));
  return call("sara", "POST", "/api/orders", { ...opts, customer_account_id: customer.id, items });
}

async function main() {
  section("LOGIN / SESSION");
  check("unauthenticated GET /api/orders -> 401", (await call(null,"GET","/api/orders")).status === 401);
  check("wrong password -> 401", (await call(null,"POST","/api/auth/login",{username:"sara",password:"no"})).status === 401);
  check("unknown user -> 401", (await call(null,"POST","/api/auth/login",{username:"nobody",password:"1234"})).status === 401);
  check("missing password -> 400", (await call(null,"POST","/api/auth/login",{username:"sara"})).status === 400);
  for (const [u, role] of [["ahmed","PREPARER"],["mostafa","LOADER"],["sara","SUPERVISOR"]] as const) {
    const r = await login(u);
    check(`login ${u} role=${role}`, r.status === 200 && r.body?.user?.role === role, r.body);
  }
  check("login admin for test master data", (await login("admin")).status === 200);
  check("me returns Arabic name", (await call("sara","GET","/api/auth/me")).body?.user?.name === "سارة");

  section("RBAC");
  check("PREPARER cannot create order", (await call("ahmed","POST","/api/orders",{customer_name:"X",delivery_date:"2026-09-20",items:[{product_name:"M",quantity:1}]})).status === 403);
  check("LOADER cannot create order", (await call("mostafa","POST","/api/orders",{customer_name:"X",delivery_date:"2026-09-20",items:[{product_name:"M",quantity:1}]})).status === 403);
  check("PREPARER cannot read full audit", (await call("ahmed","GET","/api/audit")).status === 403);
  check("LOADER cannot read intelligence", (await call("mostafa","GET","/api/supervisor/intelligence")).status === 403);
  check("PREPARER cannot read daily report", (await call("ahmed","GET","/api/reports/daily")).status === 403);
  check("bad n8n api key -> 401", (await call(null,"POST","/api/orders",{customer_name:"X",delivery_date:"2026-09-20",items:[]},{"x-api-key":"wrong"})).status === 401);

  section("ORDER CREATION + VALIDATION");
  check("empty customer_name -> 400", (await call("sara","POST","/api/orders",{customer_name:"",delivery_date:"2026-09-20",items:[{product_name:"M",quantity:1}]})).status === 400);
  check("missing delivery_date -> 400", (await call("sara","POST","/api/orders",{customer_name:"T",delivery_date:"",items:[{product_name:"M",quantity:1}]})).status === 400);
  check("no items -> 400", (await call("sara","POST","/api/orders",{customer_name:"T",delivery_date:"2026-09-20",items:[]})).status === 400);
  check("zero quantity -> 400", (await call("sara","POST","/api/orders",{customer_name:"T",delivery_date:"2026-09-20",items:[{product_name:"M",quantity:0}]})).status === 400);
  check("negative quantity -> 400", (await call("sara","POST","/api/orders",{customer_name:"T",delivery_date:"2026-09-20",items:[{product_name:"M",quantity:-3}]})).status === 400);
  check("non-array items -> clean 400, not a raw 500", (await call("sara","POST","/api/orders",{customer_name:"T",delivery_date:"2026-09-20",items:"not-an-array"})).status === 400);
  // Phase 1 hardening: these reached the DB CHECK constraints and came back as 500s.
  const mk = (extra: any) => manualOrder({customer_name:"ZZ تحقق",delivery_date:"2026-09-20",items:[{product_name:"M",quantity:1}],...extra});
  check("free-text delivery_date -> 400", (await mk({delivery_date:"next tuesday"})).status === 400);
  check("impossible calendar date (Feb 30) -> 400", (await mk({delivery_date:"2026-02-30"})).status === 400);
  check("unpadded date -> 400", (await mk({delivery_date:"2026-9-1"})).status === 400);
  check("bad delivery_time -> 400", (await mk({delivery_time:"25:00"})).status === 400);
  const blankTime = await mk({delivery_time:""});
  check("blank delivery_time is accepted and stored as no time", blankTime.status === 201 && blankTime.body.order.deliveryTime === null, blankTime.body);
  const badJson = await fetch(BASE + "/api/orders", { method: "POST", headers: { "content-type": "application/json", cookie: cookieFor("sara") }, body: "{oops" });
  check("malformed JSON body -> 400, not 500", badJson.status === 400, badJson.status);
  const ed = blankTime.body.order;
  check("edit: blank customer name -> 400", (await call("sara","PATCH",`/api/orders/${ed.id}`,{customer_name:"  ",reason:"x",expected_version:ed.version})).status === 400);
  check("edit: invalid delivery date -> 400", (await call("sara","PATCH",`/api/orders/${ed.id}`,{delivery_date:"2026-13-01",reason:"x",expected_version:ed.version})).status === 400);
  check("cancel test order", (await call("sara","POST",`/api/orders/${ed.id}/cancel`,{reason:"اختبار",expected_version:ed.version})).status === 200);
  check("unknown status in filter -> 400", (await call("sara","GET","/api/orders?status=garbage")).status === 400);
  check("valid multi-status filter still works", (await call("sara","GET","/api/orders?status=new,preparing")).status === 200);

  const AR_CUSTOMER = "مطعم الاختبار — فرع المعادي";
  const AR_NOTES = "ملاحظة اختبار: التسليم قبل الساعة ٩ صباحًا ✅";
  let r = await manualOrder({customer_name:AR_CUSTOMER,delivery_date:"2026-09-20",delivery_time:"09:00",notes:AR_NOTES,items:[{product_name:"مانجا عويس",quantity:12,unit:"KG"},{product_name:"Strawberry",quantity:6,unit:"KG"},{product_name:"ليمون",quantity:4,unit:"KG"}]});
  check("supervisor creates order -> 201", r.status === 201, r.body);
  const A = r.body.order;
  check("starts at new", A.status === "new");
  check("order number format", /^UN-\d{8}-\d{4}$/.test(A.orderNumber), A.orderNumber);
  check("source=manual", A.source === "manual");
  check("Arabic customer round-trips", A.customerName === AR_CUSTOMER);
  check("Arabic notes round-trip", A.notes === AR_NOTES);
  check("version starts at 1", A.version === 1);
  check("manual order items stay linked to product cards", A.items.every((i: any) => !!i.stockProductId), A.items.map((i: any) => i.stockProductId));

  section("IDEMPOTENCY");
  const key = process.env.N8N_API_KEY!;
  const EXT = `reg-${Date.now()}`;
  const p1 = await call(null,"POST","/api/orders",{external_id:EXT,source:"n8n",customer_name:"عميل n8n",delivery_date:"2026-09-21",items:[{product_name:"Fig Green",quantity:5}]},{"x-api-key":key});
  check("n8n create -> 201", p1.status === 201, p1.body);
  const N = p1.body.order;
  check("source=n8n", N.source === "n8n");
  check("duplicate external_id returns same order", (await call(null,"POST","/api/orders",{external_id:EXT,source:"n8n",customer_name:"عميل n8n",delivery_date:"2026-09-21",items:[{product_name:"Fig Green",quantity:5}]},{"x-api-key":key})).body?.order?.id === N.id);
  const p3 = await Promise.all([1,2,3,4].map(()=>call(null,"POST","/api/orders",{external_id:EXT,source:"n8n",customer_name:"عميل n8n",delivery_date:"2026-09-21",items:[{product_name:"Fig Green",quantity:5}]},{"x-api-key":key})));
  check("4 concurrent retries -> same order", p3.every((x)=>x.body?.order?.id===N.id));
  const EXT2 = `reg-cold-${Date.now()}`;
  const cold = await Promise.all([1,2,3,4,5].map(()=>call(null,"POST","/api/orders",{external_id:EXT2,source:"n8n",customer_name:"n8n سباق",delivery_date:"2026-09-28",items:[{product_name:"Mango Naomi",quantity:2}]},{"x-api-key":key})));
  check("5 simultaneous first-time retries create exactly ONE order", [...new Set(cold.map((x)=>x.body?.order?.id).filter(Boolean))].length === 1, cold.map((x)=>x.status));
  const hermes = await call(null,"POST","/api/orders",{external_id:`hermes-${Date.now()}`,source:"hermes",customer_name:"Hermes Co",delivery_date:"2026-09-21",items:[{product_name:"Banana",quantity:3}]},{"x-api-key":key});
  check("hermes source recorded", hermes.body?.order?.source === "hermes");
  check("idempotent retries -> one order_created row", (await call("sara","GET",`/api/audit?orderId=${N.id}`)).body.logs.filter((l: any)=>l.action==="order_created").length === 1);

  section("CONCURRENT ORDER NUMBERING");
  const burst = await Promise.all([1,2,3,4,5].map((i)=>manualOrder({customer_name:`Burst ${i}`,delivery_date:"2026-09-22",items:[{product_name:"Lemon",quantity:1}]})));
  check("5 concurrent creates all succeeded", burst.every((b)=>b.status===201), burst.map((b)=>b.status));
  check("5 distinct order numbers", new Set(burst.map((b)=>b.body?.order?.orderNumber)).size === 5);

  section("FULL LIFECYCLE");
  const oid = A.id;
  check("PREPARER can read order", (await call("ahmed","GET",`/api/orders/${oid}`)).status === 200);
  check("LOADER cannot start preparing", (await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"preparing"})).status === 403);
  check("PREPARER cannot skip to loading", (await call("ahmed","POST",`/api/orders/${oid}/status`,{to:"loading"})).status === 403);
  r = await call("ahmed","POST",`/api/orders/${oid}/status`,{to:"preparing",expected_version:A.version});
  check("new -> preparing", r.status===200 && r.body.order.status==="preparing", r.body);
  let ord = r.body.order;
  check("version incremented", ord.version === A.version+1);
  check("cannot load-qty while preparing", (await call("mostafa","POST",`/api/orders/${oid}/items/${A.items[0].id}/load`,{quantity:5})).status === 409);
  check("LOADER cannot set prepared qty", (await call("mostafa","POST",`/api/orders/${oid}/items/${A.items[0].id}/prepare`,{quantity:5})).status === 403);
  check("cannot mark prepared before qty", (await call("ahmed","POST",`/api/orders/${oid}/items/${A.items[0].id}/prepare`,{mark_done:true})).status === 400);
  check("cannot go ready with unprepared items", (await call("ahmed","POST",`/api/orders/${oid}/status`,{to:"ready_for_loading"})).status === 409);

  const [i1,i2,i3] = A.items;
  r = await call("ahmed","POST",`/api/orders/${oid}/items/${i1.id}/prepare`,{quantity:10,expected_version:i1.version});
  check("short qty -> shortage flagged", r.status===200 && r.body.flags.shortage===true, r.body);
  check("16.7% short -> needsReview", r.body.flags.needsReview===true);
  check("mark item prepared", (await call("ahmed","POST",`/api/orders/${oid}/items/${i1.id}/prepare`,{mark_done:true})).status === 200);
  for (const it of [i2,i3]) {
    const x = await call("ahmed","POST",`/api/orders/${oid}/items/${it.id}/prepare`,{quantity:it.requiredQuantity,mark_done:true});
    check(`prepare ${it.productName} in one call`, x.status===200 && x.body.item.preparationStatus==="done", x.body);
  }
  check("PREPARER blocked by needs_review gate", (await call("ahmed","POST",`/api/orders/${oid}/status`,{to:"ready_for_loading"})).status === 409);
  ord = (await call("sara","GET",`/api/orders/${oid}`)).body.order;
  check("LOADER cannot approve", (await call("mostafa","POST",`/api/orders/${oid}/approve`,{reason:"ok"})).status === 403);
  check("approve without reason -> 400", (await call("sara","POST",`/api/orders/${oid}/approve`,{})).status === 400);
  r = await call("sara","POST",`/api/orders/${oid}/approve`,{reason:"الفرق مقبول — نقص من المورد",expected_version:ord.version});
  check("supervisor approves shortage", r.status===200 && r.body.order.needsReview===false, r.body);
  // CRIT-2 (user spec): approval clears the live shortage gate so the order can
  // advance; the flag is re-derived from actual quantities on the next write —
  // the load-stage assertions below re-raise it when the order is still short.
  check("shortage gate cleared after approval", r.body.order.shortage===false && r.body.order.needsReview===false, { s: r.body.order.shortage, r: r.body.order.needsReview });
  ord = r.body.order;
  check("re-approving -> 400", (await call("sara","POST",`/api/orders/${oid}/approve`,{reason:"again"})).status === 400);
  r = await call("ahmed","POST",`/api/orders/${oid}/status`,{to:"ready_for_loading",expected_version:ord.version});
  check("preparing -> ready_for_loading", r.status===200, r.body); ord = r.body.order;
  check("PREPARER cannot start loading", (await call("ahmed","POST",`/api/orders/${oid}/status`,{to:"loading"})).status === 403);
  r = await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"loading",expected_version:ord.version});
  check("ready_for_loading -> loading", r.status===200, r.body); ord = r.body.order;
  check("PREPARER cannot set loaded qty", (await call("ahmed","POST",`/api/orders/${oid}/items/${i1.id}/load`,{quantity:10})).status === 403);
  const cur = (await call("sara","GET",`/api/orders/${oid}`)).body.order;
  for (const it of cur.items) {
    const x = await call("mostafa","POST",`/api/orders/${oid}/items/${it.id}/load`,{quantity:it.preparedQuantity,mark_done:true});
    check(`load ${it.productName}`, x.status===200 && x.body.item.loadingStatus==="done", x.body);
  }
  ord = (await call("sara","GET",`/api/orders/${oid}`)).body.order;
  check("load-stage shortage re-raises needs_review", ord.needsReview===true);
  check("LOADER blocked at loaded by review gate", (await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"loaded",expected_version:ord.version})).status === 409);
  r = await call("sara","POST",`/api/orders/${oid}/approve`,{reason:"اعتماد الفرق بعد التحميل",expected_version:ord.version});
  check("supervisor approves load-stage shortage", r.status===200, r.body); ord = r.body.order;
  r = await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"loaded",expected_version:ord.version});
  check("loading -> loaded", r.status===200, r.body); ord = r.body.order;
  check("dispatch without vehicle -> 400", (await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"dispatched"})).status === 400);
  check("dispatch without driver -> 400", (await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"dispatched",vehicle:"ABC-123"})).status === 400);
  check("dispatch without crates -> 400", (await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"dispatched",vehicle:"ABC-123",driver_name:"محمود"})).status === 400);
  check("dispatch crate_count=0 -> 400", (await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"dispatched",vehicle:"ABC-123",driver_name:"محمود",crate_count:0})).status === 400);
  r = await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"dispatched",vehicle:"ABC-123",driver_name:"محمود سيد",crate_count:12,expected_version:ord.version});
  check("loaded -> dispatched with manifest", r.status===200 && r.body.order.status==="dispatched", r.body);
  const dispatched = r.body.order;
  check("driver name persisted", dispatched.driverName==="محمود سيد");
  check("crate count persisted", dispatched.crateCount===12);
  check("re-dispatch -> 400", (await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"dispatched",vehicle:"X",driver_name:"Y",crate_count:1})).status === 400);

  section("OPTIMISTIC CONCURRENCY / DUPLICATE ACTIONS");
  const B = (await manualOrder({customer_name:"اختبار التزامن",delivery_date:"2026-09-23",items:[{product_name:"Mint",quantity:10},{product_name:"Lemon",quantity:5}]})).body.order;
  check("stale version on status -> 409", (await call("ahmed","POST",`/api/orders/${B.id}/status`,{to:"preparing",expected_version:999})).status === 409);
  check("correct version accepted", (await call("ahmed","POST",`/api/orders/${B.id}/status`,{to:"preparing",expected_version:B.version})).status === 200);
  const bItem = B.items[0];
  check("stale item version -> 409", (await call("ahmed","POST",`/api/orders/${B.id}/items/${bItem.id}/prepare`,{quantity:4,expected_version:999})).status === 409);
  check("fresh item version accepted", (await call("ahmed","POST",`/api/orders/${B.id}/items/${bItem.id}/prepare`,{quantity:4,expected_version:bItem.version})).status === 200);
  check("replayed item version -> 409", (await call("ahmed","POST",`/api/orders/${B.id}/items/${bItem.id}/prepare`,{quantity:6,expected_version:bItem.version})).status === 409);
  const bNow = (await call("sara","GET",`/api/orders/${B.id}`)).body.order;
  for (const it of bNow.items) await call("ahmed","POST",`/api/orders/${B.id}/items/${it.id}/prepare`,{quantity:it.requiredQuantity,mark_done:true});
  const bReady = (await call("sara","GET",`/api/orders/${B.id}`)).body.order;
  const dbl = await Promise.all([
    call("ahmed","POST",`/api/orders/${B.id}/status`,{to:"ready_for_loading",expected_version:bReady.version}),
    call("ahmed","POST",`/api/orders/${B.id}/status`,{to:"ready_for_loading",expected_version:bReady.version}),
  ]);
  check("double-submit: exactly one succeeds", dbl.filter((x)=>x.status===200).length === 1, dbl.map((x)=>x.status));
  check("double-submit wrote ONE status_changed row", (await call("sara","GET",`/api/audit?orderId=${B.id}`)).body.logs.filter((l: any)=>l.action==="status_changed"&&l.newValue==="ready_for_loading").length === 1);

  section("SUPERVISOR EDIT / OVERRIDE / CANCEL / REOPEN / CLONE");
  check("PREPARER cannot edit order", (await call("ahmed","PATCH",`/api/orders/${B.id}`,{notes:"x",reason:"x"})).status === 403);
  check("edit without reason -> 400", (await call("sara","PATCH",`/api/orders/${B.id}`,{notes:"x"})).status === 400);
  const bv = (await call("sara","GET",`/api/orders/${B.id}`)).body.order;
  r = await call("sara","PATCH",`/api/orders/${B.id}`,{notes:"تعديل",delivery_time:"14:30",reason:"طلب العميل",expected_version:bv.version});
  check("supervisor edit with reason", r.status===200 && r.body.order.deliveryTime==="14:30", r.body);
  const bi = (await call("sara","GET",`/api/orders/${B.id}`)).body.order.items[1];
  check("PREPARER cannot edit required qty", (await call("ahmed","POST",`/api/orders/${B.id}/items/${bi.id}/required`,{quantity:9,reason:"x"})).status === 403);
  r = await call("sara","POST",`/api/orders/${B.id}/items/${bi.id}/required`,{quantity:9,reason:"تصحيح",expected_version:bi.version});
  check("supervisor edits required qty", r.status===200 && r.body.item.requiredQuantity===9, r.body);
  const bo = (await call("sara","GET",`/api/orders/${B.id}`)).body.order;
  check("backwards transition without reason -> 400", (await call("sara","POST",`/api/orders/${B.id}/status`,{to:"preparing",expected_version:bo.version})).status === 400);
  r = await call("sara","POST",`/api/orders/${B.id}/status`,{to:"preparing",reason:"رجوع لتصحيح",expected_version:bo.version});
  check("override with reason", r.status===200, r.body);
  check("override logged as status_override", (await call("sara","GET",`/api/audit?orderId=${B.id}`)).body.logs.some((l: any)=>l.action==="status_override"));
  check("reopen to dispatched -> 400", (await call("sara","POST",`/api/orders/${oid}/reopen`,{to:"dispatched",reason:"x"})).status === 400);
  check("reopen to new -> 400", (await call("sara","POST",`/api/orders/${oid}/reopen`,{to:"new",reason:"x"})).status === 400);
  check("LOADER cannot reopen", (await call("mostafa","POST",`/api/orders/${oid}/reopen`,{to:"loading",reason:"x"})).status === 403);
  const dv = (await call("sara","GET",`/api/orders/${oid}`)).body.order;
  r = await call("sara","POST",`/api/orders/${oid}/reopen`,{to:"loading",reason:"تصحيح",expected_version:dv.version});
  check("supervisor reopens dispatched -> loading", r.status===200 && r.body.order.status==="loading", r.body);
  check("reopen reset loadingStatus", r.body.order.items.every((i: any)=>i.loadingStatus==="pending"));
  check("reopen kept preparationStatus", r.body.order.items.every((i: any)=>i.preparationStatus==="done"));
  const rd = (await call("sara","GET",`/api/orders/${oid}`)).body.order;
  for (const it of rd.items) await call("mostafa","POST",`/api/orders/${oid}/items/${it.id}/load`,{quantity:it.loadedQuantity??it.preparedQuantity,mark_done:true});
  let rd2 = (await call("sara","GET",`/api/orders/${oid}`)).body.order;
  if (rd2.needsReview) { await call("sara","POST",`/api/orders/${oid}/approve`,{reason:"اعتماد بعد إعادة الفتح",expected_version:rd2.version}); rd2 = (await call("sara","GET",`/api/orders/${oid}`)).body.order; }
  r = await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"loaded",expected_version:rd2.version});
  check("reopened order loads again", r.status===200, r.body);
  r = await call("mostafa","POST",`/api/orders/${oid}/status`,{to:"dispatched",vehicle:"ABC-123",driver_name:"محمود سيد",crate_count:12,expected_version:r.body.order.version});
  check("reopened order dispatches again", r.status===200, r.body);
  const C = (await manualOrder({customer_name:"أوردر للإلغاء",delivery_date:"2026-09-24",items:[{product_name:"Guava Local",quantity:2}]})).body.order;
  check("PREPARER cannot cancel", (await call("ahmed","POST",`/api/orders/${C.id}/cancel`,{reason:"x"})).status === 403);
  check("cancel without reason -> 400", (await call("sara","POST",`/api/orders/${C.id}/cancel`,{})).status === 400);
  r = await call("sara","POST",`/api/orders/${C.id}/cancel`,{reason:"العميل ألغى",expected_version:C.version});
  check("supervisor cancels", r.status===200 && r.body.order.status==="cancelled", r.body);
  check("re-cancel -> 400", (await call("sara","POST",`/api/orders/${C.id}/cancel`,{reason:"تاني"})).status === 400);
  check("cancel dispatched -> 400", (await call("sara","POST",`/api/orders/${oid}/cancel`,{reason:"بعد الخروج"})).status === 400);
  check("PREPARER cannot clone", (await call("ahmed","POST",`/api/orders/${oid}/clone`,{})).status === 403);
  r = await call("sara","POST",`/api/orders/${oid}/clone`,{delivery_date:"2026-09-25"});
  check("supervisor clones -> 201", r.status===201, r.body);
  const CL = r.body.order;
  check("clone starts new", CL.status==="new");
  check("clone version 1", CL.version===1);
  check("clone same customer", CL.customerName===AR_CUSTOMER);
  check("clone 3 items", CL.items.length===3);
  check("clone no progress", CL.items.every((i: any)=>i.preparedQuantity===null&&i.loadedQuantity===null));
  check("clone no externalId", !CL.externalId);
  check("clone audit is exactly created+cloned", (await call("sara","GET",`/api/audit?orderId=${CL.id}`)).body.logs.length===2);

  section("AUDIT / REPORTS / INTELLIGENCE / LIVE SYNC");
  const full = await call("sara","GET","/api/audit");
  check("supervisor reads full audit", full.status===200 && Array.isArray(full.body.logs));
  check("audit newest-first", full.body.logs.every((l: any,i: number,a: any[])=>i===0||new Date(a[i-1].timestamp)>=new Date(l.timestamp)));
  const oLogs = (await call("sara","GET",`/api/audit?orderId=${oid}`)).body.logs;
  const actions = new Set(oLogs.map((l: any)=>l.action));
  for (const a of ["order_created","prepared_quantity_set","item_marked_prepared","shortage_approved","status_changed","loaded_quantity_set","item_marked_loaded","order_reopened"]) {
    check(`audit contains ${a}`, actions.has(a), [...actions]);
  }
  check("Arabic approval reason stored", oLogs.filter((l: any)=>l.action==="shortage_approved").some((l: any)=>l.reason==="الفرق مقبول — نقص من المورد"));
  check("item events resolve product name and unit", oLogs.filter((l: any)=>l.entityType==="order_item").every((l: any)=>l.itemName && l.itemUnit));
  check("every row has actor+role+source", oLogs.every((l: any)=>l.userName&&l.role&&l.source));
  check("PREPARER reads single-order timeline", (await call("ahmed","GET",`/api/audit?orderId=${oid}`)).status === 200);
  const rep = await call("sara","GET","/api/reports/daily");
  check("daily report 200", rep.status===200);
  check("report health level", ["healthy","attention","critical"].includes(rep.body.health?.level));
  check("report bottleneck", Array.isArray(rep.body.bottleneck?.byStage));
  const prod = await call("ahmed","GET","/api/production/daily");
  check("production readable by PREPARER", prod.status===200 && prod.body.products.length > 0);
  const mango = prod.body.products.find((p: any)=>p.productName==="مانجا عويس");
  check("production sums Arabic product", !!mango && mango.required >= 12, mango);
  const intel = await call("sara","GET","/api/supervisor/intelligence");
  check("intelligence 200", intel.status===200);
  check("every classified order explained", intel.body.intelligence.orders.every((o: any)=>o.reason&&o.whyItMatters&&o.recommendedAction));
  check("open orders only", intel.body.intelligence.orders.every((o: any)=>!["dispatched","cancelled"].includes(o.status)));
  const E = (await manualOrder({customer_name:"أوردر استثناء",delivery_date:"2026-09-26",items:[{product_name:"Pears Local",quantity:100}]})).body.order;
  await call("ahmed","POST",`/api/orders/${E.id}/status`,{to:"preparing"});
  const eItem = (await call("sara","GET",`/api/orders/${E.id}`)).body.order.items[0];
  await call("ahmed","POST",`/api/orders/${E.id}/items/${eItem.id}/prepare`,{quantity:40});
  const eAfter = (await call("sara","GET",`/api/orders/${E.id}`)).body.order;
  check("60% short -> shortage + needsReview", eAfter.shortage===true && eAfter.needsReview===true);
  const intel2 = await call("sara","GET","/api/supervisor/intelligence");
  check("blocked_approval classification", intel2.body.intelligence.orders.find((o: any)=>o.id===E.id)?.reason==="blocked_approval");
  check("health critical when blocked", intel2.body.intelligence.health.level==="critical");
  const F = (await manualOrder({customer_name:"اختبار المزامنة",delivery_date:"2026-09-27",items:[{product_name:"Banana",quantity:8}]})).body.order;
  check("new order in PREPARER list", (await call("ahmed","GET","/api/orders?status=new")).body.orders.some((o: any)=>o.id===F.id));
  await call("ahmed","POST",`/api/orders/${F.id}/status`,{to:"preparing"});
  check("leaves 'new' bucket", !(await call("mostafa","GET","/api/orders?status=new")).body.orders.some((o: any)=>o.id===F.id));
  check("supervisor poll converged", (await call("sara","GET","/api/orders?status=preparing")).body.orders.some((o: any)=>o.id===F.id));
  check("date filter", (await call("sara","GET","/api/orders?date=2026-09-27")).body.orders.every((o: any)=>o.deliveryDate==="2026-09-27"));
  check("multi-status filter", (await call("sara","GET","/api/orders?status=new,preparing")).body.orders.every((o: any)=>["new","preparing"].includes(o.status)));

  section("BOARD WINDOW — open orders and the last 7 days, not every order ever");
  assertTestDatabase();
  const db = new PrismaClient();
  const before = await db.order.findUniqueOrThrow({ where: { id: dispatched.id }, select: { deliveryDate: true, updatedAt: true } });
  const old = new Date(Date.now() - 30 * 86_400_000);
  const oldDate = old.toISOString().slice(0, 10);
  await db.$executeRaw`UPDATE "Order" SET "updatedAt" = ${old}, "deliveryDate" = ${oldDate} WHERE "id" = ${dispatched.id}`;
  const board = (await call("sara","GET","/api/orders")).body.orders as any[];
  check("a dispatched order closed 30 days ago leaves the board", !board.some((o) => o.id === dispatched.id));
  check("…open orders stay on the board whatever their date", board.some((o) => o.status === "new" || o.status === "preparing"));
  check("…and the order is still found by its date", (await call("sara","GET",`/api/orders?date=${oldDate}`)).body.orders.some((o: any) => o.id === dispatched.id));
  const prodOrders = (await call("ahmed","GET","/api/orders?scope=production")).body.orders as any[];
  check("production drill-down leaves it out too (same scope as the totals)", !prodOrders.some((o) => o.id === dispatched.id) && prodOrders.every((o) => o.status !== "cancelled"), prodOrders.filter((o) => o.id === dispatched.id || o.status === "cancelled").map((o) => [o.orderNumber, o.status, o.deliveryDate, o.updatedAt]));
  await db.$executeRaw`UPDATE "Order" SET "updatedAt" = ${before.updatedAt}, "deliveryDate" = ${before.deliveryDate} WHERE "id" = ${dispatched.id}`;
  check("an order dispatched today is on the production record", ((await call("ahmed","GET","/api/orders?scope=production")).body.orders as any[]).some((o) => o.id === dispatched.id));
  await db.$disconnect();

  section("PRINT VIEWS");
  for (const kind of ["picking","delivery","dispatch"]) {
    const res = await fetch(`${BASE}/orders/${oid}/print/${kind}`, { headers: { cookie: cookieFor("sara") } });
    const html = await res.text();
    check(`print/${kind} 200`, res.status===200);
    check(`print/${kind} has order number`, html.includes(dispatched.orderNumber));
    check(`print/${kind} Arabic customer`, html.includes(AR_CUSTOMER.slice(0,12)));
    check(`print/${kind} RTL`, /dir="rtl"|dir='rtl'/.test(html));
  }
  const disp = await (await fetch(`${BASE}/orders/${oid}/print/dispatch`,{headers:{cookie:cookieFor("sara")}})).text();
  check("dispatch note shows driver", disp.includes("محمود سيد"));
  const pick = await (await fetch(`${BASE}/orders/${oid}/print/picking`,{headers:{cookie:cookieFor("sara")}})).text();
  check("picking shows all items", ["مانجا عويس","Strawberry","ليمون"].every((n)=>pick.includes(n)));
  check("report print renders", (await fetch(`${BASE}/supervisor/report/print`,{headers:{cookie:cookieFor("sara")}})).status === 200);
  const anon = await fetch(`${BASE}/orders/${oid}/print/picking`,{redirect:"manual"});
  check("print not public", [301,302,307,401,403].includes(anon.status), anon.status);
  const loaderDelivery = await fetch(`${BASE}/orders/${oid}/print/delivery`,{headers:{cookie:cookieFor("mostafa")}});
  check("LOADER can print the delivery/handoff sheet (holds orders.dispatch)", loaderDelivery.status === 200, loaderDelivery.status);
  const preparerDelivery = await page("ahmed", `/orders/${oid}/print/delivery`);
  check(
    "PREPARER still denied the delivery sheet (no orders.dispatch)",
    preparerDelivery.status === 200 && preparerDelivery.html.includes("مالكش صلاحية للصفحة دي")
  );

  section("LOGOUT");
  check("logout 200", (await call("mostafa","POST","/api/auth/logout",{})).status === 200);
  check("session invalid after logout", (await call("mostafa","GET","/api/orders")).status === 401);

  finish("ORDER REGRESSION");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
