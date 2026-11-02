/* Inventory API end to end: receiving into locations and lots, availability,
   transfers, counts, scrap, returns, reservations, approvals, reports — and who may
   see and do what. */
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();
const TAG = `ZZINVE-${Date.now()}`;
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa"]) await login(u);
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مزرعة` })).body.supplier;
  const mango = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Mango`, name_ar: `${TAG} مانجا`, unit: "KG" })).body.product;
  const customer = (await call("admin", "POST", "/api/sales/customers", { name: `${TAG} فندق` })).body.customer;
  const integrationOrder = (name: string, items: any[], delivery_date: string) => call(null, "POST", "/api/orders", {
    external_id: `${TAG}-${Date.now()}-${Math.random()}`, source: "n8n", customer_name: name, delivery_date, items,
  }, { "x-api-key": process.env.N8N_API_KEY! });
  const manualOrder = (name: string, items: any[], delivery_date: string) => call("sara", "POST", "/api/orders", {
    customer_account_id: customer.id, customer_name: customer.name, delivery_date,
    items: items.map((item) => ({ ...item, stock_product_id: mango.id })),
  });
  const detail = async (who = "sara") => (await call(who, "GET", `/api/inventory/products/${mango.id}`)).body;

  section("1. PRODUCT INVENTORY SETTINGS + PACKAGING");
  r = await call("hossam", "PATCH", `/api/inventory/products/${mango.id}/settings`, { shelf_life_days: 4, removal_strategy: "fefo", reorder_point_qty: 50, min_stock_qty: 20, cold_chain: true, expected_version: mango.version });
  check("stock controller sets shelf life / FEFO / reorder / cold chain", r.status === 200 && r.body.product.shelfLifeDays === 4 && r.body.product.coldChain === true, r.body);
  check("min above max -> 400", (await call("hossam", "PATCH", `/api/inventory/products/${mango.id}/settings`, { max_stock_qty: 10 })).status === 400);
  check("unknown strategy -> 400", (await call("hossam", "PATCH", `/api/inventory/products/${mango.id}/settings`, { removal_strategy: "random" })).status === 400);
  check("preparer cannot change it -> 403", (await call("ahmed", "PATCH", `/api/inventory/products/${mango.id}/settings`, { shelf_life_days: 9 })).status === 403);
  r = await call("hossam", "POST", `/api/inventory/products/${mango.id}/packagings`, { uom: "CRATE", qty_in_base_unit: 18 });
  check("1 CRATE = 18 KG for this mango", r.status === 200 && r.body.packaging.qtyInBaseUnit === "18", r.body);
  check("packaging in the base unit itself -> 400", (await call("hossam", "POST", `/api/inventory/products/${mango.id}/packagings`, { uom: "KG", qty_in_base_unit: 1 })).status === 400);
  check("a package unit cannot be a base unit -> 400", (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Bad`, unit: "CRATE" })).status === 400);
  check("an unknown unit cannot be a base unit -> 400", (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Bad2`, unit: "كيلو" })).status === 400);

  section("2. RECEIVING INTO A LOCATION, BY THE CRATE, WITH A PRICE");
  r = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: mango.id, received_date: today, entered_qty: 10, entered_uom: "CRATE", rejected_kg: 6, unit_cost: "15", location_id: "loc_cold_1", crate_count: 10 });
  check("receipt by the crate -> 201", r.status === 201, r.body);
  const rc1 = r.body.intake;
  check("10 crates × 18 = 180 kg received, 174 good", rc1?.receivedKg === 180 && rc1?.goodKg === 174 && rc1?.enteredUom === "CRATE");
  check("put straight into COLD-1 with a lot and a shelf-life expiry", rc1?.location?.code === "COLD-1" && /^LOT-\d{8}-\d{4}$/.test(rc1?.lot?.lotNumber) && rc1?.lot?.expiryDate > today, rc1);
  r = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: mango.id, received_date: today, received_kg: 50, expiry_date: today, unit_cost: "18" });
  const rc2 = r.body.intake;
  check("second receipt lands in the receiving bay by default, expiring today", r.status === 201 && rc2.location.code === "RECV" && rc2.lot.expiryDate === today, r.body);
  check("cold-chain product refused in a dry location", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: mango.id, received_kg: 5, location_id: (await call("admin", "POST", "/api/admin/master/locations", { warehouse_id: "wh_main", code: `D${Date.now() % 100000}`, name: "Dry shelf", type: "dry" })).body.row.id })).status === 400);
  check("unknown packaging -> 400", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: mango.id, entered_qty: 1, entered_uom: "PALLET" })).status === 400);
  check("expiry before receipt -> 400", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: mango.id, received_kg: 1, received_date: today, expiry_date: "2000-01-01" })).status === 400);

  section("3. AVAILABILITY AND WHO SEES VALUE");
  let d = await detail("sara");
  check("on-hand 224 = available (nothing reserved)", d.onHand === "224" && d.available === "224" && d.reserved === "0", { onHand: d.onHand, available: d.available });
  check("FEFO pick order: today's lot before the 4-day lot", d.buckets[0]?.lotNumber === rc2.lot.lotNumber && d.buckets[1]?.lotNumber === rc1.lot.lotNumber, d.buckets.map((b: any) => b.lotNumber));
  check("supervisor sees value: (174×15 + 50×18) = 3510", d.valuation?.value === "3510", d.valuation);
  const dh = await detail("hossam");
  check("stock controller sees quantities but not value", dh.onHand === "224" && dh.valuation === null && dh.movements.every((m: any) => m.unitCost === null));
  const list = await call("hossam", "GET", "/api/inventory/stock");
  const row = list.body.rows.find((x: any) => x.productId === mango.id);
  check("stock list: quantities for the stock controller, no cost", row?.onHand === "224" && row?.stockValue === null, row);
  check("valuation report is supervisor-only (403 for stock controller)", (await call("hossam", "GET", "/api/inventory/reports/valuation")).status === 403);
  const val = await call("sara", "GET", "/api/inventory/reports/valuation");
  check("valuation report lists the product at 3510", val.status === 200 && val.body.rows.some((x: any) => x.productId === mango.id && x.value === "3510"), val.body);
  check("preparer has no inventory view -> 403", (await call("ahmed", "GET", "/api/inventory/stock")).status === 403);

  section("4. TRANSFER");
  r = await call("hossam", "POST", "/api/inventory/transfers", { lines: [{ product_id: mango.id, quantity: 40, location_id: "loc_recv", to_location_id: "loc_cold_2" }] });
  check("move 40 kg from RECV to COLD-2 -> 201", r.status === 201 && /^TRF-\d{4}-\d{5}$/.test(r.body.document.number), r.body);
  const trf = r.body.document;
  d = await detail();
  check("on-hand unchanged by a transfer", d.onHand === "224");
  check("COLD-2 now holds 40 of the RECV lot", d.buckets.some((b: any) => b.locationCode === "COLD-2" && b.quantity === "40" && b.lotNumber === rc2.lot.lotNumber));
  check("more than the bucket holds -> 400", (await call("hossam", "POST", "/api/inventory/transfers", { lines: [{ product_id: mango.id, quantity: 999, location_id: "loc_recv", to_location_id: "loc_cold_2" }] })).status === 400);
  check("same location -> 400", (await call("hossam", "POST", "/api/inventory/transfers", { lines: [{ product_id: mango.id, quantity: 1, location_id: "loc_cold_2", to_location_id: "loc_cold_2" }] })).status === 400);
  check("preparer cannot transfer -> 403", (await call("ahmed", "POST", "/api/inventory/transfers", { lines: [] })).status === 403);
  check("no lines -> 400", (await call("hossam", "POST", "/api/inventory/transfers", { lines: [] })).status === 400);

  section("5. IDEMPOTENT RETRY");
  const body = { reason: "تالف في النقل", idempotency_key: `${TAG}-scrap`, lines: [{ product_id: mango.id, quantity: 2, location_id: "loc_cold_2" }] };
  const s1 = await call("hossam", "POST", "/api/inventory/scrap", body);
  const s2 = await call("hossam", "POST", "/api/inventory/scrap", body);
  check("first scrap -> 201, retry -> 200 with the same document", s1.status === 201 && s2.status === 200 && s1.body.document.id === s2.body.document.id, [s1.status, s2.status]);
  check("scrapped once: 222 on hand", (await detail()).onHand === "222");
  check("scrap without a reason -> 400", (await call("hossam", "POST", "/api/inventory/scrap", { lines: [{ product_id: mango.id, quantity: 1 }] })).status === 400);

  section("6. RESERVATIONS");
  const order = (await manualOrder(`${TAG} فندق`, [{ product_name: mango.nameAr, quantity: 100 }], "2026-12-04")).body.order;
  // WF-01 (replaces "reserve 100 kg for an order line -> 201"): the confirmed order
  // already holds its 100 kg from the moment it exists; reserving the line again is a
  // replay of that same hold, never a second one.
  d = await detail();
  check("the order holds its 100 kg at creation: available = 222 - 100", d.reserved === "100" && d.available === "122", { reserved: d.reserved, available: d.available });
  r = await call("sara", "POST", "/api/inventory/reservations", { product_id: mango.id, quantity: 100, source_type: "order", source_id: order.id, source_line_id: order.items[0].id });
  check("reserving the order line again -> 200, the order's own reservation", r.status === 200 && r.body.reservation?.sourceLineId === order.items[0].id && r.body.reservation?.quantity === "100", r.body);
  const res = r.body.reservation;
  check("same line again is idempotent (200, same reservation)", (await call("sara", "POST", "/api/inventory/reservations", { product_id: mango.id, quantity: 100, source_type: "order", source_id: order.id, source_line_id: order.items[0].id })).body.reservation?.id === res.id);
  check("…still one hold of 100", (await detail()).reserved === "100");
  check("cannot reserve beyond available -> 400", (await call("sara", "POST", "/api/inventory/reservations", { product_id: mango.id, quantity: 123, source_type: "manual", source_id: `${TAG}-x` })).status === 400);
  check("scrap that would eat reserved stock -> 400", (await call("hossam", "POST", "/api/inventory/scrap", { reason: "x", lines: [{ product_id: mango.id, quantity: 130 }] })).status === 400);
  check("reserving for a line not on the order -> 400", (await call("sara", "POST", "/api/inventory/reservations", { product_id: mango.id, quantity: 1, source_type: "order", source_id: order.id, source_line_id: "nope" })).status === 400);
  // WF-01: a live order's hold is released with the order (quantity edit, cancel), never
  // by hand — the manual release mechanics are exercised on a manual reservation.
  check("releasing a live order's hold by hand -> 409", (await call("sara", "POST", `/api/inventory/reservations/${res.id}/release`, { reason: "العميل لغى" })).status === 409);
  const man = (await call("sara", "POST", "/api/inventory/reservations", { product_id: mango.id, quantity: 10, source_type: "manual", source_id: `${TAG}-man` })).body.reservation;
  check("release without a reason -> 400", (await call("sara", "POST", `/api/inventory/reservations/${man.id}/release`, {})).status === 400);
  check("release", (await call("sara", "POST", `/api/inventory/reservations/${man.id}/release`, { reason: "العميل لغى" })).status === 200);
  check("released twice -> 409", (await call("sara", "POST", `/api/inventory/reservations/${man.id}/release`, { reason: "x" })).status === 409);
  r = await call("sara", "POST", `/api/orders/${order.id}/items/${order.items[0].id}/required`, { quantity: 0, reason: "العميل لغى الكمية" });
  check("the order's line set to 0 through the order releases its hold", r.status === 200, r.body);
  check("available back to 222", (await detail()).available === "222");

  section("7. COUNT, WITH APPROVAL ABOVE THE THRESHOLD");
  const thr = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((s: any) => s.key === "inventory.adjustment_approval_threshold");
  await call("admin", "PATCH", "/api/admin/settings/inventory.adjustment_approval_threshold", { value: 10, reason: TAG, expected_version: thr.version });
  r = await call("hossam", "POST", "/api/inventory/adjustments", { reason: "جرد غرفة 1", lines: [{ product_id: mango.id, location_id: "loc_cold_1", lot_id: rc1.lot.id, counted_quantity: 160 }] });
  check("count 14 kg short of the books -> 202, waiting for approval", r.status === 202 && r.body.document.status === "pending_approval" && r.body.document.movements.length === 0, r.body);
  const adj = r.body.document;
  check("nothing moved yet", (await detail()).onHand === "222");
  const pending = (await call("sara", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === adj.id);
  check("supervisor sees it in the approvals inbox", pending?.type === "inventory.adjustment" && pending?.canDecide === true, pending);
  check("the stock controller cannot approve their own count -> 403", (await call("hossam", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve" })).status === 403);
  r = await call("sara", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve", comment: "مطابق للعد", expected_version: pending.version });
  check("supervisor approves", r.status === 200 && r.body.request.status === "approved", r.body);
  d = await detail();
  check("posted on approval: 222 - 14 = 208", d.onHand === "208");
  const docs = (await call("hossam", "GET", "/api/inventory/documents?type=adjustment")).body.documents;
  check("the document is posted with its movement", docs.find((x: any) => x.id === adj.id)?.status === "posted" && docs.find((x: any) => x.id === adj.id)?.movements.length === 1);
  r = await call("hossam", "POST", "/api/inventory/adjustments", { reason: "تصحيح بسيط", lines: [{ product_id: mango.id, quantity: 3 }] });
  check("small adjustment under the threshold posts at once -> 201", r.status === 201 && r.body.document.status === "posted");
  const thrNow = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((s: any) => s.key === "inventory.adjustment_approval_threshold");
  await call("admin", "PATCH", "/api/admin/settings/inventory.adjustment_approval_threshold", { value: null, reason: TAG, expected_version: thrNow.version });

  section("8. RETURNS AND REVERSAL");
  r = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: order.id, reason: "رجع من الفندق", lines: [{ product_id: mango.id, quantity: 5 }] });
  check("customer return -> 201", r.status === 201 && /^RET-/.test(r.body.document.number) && r.body.document.sourceId === order.id, r.body);
  check("a return against an order that does not exist -> 404", (await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: "no-such-order", reason: "x", lines: [{ product_id: mango.id, quantity: 1 }] })).status === 404);
  r = await call("hossam", "POST", "/api/inventory/returns", { direction: "customer", order_id: order.orderNumber, reason: "بالرقم", lines: [{ product_id: mango.id, quantity: 1 }] });
  check("…the printed order number works too", r.status === 201 && r.body.document.sourceId === order.id, r.body);
  await call("hossam", "POST", "/api/inventory/scrap", { reason: "توازن الاختبار", lines: [{ product_id: mango.id, quantity: 1, location_id: r.body.document.movements[0].locationId }] });
  r = await call("hossam", "POST", "/api/inventory/returns", { direction: "supplier", supplier_id: sup.id, reason: "جودة", lines: [{ product_id: mango.id, quantity: 4, lot_id: rc1.lot.id, location_id: "loc_cold_1" }] });
  check("supplier return out of a named lot -> 201", r.status === 201, r.body);
  const supRet = r.body.document;
  check("unknown direction -> 400", (await call("hossam", "POST", "/api/inventory/returns", { direction: "sideways", lines: [] })).status === 400);
  check("on-hand after returns: 208 + 3 + 5 - 4 = 212", (await detail()).onHand === "212");
  r = await call("hossam", "POST", `/api/inventory/documents/${trf.id}/reverse`, { reason: "تحويل غلط" });
  check("the transfer cannot be reversed: 2 kg of what it moved were scrapped since -> 400", r.status === 400 && /38/.test(r.body.error), r.body);
  check("reversing without a reason -> 400", (await call("hossam", "POST", `/api/inventory/documents/${supRet.id}/reverse`, {})).status === 400);
  r = await call("hossam", "POST", `/api/inventory/documents/${supRet.id}/reverse`, { reason: "المورد رفض المرتجع" });
  check("reverse the supplier return", r.status === 201 && r.body.document.reversalOfId === supRet.id, r.body);
  check("reverse it again -> 409", (await call("hossam", "POST", `/api/inventory/documents/${supRet.id}/reverse`, { reason: "x" })).status === 409);
  check("the 4 kg are back: 216", (await detail()).onHand === "216");
  // Customer returns land in quarantine by design (inspected before re-sale): the
  // 5 kg returned earlier sit in QUAR and are NOT sellable until released.
  d = await detail();
  check("returned goods wait in quarantine, not sellable: on-hand 216, available 211", d.onHand === "216" && d.quarantined === "5" && d.available === "211", { onHand: d.onHand, quarantined: d.quarantined, available: d.available });
  r = await call("hossam", "POST", "/api/inventory/release", { warehouse_id: "wh_main", product_id: mango.id, location_id: "loc_quarantine", destination_id: "loc_cold_1", quantity: 5, reason: "فحص المرتجع وسلامته" });
  check("inspected: the 5 kg are released from quarantine via release endpoint -> 201", r.status === 201, r.body);
  check("…and sellable again: available 216", (await detail()).available === "216");

  section("9. LOT EXPIRY AND THE EXPIRING REPORT");
  const exp = await call("hossam", "GET", "/api/inventory/reports/expiring?days=1");
  check("today's lot is on the expiring list", exp.status === 200 && exp.body.rows.some((x: any) => x.lotId === rc2.lot.id && x.daysLeft === 0), exp.body.rows?.slice?.(0, 3));
  check("correcting expiry without a reason -> 400", (await call("hossam", "PATCH", `/api/inventory/lots/${rc2.lot.id}`, { expiry_date: "2099-01-01" })).status === 400);
  r = await call("hossam", "PATCH", `/api/inventory/lots/${rc2.lot.id}`, { expiry_date: "2099-01-01", reason: "التاريخ اتكتب غلط" });
  check("expiry corrected", r.status === 200 && r.body.lot.expiryDate === "2099-01-01");
  check("…and it leaves the expiring list", !(await call("hossam", "GET", "/api/inventory/reports/expiring?days=1")).body.rows.some((x: any) => x.lotId === rc2.lot.id));

  section("10. DISPATCH ISSUES STOCK (ORDER → LEDGER)");
  const ship = { vehicle: "ن ق ل 123", driver_name: "سواق", crate_count: 4 };
  // WF-01 (replaces "the unknown line rides along and becomes an exception at dispatch"):
  // an integration order naming a product the catalog does not know is refused whole.
  r = await integrationOrder(`${TAG} مطعم`, [
    { stock_product_id: mango.id, product_name: `${TAG} Mango`, quantity: 30 },
    { stock_product_id: mango.id, product_name: `${TAG} Mango`, quantity: 2, unit: "CRATE" },
    { product_name: `${TAG} شيء مش متعرف`, quantity: 5 },
  ], "2026-12-05");
  check("integration order with an unmapped product -> 409, line 3 unmapped", r.status === 409 && r.body.code === "stock_unavailable" && r.body.details?.shortfalls?.some((x: any) => x.line === 3 && x.reason === "unmapped"), r.body);
  check("…nothing held for it", (await detail()).reserved === "0");
  const o1 = (await integrationOrder(`${TAG} مطعم`, [
    { stock_product_id: mango.id, product_name: `${TAG} Mango`, quantity: 30 },
    { stock_product_id: mango.id, product_name: `${TAG} Mango`, quantity: 2, unit: "CRATE" },
  ], "2026-12-05")).body.order;
  check("order lines named after the product are mapped to it", o1.items.filter((i: any) => i.stockProductId === mango.id).length === 2, o1.items);
  // WF-01 (replaces "30 reserved for it: available 186", a manual reservation of one line):
  // the order holds both lines in full at creation — 30 kg + 2 crates × 18 = 66 kg.
  check("the order holds 66 kg from creation: available 216 - 66 = 150", (await detail()).available === "150");
  r = await call("sara", "POST", `/api/orders/${o1.id}/status`, { to: "dispatched", reason: "خروج مباشر", ...ship });
  check("dispatch -> 200", r.status === 200 && r.body.order.status === "dispatched", r.body);
  d = await detail();
  check("on-hand drops by 30 kg + 2 crates × 18 = 66 → 150", d.onHand === "150", d.onHand);
  check("the order's reservation was consumed, not left hanging", d.reserved === "0" && d.available === "150");
  const issues = (await call("hossam", "GET", "/api/inventory/documents?type=issue")).body.documents.filter((x: any) => x.sourceId === o1.id);
  check("one ISS document for the dispatch", issues.length === 1 && /^ISS-/.test(issues[0].number) && issues[0].status === "posted", issues);
  check("…picked FEFO, one movement per bucket, all negative", issues[0].movements.length >= 1 && issues[0].movements.every((m: any) => Number(m.quantity) < 0));
  // WF-01 (replaces "unmapped line recorded as an exception" + "stock controller notified"):
  // every line was issued in full, so the dispatch raised no stock-issue exception.
  let exs = (await call("hossam", "GET", `/api/inventory/exceptions?order_id=${o1.id}`)).body.exceptions;
  check("a full issue raises no stock-issue exception", exs.length === 0, exs);
  check("cancel a dispatched order is still refused", (await call("sara", "POST", `/api/orders/${o1.id}/cancel`, { reason: "x" })).status === 400);
  check("the issue cannot be reversed from the stock screen -> 400", (await call("hossam", "POST", `/api/inventory/documents/${issues[0].id}/reverse`, { reason: "x" })).status === 400);

  r = await call("sara", "POST", `/api/orders/${o1.id}/reopen`, { to: "loading", reason: "العربية مخرجتش" });
  check("reopen the dispatched order", r.status === 200, r.body);
  d = await detail();
  check("reopen returns the 66 kg: 216", d.onHand === "216", d.onHand);
  check("the issue is marked reversed", (await call("hossam", "GET", "/api/inventory/documents?type=issue")).body.documents.find((x: any) => x.id === issues[0].id)?.status === "reversed");
  check("…and the reopened order holds its 66 kg again: available 150", (await detail()).available === "150");
  exs = (await call("hossam", "GET", `/api/inventory/exceptions?order_id=${o1.id}&status=voided`)).body.exceptions;
  check("no exception existed, so none is voided (replaces: exceptions voided with the reason)", exs.length === 0, exs);
  r = await call("sara", "POST", `/api/orders/${o1.id}/status`, { to: "dispatched", reason: "خرجت فعلاً", ...ship });
  check("re-dispatch -> 200", r.status === 200, r.body);
  check("re-dispatch issues afresh: 150", (await detail()).onHand === "150");
  check("…with a second, live ISS document", (await call("hossam", "GET", "/api/inventory/documents?type=issue")).body.documents.filter((x: any) => x.sourceId === o1.id && x.status === "posted" && !x.reversalOfId).length === 1);
  r = await call("sara", "POST", `/api/orders/${o1.id}/reopen`, { to: "loading", reason: "رجعت تاني" });
  check("a second reopen reverses only the live issue (not the earlier reversal)", r.status === 200 && (await detail()).onHand === "216", r.body);
  r = await call("sara", "POST", `/api/orders/${o1.id}/status`, { to: "dispatched", reason: "خرجت", ...ship });
  check("…and dispatching once more issues again: 150", r.status === 200 && (await detail()).onHand === "150");

  section("11. SHORT STOCK: REFUSED AT ORDER, STRICT AT DISPATCH, LEGACY EXCEPTIONS RECONCILED");
  // WF-01 replaces "strict blocks, lenient records": an order the books cannot cover is
  // never confirmed, the lenient policy cannot be chosen, and dispatch refuses any
  // shortfall. Exceptions left by the retired lenient policy are closed by a late issue
  // or an approved no-movement closure — never by a note.
  r = await manualOrder(`${TAG} فندق كبير`, [{ product_name: mango.nameAr, quantity: 500 }], "2026-12-06");
  check("order for 500 kg against 150 available -> 409 stock_unavailable", r.status === 409 && r.body.code === "stock_unavailable" && r.body.details?.shortfalls?.[0]?.available === "150", r.body);
  d = await detail();
  check("…nothing held, nothing moved", d.onHand === "150" && d.reserved === "0", { onHand: d.onHand, reserved: d.reserved });
  const pol = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === "inventory.dispatch_issue_policy");
  check("policy setting defaults to strict", pol?.value === "strict" && pol?.isDefault === true, pol);
  check("an unknown policy value -> 400", (await call("admin", "PATCH", "/api/admin/settings/inventory.dispatch_issue_policy", { value: "maybe", reason: TAG, expected_version: pol.version })).status === 400);
  check("lenient can no longer be chosen -> 400", (await call("admin", "PATCH", "/api/admin/settings/inventory.dispatch_issue_policy", { value: "lenient", reason: TAG, expected_version: pol.version })).status === 400);
  const o2 = (await manualOrder(`${TAG} فندق كبير`, [{ product_name: mango.nameAr, quantity: 100 }], "2026-12-06")).body.order;
  check("an order the books can cover (100 of 150) is confirmed and held", !!o2?.id && (await detail()).available === "50", o2);
  await call("sara", "POST", `/api/orders/${o2.id}/status`, { to: "preparing", expected_version: o2.version });
  await call("sara", "POST", `/api/orders/${o2.id}/items/${o2.items[0].id}/prepare`, { quantity: 100, mark_done: true });
  await call("sara", "POST", `/api/orders/${o2.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o2.id}/items/${o2.items[0].id}/load`, { quantity: 200, mark_done: true });
  let o2v = (await call("sara", "GET", `/api/orders/${o2.id}`)).body.order;
  if (o2v.needsReview) await call("sara", "POST", `/api/orders/${o2.id}/approve`, { reason: "حمولة زيادة", expected_version: o2v.version });
  r = await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "loaded" });
  check("200 kg loaded on a 100 kg order (review approved)", r.status === 200, r.body);
  r = await call("sara", "POST", `/api/orders/${o2.id}/status`, { to: "dispatched", reason: "x", ...ship });
  check("strict: 200 kg loaded against 150 on the books -> 409 dispatch_stock_shortfall", r.status === 409 && r.body.code === "dispatch_stock_shortfall", r.body);
  check("…and the order did not move", (await call("sara", "GET", `/api/orders/${o2.id}`)).body.order.status === "loaded");
  check("…nor did the stock", (await detail()).onHand === "150");
  check("…and no exception was raised", (await call("hossam", "GET", `/api/inventory/exceptions?order_id=${o2.id}`)).body.exceptions.length === 0);
  o2v = (await call("sara", "GET", `/api/orders/${o2.id}`)).body.order;
  r = await call("sara", "POST", `/api/orders/${o2.id}/cancel`, { reason: "حمولة غلط", expected_version: o2v.version });
  check("the over-loaded order is cancelled, releasing its 100 kg", r.status === 200 && (await detail()).available === "150", r.body);

  // Legacy exceptions (raised by the retired lenient dispatch before the remediation)
  // are put on the dispatched order o1 directly — no current path creates one.
  assertTestDatabase();
  const db = new PrismaClient();
  const legacy = (requested: string) => db.stockIssueException.create({ data: { orderId: o1.id, orderItemId: o1.items[0].id, productId: mango.id, productName: o1.items[0].productName, unit: "KG", requestedQty: requested, issuedQty: "30", reason: "insufficient" } });
  const ex1 = await legacy("40");
  const ex2 = await legacy("35");
  await db.$disconnect();
  exs = (await call("hossam", "GET", `/api/inventory/exceptions?order_id=${o1.id}`)).body.exceptions;
  check("two legacy 'insufficient' exceptions are open on o1", exs.length === 2, exs);
  check("preparer cannot resolve it -> 403", (await call("ahmed", "POST", `/api/inventory/exceptions/${ex1.id}/resolve`, { resolution: "x", action: "issue_now" })).status === 403);
  check("resolving needs an explanation -> 400", (await call("hossam", "POST", `/api/inventory/exceptions/${ex1.id}/resolve`, {})).status === 400);
  // Replaces "stock controller resolves it" with a free-text note: a note alone never closes one.
  check("a note alone does not close it -> 400 (choose issue_now or close_no_movement)", (await call("hossam", "POST", `/api/inventory/exceptions/${ex1.id}/resolve`, { resolution: "استلام 350 كيلو اتسجل متأخر", expected_version: ex1.version })).status === 400);
  r = await call("hossam", "POST", `/api/inventory/exceptions/${ex1.id}/resolve`, { action: "issue_now", resolution: "الكمية الناقصة خرجت فعلاً — تتصرف دلوقتي", expected_version: ex1.version });
  check("stock controller resolves it by issuing the missing 10 kg now", r.status === 200 && r.body.exception.exception?.status === "resolved" && r.body.exception.exception?.resolutionKind === "late_issue" && /^ISS-/.test(r.body.exception.document?.number ?? ""), r.body);
  check("…the late issue takes the 10 kg off the books: 140", (await detail()).onHand === "140");
  check("resolved twice -> 409", (await call("hossam", "POST", `/api/inventory/exceptions/${ex1.id}/resolve`, { action: "issue_now", resolution: "تاني مرة" })).status === 409);
  r = await call("hossam", "POST", `/api/inventory/exceptions/${ex2.id}/resolve`, { action: "close_no_movement", resolution: "متحملش على العربية — مفيش حاجة خرجت" });
  check("closing with no stock movement waits for an approval", r.status === 200 && r.body.exception.pending === true && r.body.exception.approval?.type === "stock.issue_exception_close", r.body);
  const closeReq = r.body.exception?.approval;
  check("…the exception is still open meanwhile", (await call("hossam", "GET", `/api/inventory/exceptions?order_id=${o1.id}`)).body.exceptions.some((e: any) => e.id === ex2.id));
  check("…the requester cannot approve it -> 403", (await call("hossam", "POST", `/api/approvals/${closeReq?.id}/decide`, { decision: "approve", comment: "x" })).status === 403);
  r = await call("sara", "POST", `/api/approvals/${closeReq?.id}/decide`, { decision: "approve", comment: "متأكد" });
  check("someone else approves -> closed with no movement", r.status === 200, r.body);
  const closed = (await call("hossam", "GET", `/api/inventory/exceptions?order_id=${o1.id}&status=resolved`)).body.exceptions.find((e: any) => e.id === ex2.id);
  check("…resolved as no_movement, stock untouched at 140", closed?.resolutionKind === "no_movement" && (await detail()).onHand === "140", closed);

  section("12. CANCEL RELEASES RESERVATIONS");
  await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: mango.id, received_date: today, received_kg: 20, unit_cost: "15" });
  const o3 = (await manualOrder(`${TAG} كافيه`, [{ product_name: mango.nameAr, quantity: 8 }], "2026-12-07")).body.order;
  await call("sara", "POST", "/api/inventory/reservations", { product_id: mango.id, quantity: 8, source_type: "order", source_id: o3.id, source_line_id: o3.items[0].id });
  // Numbers recomputed: the lenient dispatch used to issue all 150 kg (on hand 0), so the
  // 20 kg receipt left 20 available. Under WF-01 the 500 kg order was refused and the
  // legacy late issue took 10: 140 + 20 = 160 available before this order.
  check("the order holds its 8 kg at creation: 152 of 160 available", (await detail()).available === "152");
  check("cancel the order", (await call("sara", "POST", `/api/orders/${o3.id}/cancel`, { reason: "العميل لغى" })).status === 200);
  check("its reservation is released: 160 available", (await detail()).available === "160");

  section("13. AUDIT");
  const audit = (await call("hossam", "GET", "/api/stock/audit")).body.logs.map((l: any) => l.action);
  for (const a of ["inventory_transfer_posted", "inventory_scrap_posted", "stock_reserved", "stock_reservation_released", "inventory_adjustment_requested", "stock_adjustment_created", "inventory_customer_return_posted", "inventory_supplier_return_posted", "inventory_document_reversed", "product_packaging_saved", "stock_lot_updated", "inventory_issue_posted", "stock_issue_exception_resolved"]) {
    check(`stock audit records ${a}`, audit.includes(a), audit.slice(0, 12));
  }

  finish("INVENTORY");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
