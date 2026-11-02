/* Operations end to end: fleet, a trip carrying two orders through preparation,
   loading, dispatch and delivery; the delivery result driving returns, exceptions and
   the invoice; and the guards — double loading, not-ready loading, dispatch around the
   trip, idempotent POD, prices never on the floor. */
import { call, login, makeChecker } from "./_harness";

const { check, section, finish } = makeChecker();
const TAG = `ZZOPS${Date.now() % 1_000_000_000}`;
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim"]) await login(u);
  const priceKeys = (o: unknown): string[] => JSON.stringify(o).match(/"(unitPrice|unitCost|net|total|gross|amounts|creditLimit|exposure)":/g) ?? [];

  section("1. FLEET");
  check("stock controller cannot add vehicles -> 403", (await call("hossam", "POST", "/api/operations/vehicles", { code: `${TAG}V`, plate: `${TAG}P` })).status === 403);
  r = await call("sara", "POST", "/api/operations/vehicles", { code: `${TAG}-V1`, plate: `ن ق ${TAG}`, type: "truck", capacity_kg: 500, refrigerated: true });
  check("supervisor adds a refrigerated truck (500 kg)", r.status === 201 && r.body.vehicle.refrigerated === true, r.body);
  const truck = r.body.vehicle;
  check("same plate again -> 409", (await call("sara", "POST", "/api/operations/vehicles", { code: `${TAG}-V2`, plate: `ن ق ${TAG}` })).status === 409);
  const driver = (await call("sara", "POST", "/api/operations/drivers", { name: `${TAG} عم سيد`, phone: "0100" })).body.driver;
  const idle = (await call("sara", "POST", "/api/operations/drivers", { name: `${TAG} موقوف` })).body.driver;
  await call("sara", "PATCH", `/api/operations/drivers/${idle.id}`, { name: idle.name, active: false });
  check("the floor reads the fleet", (await call("mostafa", "GET", "/api/operations/fleet")).body.vehicles?.some((v: any) => v.id === truck.id));

  // Products in stock, a customer, priced orders.
  const supplier = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const tomato = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Tomato`, unit: "KG" })).body.product;
  const cucumber = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Cucumber`, unit: "KG" })).body.product;
  for (const p of [tomato, cucumber]) await call("hossam", "POST", "/api/stock/intakes", { supplier_id: supplier.id, product_id: p.id, received_kg: 1000, unit_cost: "5" });
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} فندق النيل` })).body.customer;
  const products = new Map([[tomato.name, tomato], [cucumber.name, cucumber]]);
  const order = async (items: { product_name: string; quantity: number }[]) => {
    const o = (await call("sara", "POST", "/api/orders", { customer_account_id: customer.id, customer_name: customer.name, delivery_date: "2026-12-15", items: items.map((i) => ({ ...i, stock_product_id: products.get(i.product_name)?.id })) })).body.order;
    for (const i of o.items) await call("mona", "PATCH", `/api/orders/${o.id}/items/${i.id}/price`, { unit_price: i.productName.includes("Tomato") ? "12" : "8", reason: "سعر العقد" });
    return o;
  };
  const A = await order([{ product_name: `${TAG} Tomato`, quantity: 100 }, { product_name: `${TAG} Cucumber`, quantity: 50 }]);
  const B = await order([{ product_name: `${TAG} Tomato`, quantity: 80 }]);
  const C = await order([{ product_name: `${TAG} Tomato`, quantity: 400 }]);
  const Dd = await order([{ product_name: `${TAG} Cucumber`, quantity: 200 }]);
  check("orders are mapped to stock products", A.items.every((i: any) => i.stockProductId));

  section("2. PLANNING A TRIP");
  const plan = (order_ids: string[], extra: Record<string, unknown> = {}) => call("sara", "POST", "/api/operations/trips", { trip_date: "2026-12-15", vehicle_id: truck.id, driver_id: driver.id, order_ids, ...extra });
  check("the preparer cannot plan trips -> 403", (await call("ahmed", "POST", "/api/operations/trips", { vehicle_id: truck.id, driver_id: driver.id, order_ids: [A.id] })).status === 403);
  check("an inactive driver -> 400", (await plan([A.id], { driver_id: idle.id })).status === 400);
  check("over the truck's capacity (400 + 200 kg > 500) -> 409", (await plan([C.id, Dd.id])).status === 409);
  r = await plan([A.id, B.id]);
  check("trip with A then B -> 201", r.status === 201 && /^TRP-\d{4}-\d{5}$/.test(r.body.trip.number) && r.body.trip.stops.map((s: any) => s.orderId).join() === [A.id, B.id].join(), r.body);
  const trip = r.body.trip;
  check("A on a second trip -> 409 (never loaded twice)", (await plan([A.id, Dd.id])).status === 409);
  const spare = (await plan([Dd.id])).body.trip;
  check("cancel a planned trip (reason required)", (await call("sara", "POST", `/api/operations/trips/${spare.id}/cancel`, {})).status === 400 && (await call("sara", "POST", `/api/operations/trips/${spare.id}/cancel`, { reason: "اتأجل" })).body.trip?.status === "cancelled");
  check("…its order is free to plan again", (await call("sara", "GET", "/api/operations/trips/plannable")).body.orders.some((o: any) => o.id === Dd.id));
  check("an order on a trip cannot be cancelled -> 409", (await call("sara", "POST", `/api/orders/${B.id}/cancel`, { reason: "x" })).status === 409);

  section("3. PREPARATION");
  check("loading before the orders are prepared -> 409", (await call("mostafa", "POST", `/api/operations/trips/${trip.id}/start-loading`, {})).status === 409);
  check("the preparer starts A", (await call("ahmed", "POST", `/api/orders/${A.id}/status`, { to: "preparing" })).status === 200);
  check("…and owns it (my queue)", (await call("ahmed", "GET", "/api/orders?mine=1")).body.orders.some((o: any) => o.id === A.id));
  check("the preparer cannot assign -> 403", (await call("ahmed", "POST", `/api/orders/${B.id}/assign`, { user_id: "x" })).status === 403);
  const ahmedId = (await call("ahmed", "GET", "/api/auth/me")).body.user.id;
  check("the supervisor assigns B to the preparer", (await call("sara", "POST", `/api/orders/${B.id}/assign`, { user_id: ahmedId })).body.order?.assignedToName);
  await call("ahmed", "POST", `/api/orders/${B.id}/status`, { to: "preparing" });
  for (const o of [A, B]) {
    const full = (await call("ahmed", "GET", `/api/orders/${o.id}`)).body.order;
    for (const i of full.items) await call("ahmed", "POST", `/api/orders/${o.id}/items/${i.id}/prepare`, { quantity: i.requiredQuantity, mark_done: true });
    check(`${o.orderNumber} ready for loading`, (await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" })).status === 200);
  }
  const prepView = (await call("ahmed", "GET", `/api/orders/${A.id}`)).body;
  check("the preparer's view of an order has no prices", priceKeys(prepView).length === 0, priceKeys(prepView));
  check("…and its credit headline carries no amounts", !/\d/.test(prepView.order.creditNote ?? ""), prepView.order.creditNote);

  section("4. LOADING");
  r = await call("mostafa", "POST", `/api/operations/trips/${trip.id}/start-loading`, {});
  check("the loader starts loading the trip; its orders move to loading", r.status === 200 && r.body.trip.status === "loading" && r.body.trip.stops.every((s: any) => s.order.status === "loading"), r.body);
  check("confirming before the lines are loaded -> 409", (await call("mostafa", "POST", `/api/operations/trips/${trip.id}/loaded`, {})).status === 409);
  const aItems = (await call("mostafa", "GET", `/api/orders/${A.id}`)).body.order.items;
  const tomA = aItems.find((i: any) => i.stockProductId === tomato.id);
  const cucA = aItems.find((i: any) => i.stockProductId === cucumber.id);
  await call("mostafa", "POST", `/api/orders/${A.id}/items/${tomA.id}/load`, { quantity: 99.5, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${A.id}/items/${cucA.id}/load`, { quantity: 50, mark_done: true });
  const bItem = (await call("mostafa", "GET", `/api/orders/${B.id}`)).body.order.items[0];
  await call("mostafa", "POST", `/api/orders/${B.id}/items/${bItem.id}/load`, { quantity: 80, mark_done: true });
  // CRIT-2 (user spec): ANY shortage — even the 0.5 kg loading discrepancy below
  // the tolerance band — is a live gate on advancing to "loaded". The supervisor
  // approves it here, then the trip confirmation succeeds and the discrepancy is
  // still raised as an audited loading exception.
  const aBeforeLoaded = (await call("sara", "GET", `/api/orders/${A.id}`)).body.order;
  check("within-tolerance loading shortage blocks trip-loaded without approval", (await call("mostafa", "POST", `/api/operations/trips/${trip.id}/loaded`, {})).status === 409);
  const apprA = await call("sara", "POST", `/api/orders/${A.id}/approve`, { reason: "اعتماد فرق التحميل 0.5 كجم — هالك طبيعي", expected_version: aBeforeLoaded.version });
  check("supervisor approves the loading discrepancy", apprA.status === 200, apprA.status);
  r = await call("mostafa", "POST", `/api/operations/trips/${trip.id}/loaded`, {});
  check("trip loaded", r.status === 200 && r.body.trip.status === "loaded" && r.body.trip.stops.every((s: any) => s.order.status === "loaded"), r.body);
  let ex = (await call("sara", "GET", `/api/operations/exceptions?trip_id=${trip.id}`)).body.exceptions;
  check("a loading discrepancy is raised for 99.5 loaded of 100 prepared", ex.length === 1 && ex[0].type === "loading_discrepancy" && ex[0].quantity === "0.5", ex);
  check("dispatching A outside its trip -> 409", (await call("mostafa", "POST", `/api/orders/${A.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 })).status === 409);

  section("5. DISPATCH");
  check("the preparer cannot dispatch -> 403", (await call("ahmed", "POST", `/api/operations/trips/${trip.id}/dispatch`, {})).status === 403);
  check("crates are required -> 400", (await call("mostafa", "POST", `/api/operations/trips/${trip.id}/dispatch`, {})).status === 400);
  r = await call("mostafa", "POST", `/api/operations/trips/${trip.id}/dispatch`, { crates: { [A.id]: 8, [B.id]: 4 } });
  check("trip dispatched: every order out with the trip's truck and driver", r.status === 200 && r.body.trip.status === "dispatched" && r.body.trip.stops.every((s: any) => s.order.status === "dispatched"), r.body);
  const aOut = (await call("sara", "GET", `/api/orders/${A.id}`)).body.order;
  check("…the order carries the vehicle and driver", aOut.vehicle.includes(truck.plate) && aOut.driverName === driver.name && aOut.crateCount === 8, [aOut.vehicle, aOut.driverName]);
  check("a dispatched trip cannot be cancelled -> 409", (await call("sara", "POST", `/api/operations/trips/${trip.id}/cancel`, { reason: "x" })).status === 409);
  check("reopening an order that left on a trip -> 409", (await call("sara", "POST", `/api/orders/${A.id}/reopen`, { to: "loading", reason: "x" })).status === 409);
  check("depart: in transit", (await call("mostafa", "POST", `/api/operations/trips/${trip.id}/depart`, {})).body.trip?.status === "in_transit");
  check("no invoice before the delivery result -> 409", (await call("karim", "POST", "/api/sales/invoices", { order_id: A.id })).status === 409);
  check("…and it is not on the to-invoice list yet", !(await call("karim", "GET", "/api/sales/invoices/to-invoice")).body.orders.some((o: any) => o.id === A.id));
  check("the floor's trip view has no prices or credit", priceKeys((await call("mostafa", "GET", `/api/operations/trips/${trip.id}`)).body).length === 0);

  section("6. DELIVERY RESULTS");
  const stops = (await call("mostafa", "GET", `/api/operations/trips/${trip.id}`)).body.trip.stops;
  const stopA = stops.find((s: any) => s.orderId === A.id), stopB = stops.find((s: any) => s.orderId === B.id);
  const stockOf = async (pid: string) => Number((await call("hossam", "GET", `/api/inventory/products/${pid}`)).body.onHand ?? NaN);
  const tomBefore = await stockOf(tomato.id);
  check("a failed delivery needs a reason -> 400", (await call("mostafa", "POST", `/api/operations/stops/${stopB.id}/delivery`, { result: "failed" })).status === 400);
  r = await call("mostafa", "POST", `/api/operations/stops/${stopB.id}/delivery`, { result: "failed", failure_reason: "المخزن مقفول" });
  check("B failed: recorded, everything came back on a return document", r.status === 201 && r.body.stop.status === "failed" && !!r.body.stop.returnDocumentId, r.body);
  check("…80 kg tomato back in stock", (await stockOf(tomato.id)) - tomBefore === 80, [tomBefore, await stockOf(tomato.id)]);
  r = await call("mostafa", "POST", `/api/operations/stops/${stopB.id}/delivery`, { result: "failed", failure_reason: "المخزن مقفول" });
  check("the same result again is answered, not repeated (200, no second return)", r.status === 200 && r.body.replayed === true && (await stockOf(tomato.id)) - tomBefore === 80);
  check("a different result for a recorded stop -> 409", (await call("mostafa", "POST", `/api/operations/stops/${stopB.id}/delivery`, { result: "delivered", receiver_name: "x" })).status === 409);
  check("delivery needs the receiver's name -> 400", (await call("mostafa", "POST", `/api/operations/stops/${stopA.id}/delivery`, { result: "delivered" })).status === 400);
  check("shortage needs a reason -> 400", (await call("mostafa", "POST", `/api/operations/stops/${stopA.id}/delivery`, { result: "delivered", receiver_name: "x", lines: [{ order_item_id: tomA.id, shortage_qty: 1 }] })).status === 400);
  check("damage needs a reason -> 400", (await call("mostafa", "POST", `/api/operations/stops/${stopA.id}/delivery`, { result: "delivered", receiver_name: "x", lines: [{ order_item_id: tomA.id, damaged_qty: 1 }] })).status === 400);
  check("customer rejection needs a reason -> 400", (await call("mostafa", "POST", `/api/operations/stops/${stopA.id}/delivery`, { result: "delivered", receiver_name: "x", lines: [{ order_item_id: tomA.id, rejected_qty: 1 }] })).status === 400);
  check("more short/damaged/rejected than shipped -> 400", (await call("mostafa", "POST", `/api/operations/stops/${stopA.id}/delivery`, { result: "delivered", receiver_name: "x", lines: [{ order_item_id: tomA.id, rejected_qty: 100, reason: "مرفوض" }] })).status === 400);
  const podA = { result: "delivered", receiver_name: "أ. منى — المخازن", customer_notes: "الطماطم فيها ضرب", lines: [{ order_item_id: tomA.id, shortage_qty: 2, damaged_qty: "1.5", rejected_qty: 3, reason: "كرتونة ناقصة وطماطم مضروبة" }] };
  r = await call("mostafa", "POST", `/api/operations/stops/${stopA.id}/delivery`, podA);
  check("A partly delivered: 93 of 99.5 tomato, all the cucumber", r.status === 201 && r.body.stop.status === "partial", r.body);
  check("…only the rejected 3 kg came back to stock (short/damaged left with the dispatch)", (await stockOf(tomato.id)) - tomBefore === 83);
  const exA = () => call("sara", "GET", `/api/operations/exceptions?order_id=${A.id}`).then((x) => x.body.exceptions);
  ex = await exA();
  check("…shortage, damage and rejection exceptions raised (plus the loading one)", ["shortage", "damage", "rejection", "loading_discrepancy"].every((t) => ex.some((e: any) => e.type === t)) && ex.find((e: any) => e.type === "damage").quantity === "1.5", ex.map((e: any) => [e.type, e.quantity]));
  const n = ex.length;
  check("retrying A's result changes nothing", (await call("mostafa", "POST", `/api/operations/stops/${stopA.id}/delivery`, podA)).status === 200 && (await exA()).length === n && (await stockOf(tomato.id)) - tomBefore === 83);
  check("every stop has a result: trip completed", (await call("mostafa", "GET", `/api/operations/trips/${trip.id}`)).body.trip.status === "completed");

  section("7. INVOICE ON WHAT WAS DELIVERED");
  r = await call("karim", "POST", "/api/sales/invoices", { order_id: A.id });
  const inv = r.body.invoice;
  const lines = (await call("karim", "GET", `/api/sales/invoices/${inv?.id}`)).body.invoice?.lines ?? [];
  check("A invoiced on 93 kg tomato × 12 + 50 kg cucumber × 8 = 1516", r.status === 201 && lines.find((l: any) => l.productId === tomato.id)?.quantity === "93" && inv.total === "1516", [inv?.total, lines.map((l: any) => [l.quantity, l.net])]);
  check("B (failed) is not on the to-invoice list", !(await call("karim", "GET", "/api/sales/invoices/to-invoice")).body.orders.some((o: any) => o.id === B.id));
  check("…and has nothing to invoice -> 409", (await call("karim", "POST", "/api/sales/invoices", { order_id: B.id })).status === 409);

  section("8. EXCEPTIONS");
  const rej = ex.find((e: any) => e.type === "rejection");
  check("the floor reads exceptions, without prices", priceKeys((await call("ahmed", "GET", "/api/operations/exceptions?status=open")).body).length === 0);
  check("the preparer cannot resolve -> 403", (await call("ahmed", "POST", `/api/operations/exceptions/${rej.id}/resolve`, { resolution: "x" })).status === 403);
  check("the supervisor assigns it", (await call("sara", "POST", `/api/operations/exceptions/${rej.id}/assign`, { user_id: ahmedId })).body.exception?.ownerName);
  check("resolution is required -> 400", (await call("sara", "POST", `/api/operations/exceptions/${rej.id}/resolve`, {})).status === 400);
  r = await call("sara", "POST", `/api/operations/exceptions/${rej.id}/resolve`, { resolution: "اتعمل فرز للمرتجع واتحط في الحجر" });
  check("…and resolves it", r.body.exception?.status === "resolved" && r.body.exception.resolvedBy);
  check("resolving twice -> 409", (await call("sara", "POST", `/api/operations/exceptions/${rej.id}/resolve`, { resolution: "x" })).status === 409);
  check("the preparer reports damage by hand", (await call("ahmed", "POST", "/api/operations/exceptions", { type: "damage", order_id: Dd.id, quantity: 4, description: "خيار مضروب في التجهيز" })).status === 201);
  check("sales cannot report floor exceptions -> 403", (await call("mona", "POST", "/api/operations/exceptions", { type: "damage", order_id: Dd.id, description: "x" })).status === 403);
  const audit = (await call("admin", "GET", `/api/audit?q=${trip.id}&limit=200`)).body.logs.filter((l: any) => l.entityId === trip.id).map((l: any) => l.action);
  check("the trip's life is audited", ["trip_planned", "trip_loading_started", "trip_loaded", "trip_dispatched", "trip_departed", "delivery_recorded", "trip_completed"].every((a) => audit.includes(a)), audit);
  finish("OPERATIONS");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
