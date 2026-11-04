/* A realistic UNITED working day for the LOCAL test database — what the screens are
   reviewed and screenshotted against (UI/UX work, localisation, journeys). Everything
   goes through the real HTTP API as the seeded test users, so every rule, approval and
   posting applies; nothing is written to the database directly.

     master data (bilingual products in KG and pieces, suppliers, B2B customers with
     long legal names) → graded receipts (good / Grade-B SKU / waste), one large and
     fractional → a supplier bill and part payment → orders at every stage: new,
     preparing (short), ready, loading, loaded, dispatched and delivered → invoices,
     one part-collected → a purchase request for what could not be sold.

   Guarded: UNITED_TEST_DB=1, a local DATABASE_URL and a local server (tests/_harness).
   Run after `npm run test:reset`:  BASE=http://localhost:3193 npm run demo:dataset */
import { call, login } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { fundCash, approveGradingLoss, taxNo } from "./_stock";
import { todayBiz } from "./_days";

assertTestDatabase();
const today = todayBiz();
const problems: string[] = [];
const ok = (label: string, r: { status: number; body?: any }, want: number[] = [200, 201, 202]) => {
  if (!want.includes(r.status)) problems.push(`${label}: ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 200)}`);
  return r.body;
};

const PRODUCTS = [
  { key: "tomato", name: "Tomatoes", name_ar: "طماطم", unit: "KG", cost: "8.40" },
  { key: "tomatoB", name: "Tomatoes Grade B", name_ar: "طماطم فرزة تانية", unit: "KG", cost: null },
  { key: "cucumber", name: "Cucumber", name_ar: "خيار", unit: "KG", cost: "9.25" },
  { key: "potato", name: "Potatoes Spunta", name_ar: "بطاطس سبونتا", unit: "KG", cost: "7.85" },
  { key: "onion", name: "Red Onion", name_ar: "بصل أحمر", unit: "KG", cost: "6.10" },
  { key: "mango", name: "Mango Ewais", name_ar: "مانجو عويس", unit: "KG", cost: "38.50" },
  { key: "pepper", name: "Bell Pepper Mix", name_ar: "فلفل ألوان مشكّل", unit: "KG", cost: "27.00" },
  { key: "lettuce", name: "Romaine Lettuce", name_ar: "خس روماني", unit: "PIECE", cost: "6.75" },
  { key: "lemon", name: "Baladi Lemon", name_ar: "ليمون بلدي", unit: "KG", cost: "19.50" },
  { key: "guava", name: "Guava", name_ar: "جوافة", unit: "KG", cost: "16.00" },
] as const;
const SUPPLIERS = [
  { key: "nubaria", name: "Al-Nubaria Farms for Vegetables & Fruits", name_ar: "مزارع النوبارية للخضر والفاكهة", payment_terms_days: 30 },
  { key: "obour", name: "El-Obour Central Market Traders", name_ar: "تجار سوق العبور المركزي", payment_terms_days: 7 },
  { key: "ismailia", name: "Ismailia Mango Orchards", name_ar: "بساتين مانجو الإسماعيلية", payment_terms_days: 15 },
] as const;
const CUSTOMERS = [
  { key: "coast", type: "hotel", name: "North Coast Hospitality Group", name_ar: "مجموعة فنادق الساحل الشمالي للضيافة والسياحة ش.م.م", legal_name: "North Coast Hospitality Group S.A.E.", legal_name_ar: "مجموعة فنادق الساحل الشمالي للضيافة والسياحة ش.م.م", payment_terms_days: 30, credit_limit: "750000" },
  { key: "cairo", type: "restaurant", name: "Greater Cairo Restaurants Chain", name_ar: "سلسلة مطاعم القاهرة الكبرى", legal_name: "Greater Cairo Restaurants Co.", legal_name_ar: "شركة مطاعم القاهرة الكبرى", payment_terms_days: 15, credit_limit: "250000" },
  { key: "zamalek", type: "retail", name: "Zamalek Gourmet Market", name_ar: "زمالك جورميه ماركت", legal_name: "Zamalek Gourmet for Trading", legal_name_ar: "زمالك جورميه للتجارة", payment_terms_days: 7, credit_limit: "120000" },
  { key: "capital", type: "institution", name: "New Capital Catering Company", name_ar: "شركة العاصمة الإدارية للتموين والتغذية", legal_name: "New Capital Catering Co.", legal_name_ar: "شركة العاصمة الإدارية للتموين والتغذية", payment_terms_days: 45, credit_limit: "1500000" },
  { key: "maadi", type: "retail", name: "Maadi Family Supermarket", name_ar: "سوبر ماركت المعادي العائلي", legal_name: "Maadi Family Supermarket", legal_name_ar: "سوبر ماركت المعادي العائلي", payment_terms_days: 0, credit_limit: "60000" },
] as const;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"]) await login(u);

  // ---- master data ----
  const p: Record<string, any> = {};
  for (const x of PRODUCTS) p[x.key] = ok(`product ${x.name}`, await call("hossam", "POST", "/api/stock/products", { name: x.name, name_ar: x.name_ar, unit: x.unit })).product;
  const s: Record<string, any> = {};
  for (const x of SUPPLIERS) s[x.key] = ok(`supplier ${x.name}`, await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: x.name, name_ar: x.name_ar, payment_terms_days: x.payment_terms_days })).supplier;
  const c: Record<string, any> = {};
  for (const x of CUSTOMERS) c[x.key] = ok(`customer ${x.name}`, await call("admin", "POST", "/api/sales/customers", { name: x.name, name_ar: x.name_ar, legal_name: x.legal_name, legal_name_ar: x.legal_name_ar, type: x.type, tax_registration_no: taxNo(), payment_terms_days: x.payment_terms_days, credit_limit: x.credit_limit, credit_reason: "حد ائتمان حسب التعاقد السنوي" })).customer;

  if (problems.length) throw new Error(`master data failed:\n - ${problems.join("\n - ")}`);

  // ---- receipts (graded) ----
  const intakes: Record<string, any> = {};
  const receive = async (key: string, supplier: string, body: Record<string, unknown>) => {
    const r = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: s[supplier].id, product_id: p[key].id, received_date: today, ...body });
    intakes[key] = ok(`intake ${key}`, r).intake;
    if (intakes[key]?.id) await approveGradingLoss([intakes[key].id]);
  };
  await receive("tomato", "nubaria", { received_kg: "2450.5", grade_b_qty: "310", grade_b_product_id: p.tomatoB.id, waste_qty: "42.5", unit_cost: "8.40" });
  await receive("cucumber", "obour", { received_kg: "860", waste_qty: "12", unit_cost: "9.25" });
  await receive("potato", "nubaria", { received_kg: "12480.75", unit_cost: "7.85" });
  await receive("onion", "obour", { received_kg: "1500", waste_qty: "35", unit_cost: "6.10" });
  await receive("mango", "ismailia", { received_kg: "640", waste_qty: "18.5", unit_cost: "38.50" });
  await receive("pepper", "obour", { received_kg: "210.25", unit_cost: "27.00" });
  await receive("lettuce", "obour", { received_kg: "600", unit_cost: "6.75" });
  await receive("lemon", "obour", { received_kg: "95", unit_cost: "19.50" });
  // Guava: nothing received — it is what customers ask for and cannot have (a purchase request).

  // ---- payables: one bill, part paid by bank ----
  await fundCash("bank_main", "500000");
  await fundCash("cash_main", "25000");
  const bill = ok("bill", await call("karim", "POST", "/api/purchasing/bills", { supplier_id: s.nubaria.id, supplier_invoice_no: `NUB-${today.replaceAll("-", "")}-118`, bill_date: today, lines: [{ intake_id: intakes.potato.id, unit_price: "7.85" }] })).bill;
  if (bill?.id) {
    ok("bill post", await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {}));
    ok("supplier payment", await call("karim", "POST", "/api/accounting/payments", { party_id: s.nubaria.id, cash_account_id: "bank_main", amount: "60000", method: "bank_transfer", allocations: [{ document_id: bill.id, amount: "60000" }], idempotency_key: `demo-pay-${today}` }));
  }

  // ---- orders at every stage ----
  const order = async (customer: string, lines: [string, string, string][]) => {
    const o = ok(`order ${customer}`, await call("mona", "POST", "/api/orders", { customer_account_id: c[customer].id, customer_name: c[customer].name, delivery_date: today, items: lines.map(([k, q]) => ({ stock_product_id: p[k].id, product_name: p[k].name, quantity: Number(q), unit: p[k].unit })) })).order;
    if (!o) return null;
    for (const [i, [, , price]] of lines.entries()) ok(`price ${customer}`, await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[i].id}/price`, { unit_price: price, reason: "سعر التعاقد" }));
    return o;
  };
  const prepare = async (o: any, short = 0) => {
    ok("preparing", await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" }));
    for (const [i, it] of o.items.entries()) ok("prepare line", await call("ahmed", "POST", `/api/orders/${o.id}/items/${it.id}/prepare`, { quantity: i === 0 ? it.requiredQuantity - short : it.requiredQuantity, mark_done: true }));
  };
  const ready = async (o: any) => ok("ready", await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" }));

  const o1 = await order("coast", [["tomato", "420.5", "14.50"], ["mango", "120", "62.00"], ["lettuce", "180", "11.00"]]);
  const o2 = await order("capital", [["potato", "3200", "11.25"], ["onion", "640", "9.40"]]);
  const o3 = await order("cairo", [["cucumber", "260", "13.75"], ["pepper", "45.75", "41.00"]]);
  const o4 = await order("zamalek", [["mango", "38", "64.50"], ["lemon", "22.5", "29.00"]]);
  const o5 = await order("maadi", [["tomato", "85", "15.00"], ["onion", "60", "9.75"]]);
  const o6 = await order("coast", [["potato", "1250", "11.00"], ["cucumber", "140", "13.50"]]);
  await order("cairo", [["tomato", "150", "14.75"]]);
  await order("capital", [["lettuce", "240", "10.50"]]);
  // Demand that cannot be served (no guava): refused with a shortfall → a purchase request.
  const want = await call("mona", "POST", "/api/orders", { customer_account_id: c.zamalek.id, customer_name: c.zamalek.name, delivery_date: today, items: [{ stock_product_id: p.guava.id, product_name: p.guava.name, quantity: 50, unit: "KG" }] });
  if (want.status !== 409) problems.push(`guava order expected 409, got ${want.status}`);
  ok("purchase request", await call("mona", "POST", "/api/purchasing/requests", { product_id: p.guava.id, quantity: "50", needed_by: today, reason: "طلب عميل مش متاح في المخزن", customer_id: c.zamalek.id }));

  // Dispatched and delivered (o1, o2) on one trip; loaded (o3); loading (o6); ready (o4); preparing short (o5).
  const vehicle = ok("vehicle", await call("sara", "POST", "/api/operations/vehicles", { code: "TRK-07", plate: "ن ق ب ٤٢١٧", capacity_kg: 6000 })).vehicle;
  const driver = ok("driver", await call("sara", "POST", "/api/operations/drivers", { name: "محمود عبد الفتاح السيد" })).driver;
  for (const o of [o1, o2, o3, o4, o6]) if (o) { await prepare(o); await ready(o); }
  if (o5) await prepare(o5, 12);
  if (o1 && o2 && vehicle && driver) {
    const trip = ok("trip", await call("sara", "POST", "/api/operations/trips", { trip_date: today, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: [o1.id, o2.id] })).trip;
    ok("start loading", await call("mostafa", "POST", `/api/operations/trips/${trip.id}/start-loading`, {}));
    for (const o of [o1, o2]) for (const it of o.items) ok("load", await call("mostafa", "POST", `/api/orders/${o.id}/items/${it.id}/load`, { quantity: it.requiredQuantity, mark_done: true }));
    ok("loaded", await call("mostafa", "POST", `/api/operations/trips/${trip.id}/loaded`, {}));
    ok("dispatch", await call("mostafa", "POST", `/api/operations/trips/${trip.id}/dispatch`, { crates: { [o1.id]: 38, [o2.id]: 96 } }));
    const stops = ok("trip read", await call("mostafa", "GET", `/api/operations/trips/${trip.id}`)).trip?.stops ?? [];
    for (const st of stops) {
      const lines = st.orderId === o1.id ? [{ order_item_id: o1.items[0].id, rejected_qty: 6.5, reason: "طماطم مخدوشة" }] : [];
      ok("delivery", await call("mostafa", "POST", `/api/operations/stops/${st.id}/delivery`, { result: "delivered", receiver_name: "مسؤول الاستلام", lines }));
    }
    for (const [o, collect] of [[o1, true], [o2, false]] as const) {
      const inv = ok("invoice", await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).invoice;
      if (!inv) continue;
      const issued = ok("issue", await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {})).invoice;
      if (collect && issued) ok("receipt", await call("karim", "POST", "/api/accounting/receipts", { party_id: o.customerAccountId ?? c.coast.id, cash_account_id: "bank_main", amount: (Number(issued.total) * 0.6).toFixed(2), method: "bank_transfer", allocations: [{ document_id: inv.id, amount: (Number(issued.total) * 0.6).toFixed(2) }], idempotency_key: `demo-rct-${today}` }));
    }
  }
  if (o3 && o6 && vehicle && driver) {
    const trip2 = ok("trip 2", await call("sara", "POST", "/api/operations/trips", { trip_date: today, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: [o3.id, o6.id] })).trip;
    ok("start loading 2", await call("mostafa", "POST", `/api/operations/trips/${trip2.id}/start-loading`, {}));
    for (const it of o3.items) ok("load o3", await call("mostafa", "POST", `/api/orders/${o3.id}/items/${it.id}/load`, { quantity: it.requiredQuantity, mark_done: true }));
    ok("load o6 first line", await call("mostafa", "POST", `/api/orders/${o6.id}/items/${o6.items[0].id}/load`, { quantity: o6.items[0].requiredQuantity, mark_done: true }));
  }

  console.log(problems.length ? `DEMO DATASET: ${problems.length} step(s) failed:\n - ${problems.join("\n - ")}` : "DEMO DATASET: complete");
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
