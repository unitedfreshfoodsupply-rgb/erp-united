/* Picking sheet — consolidated daily production sheet end to end. Tests the
   server-side aggregation, authorization, date filtering, status filtering,
   and total reconciliation against the underlying order lines. */
import { call, login, makeChecker } from "./_harness";

const { check, section, finish } = makeChecker();
const TAG = `ZZSHEET${Date.now()}`;
// Unique run-specific date so leftover data never interferes
const runTag = Date.now() % 10000;
const today = `2099-12-${String(1 + (runTag % 28)).padStart(2, "0")}`; // zero-padded: the API accepts only YYYY-MM-DD
const emptyDate = `2098-11-15`;
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mona", "karim", "mostafa"]) await login(u);

  // -----------------------------------------------------------------------
  section("SETUP");
  const tomato = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} طماطم`, unit: "KG" })).body.product;
  const onion = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} بصل`, unit: "KG" })).body.product;
  const sup = (await call("admin", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  await call("admin", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: tomato.id, received_kg: 500, unit_cost: "5" });
  await call("admin", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: onion.id, received_kg: 300, unit_cost: "3" });
  const hotel = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} فندق` })).body.customer;
  const cafe = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} كافيه` })).body.customer;

  // -----------------------------------------------------------------------
  section("1. AUTH");
  r = await call(null, "GET", `/api/production/daily/sheet?date=${today}`);
  check("anon 401", r.status === 401, r.status);
  r = await call("karim", "GET", `/api/production/daily/sheet?date=${today}`);
  check("accountant 200", r.status === 200, r.status);

  // -----------------------------------------------------------------------
  section("2. EMPTY DATE");
  r = await call("sara", "GET", `/api/production/daily/sheet?date=${emptyDate}`);
  check("no orders", r.status === 200 && r.body.lines.length === 0, r.body.lines?.length);

  // -----------------------------------------------------------------------
  section("3. CREATE ORDERS: hotel(100T+40O), cafe(50T)");
  const ho = (await call("mona", "POST", "/api/orders", {
    customer_account_id: hotel.id, customer_name: hotel.name, delivery_date: today,
    items: [
      { stock_product_id: tomato.id, product_name: `${TAG} طماطم`, quantity: 100 },
      { stock_product_id: onion.id, product_name: `${TAG} بصل`, quantity: 40 },
    ],
  })).body.order;
  const hTom = ho.items.find((i: any) => i.stockProductId === tomato.id)!;
  const hOn = ho.items.find((i: any) => i.stockProductId === onion.id)!;

  const co = (await call("mona", "POST", "/api/orders", {
    customer_account_id: cafe.id, customer_name: cafe.name, delivery_date: today,
    items: [
      { stock_product_id: tomato.id, product_name: `${TAG} طماطم`, quantity: 50 },
    ],
  })).body.order;
  const cTom = co.items.find((i: any) => i.stockProductId === tomato.id)!;

  // Price
  await call("mona", "PATCH", `/api/orders/${ho.id}/items/${hTom.id}/price`, { unit_price: "12", reason: "عقد" });
  await call("mona", "PATCH", `/api/orders/${co.id}/items/${cTom.id}/price`, { unit_price: "9", reason: "حسم" });

  // -----------------------------------------------------------------------
  section("4. SHEET: structure + totals before prep");
  r = await call("sara", "GET", `/api/production/daily/sheet?date=${today}`);
  check("200", r.status === 200, r.status);
  const s = r.body;
  const tLine = s.lines.find((l: any) => l.productName === `${TAG} طماطم`);
  const oLine = s.lines.find((l: any) => l.productName === `${TAG} بصل`);
  check("tomato line", !!tLine, !!tLine);
  check("onion line", !!oLine, !!oLine);
  check("tomato total=150", tLine?.totalRequired === 150, tLine?.totalRequired);
  check("onion total=40", oLine?.totalRequired === 40, oLine?.totalRequired);
  check("tomato 2 customers", tLine?.allocations?.length === 2, tLine?.allocations?.length);
  check("onion 1 customer", oLine?.allocations?.length === 1, oLine?.allocations?.length);
  check("hotel tomato=100", tLine?.allocations.find((a: any) => a.customerName === hotel.name)?.requiredQuantity === 100);
  check("cafe tomato=50", tLine?.allocations.find((a: any) => a.customerName === cafe.name)?.requiredQuantity === 50);
  check("alloc sum = total", tLine?.allocations.reduce((s: number, a: any) => s + a.requiredQuantity, 0) === tLine?.totalRequired);
  check("summary=190", s.summary.totalRequired === 190, s.summary);
  check("prepared=0", s.summary.totalPrepared === 0, s.summary.totalPrepared);
  check("remaining=190", s.summary.totalRemaining === 190, s.summary.totalRemaining);

  // -----------------------------------------------------------------------
  section("5. PREPARE exactly (no shortage), re-check sheet");
  await call("sara", "POST", `/api/orders/${ho.id}/status`, { to: "preparing" });
  await call("sara", "POST", `/api/orders/${co.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${ho.id}/items/${hTom.id}/prepare`, { quantity: 100, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${ho.id}/items/${hOn.id}/prepare`, { quantity: 40, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${co.id}/items/${cTom.id}/prepare`, { quantity: 50, mark_done: true });

  r = await call("sara", "GET", `/api/production/daily/sheet?date=${today}`);
  const s1 = r.body;
  const t1 = s1.lines.find((l: any) => l.productName === `${TAG} طماطم`);
  const o1 = s1.lines.find((l: any) => l.productName === `${TAG} بصل`);
  check("tomato prepared=150", t1?.totalPrepared === 150, t1?.totalPrepared);
  check("onion prepared=40", o1?.totalPrepared === 40, o1?.totalPrepared);
  check("summary prepared=190", s1.summary.totalPrepared === 190, s1.summary.totalPrepared);

  // -----------------------------------------------------------------------
  section("6. CANCELLED excluded");
  const xo = (await call("mona", "POST", "/api/orders", {
    customer_account_id: hotel.id, customer_name: hotel.name, delivery_date: today,
    items: [{ stock_product_id: tomato.id, product_name: `${TAG} طماطم`, quantity: 30 }],
  })).body.order;
  await call("mona", "PATCH", `/api/orders/${xo.id}/items/${xo.items[0].id}/price`, { unit_price: "10", reason: "x" });
  await call("sara", "POST", `/api/orders/${xo.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${xo.id}/items/${xo.items[0].id}/prepare`, { quantity: 30, mark_done: true });
  await call("sara", "POST", `/api/orders/${xo.id}/cancel`, { reason: "ألغى" });

  r = await call("sara", "GET", `/api/production/daily/sheet?date=${today}`);
  const s2 = r.body;
  const t2 = s2.lines.find((l: any) => l.productName === `${TAG} طماطم`);
  check("cancelled excluded: 150 not 180", t2?.totalRequired === 150, t2?.totalRequired);
  check("2 customers (not 3)", t2?.allocations?.length === 2, t2?.allocations?.length);
  check("summary=190", s2.summary.totalRequired === 190, s2.summary);

  // -----------------------------------------------------------------------
  section("7. DISPATCHED excluded");
  // Advance hotel through full workflow (exact quantities, no shortage)
  await call("sara", "POST", `/api/orders/${ho.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${ho.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${ho.id}/items/${hTom.id}/load`, { quantity: 100, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${ho.id}/items/${hOn.id}/load`, { quantity: 40, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${ho.id}/status`, { to: "loaded" });
  r = await call("mostafa", "POST", `/api/orders/${ho.id}/status`, { to: "dispatched", vehicle: "ميني باص", driver_name: "سعيد", crate_count: 5 });
  check("dispatched", r.status === 200, r.status);

  r = await call("sara", "GET", `/api/production/daily/sheet?date=${today}`);
  const s3 = r.body;
  const o3 = s3.lines.find((l: any) => l.productName === `${TAG} بصل`);
  const t3 = s3.lines.find((l: any) => l.productName === `${TAG} طماطم`);
  check("onion gone (dispatched)", !o3, !!o3);
  check("cafe only: 50", t3?.totalRequired === 50, t3?.totalRequired);
  check("summary=50", s3.summary.totalRequired === 50, s3.summary);

  // -----------------------------------------------------------------------
  section("8. DIFFERENT product = separate line");
  const crate = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} كراتين`, unit: "KG" })).body.product;
  await call("admin", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: crate.id, received_kg: 20, unit_cost: "1" });
  const crateOrder = (await call("mona", "POST", "/api/orders", {
    customer_account_id: hotel.id, customer_name: hotel.name, delivery_date: today,
    items: [{ stock_product_id: crate.id, product_name: `${TAG} كراتين`, quantity: 5 }],
  })).body.order;
  await call("mona", "PATCH", `/api/orders/${crateOrder.id}/items/${crateOrder.items[0].id}/price`, { unit_price: "15", reason: "ت" });
  await call("sara", "POST", `/api/orders/${crateOrder.id}/status`, { to: "preparing" });

  r = await call("sara", "GET", `/api/production/daily/sheet?date=${today}`);
  const s4 = r.body;
  const crateLine = s4.lines.find((l: any) => l.productName === `${TAG} كراتين`);
  check("crate line exists", !!crateLine, !!crateLine);
  check("crate=5", crateLine?.totalRequired === 5, crateLine?.totalRequired);
  check("orderCount=2 (cafe+crate)", s4.summary.orderCount === 2, s4.summary.orderCount);

  finish("PICKING-SHEET");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });