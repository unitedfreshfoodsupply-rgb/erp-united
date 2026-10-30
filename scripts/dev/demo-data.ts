/**
 * Local demo data — for screenshots, UX review and chart checks on a DISPOSABLE database.
 *
 *   UNITED_TEST_DB=1 BASE=http://localhost:3111 npx tsx scripts/dev/demo-data.ts [weeks]
 *
 * Builds ~`weeks` (default 12) of realistic history through the application's own HTTP API
 * — every document goes through the same validation, permissions and postings as on site:
 * produce, customers, suppliers, dated receipts with grading (good / grade B / waste),
 * supplier bills and payments, orders prepared, loaded, dispatched and delivered, sales
 * invoices issued on their delivery day, customer receipts, and a few employees.
 *
 * It refuses to run unless UNITED_TEST_DB=1 and BASE is a local server (tests/_guard.ts).
 * Never point it at production. Run `npm run test:reset` first for a clean slate.
 * Deterministic: the same seed produces the same history.
 */
import { assertTestServer } from "../../tests/_guard";

const BASE = process.env.BASE ?? "http://localhost:3111";
assertTestServer(BASE);
if (process.env.UNITED_TEST_DB !== "1") throw new Error("refused: set UNITED_TEST_DB=1 (disposable database only)");

const WEEKS = Number(process.argv[2] ?? 12);
const jars: Record<string, string> = {};
let failures = 0;

async function call(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(jars[who] ? { cookie: jars[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const set = r.headers.get("set-cookie");
  const m = set && /united_session=([^;]*)/.exec(set);
  if (m) jars[who] = `united_session=${m[1]}`;
  const text = await r.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: r.status, body: parsed };
}

/** A call that must succeed; on failure it is logged and counted, and null is returned. */
async function must(who: string, method: string, path: string, body?: unknown) {
  const r = await call(who, method, path, body);
  if (r.status >= 300) {
    failures++;
    console.warn(`  ! ${who} ${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
    return null;
  }
  return r.body;
}

// Deterministic pseudo-random numbers (mulberry32).
let seed = 20261030;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number, step = 5) => Math.round((lo + rnd() * (hi - lo)) / step) * step;

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
const day = (offset: number) => fmt.format(new Date(Date.now() + offset * 86_400_000));

const PRODUCTS = [
  { name: "Tomato", ar: "طماطم", cost: [5, 7], price: [8.5, 10.5] },
  { name: "Cucumber", ar: "خيار", cost: [3.5, 5], price: [6, 7.5] },
  { name: "Potato", ar: "بطاطس", cost: [4, 5.5], price: [7, 8.5] },
  { name: "Onion", ar: "بصل", cost: [3, 4.5], price: [5.5, 7] },
  { name: "Bell pepper", ar: "فلفل رومي", cost: [9, 13], price: [15, 19] },
  { name: "Carrot", ar: "جزر", cost: [3.5, 5], price: [6.5, 8] },
  { name: "Lettuce", ar: "خس", cost: [6, 8], price: [11, 14] },
  { name: "Lemon", ar: "ليمون", cost: [12, 16], price: [20, 25] },
  { name: "Zucchini", ar: "كوسة", cost: [6, 8.5], price: [10, 13] },
  { name: "Eggplant", ar: "باذنجان", cost: [4, 6], price: [7.5, 9.5] },
] as const;

const CUSTOMERS = [
  { name: "Nile Garden Hotel", ar: "فندق حديقة النيل", type: "hotel", terms: 30, tax: true },
  { name: "Zamalek Bistro", ar: "بيسترو الزمالك", type: "restaurant", terms: 14, tax: true },
  { name: "Al Sharq Restaurants", ar: "مطاعم الشرق", type: "restaurant", terms: 30, tax: true },
  { name: "Maadi Fresh Market", ar: "ماركت المعادي الطازج", type: "retail", terms: 21, tax: true },
  { name: "Heliopolis Café", ar: "كافيه مصر الجديدة", type: "cafe", terms: 0, tax: false },
  { name: "Pyramids Resort", ar: "منتجع الأهرامات", type: "hotel", terms: 45, tax: true },
  { name: "Downtown Kitchen", ar: "مطبخ وسط البلد", type: "restaurant", terms: 7, tax: false },
  { name: "Green Bowl Salads", ar: "جرين بول للسلطات", type: "restaurant", terms: 14, tax: true },
] as const;

const SUPPLIERS = [
  { name: "Delta Farms", ar: "مزارع الدلتا", terms: 30 },
  { name: "Obour Market Traders", ar: "تجار سوق العبور", terms: 7 },
  { name: "Fayoum Growers", ar: "مزارعي الفيوم", terms: 14 },
  { name: "Ismailia Orchards", ar: "بساتين الإسماعيلية", terms: 21 },
] as const;

let taxSeq = 0;
const taxNo = () => String(310000000 + ++taxSeq * 7919).slice(0, 9);

async function main() {
  for (const u of ["admin", "hossam", "mona", "karim", "omar", "ahmed", "mostafa", "sara"]) {
    const r = await call(u, "POST", "/api/auth/login", { username: u, password: "1234" });
    if (r.status !== 200) throw new Error(`login ${u} failed (${r.status}) — run npm run test:reset first`);
  }

  console.log("master data");
  const products: { id: string; name: string; spec: (typeof PRODUCTS)[number] }[] = [];
  for (const p of PRODUCTS) {
    const b = await must("hossam", "POST", "/api/stock/products", { name: p.name, name_ar: p.ar, unit: "KG" });
    if (b?.product) products.push({ id: b.product.id, name: b.product.name, spec: p });
  }
  const customers: { id: string; name: string }[] = [];
  for (const c of CUSTOMERS) {
    const b = await must("mona", "POST", "/api/sales/customers", { name: c.name, name_ar: c.ar, type: c.type, ...(c.tax ? { tax_registration_no: taxNo() } : {}) });
    if (!b?.customer) continue;
    customers.push({ id: b.customer.id, name: b.customer.name });
    if (c.terms) await must("karim", "PATCH", `/api/sales/customers/${b.customer.id}/credit`, { payment_terms_days: c.terms, reason: "شروط التعاقد" });
  }
  const suppliers: { id: string }[] = [];
  for (const s of SUPPLIERS) {
    const b = await must("omar", "POST", "/api/purchasing/suppliers", { name: s.name, name_ar: s.ar, payment_terms_days: s.terms });
    if (b?.supplier) suppliers.push({ id: b.supplier.id });
  }
  const vehicle = (await must("sara", "POST", "/api/operations/vehicles", { code: "TRK-01", plate: "ن ص ر 4821", capacity_kg: 3000 }))?.vehicle;
  const driver = (await must("sara", "POST", "/api/operations/drivers", { name: "صابر عبد الحميد" }))?.driver;
  for (const [name, offset] of [["حسن محمود", -400], ["منى السيد", -300], ["كريم فؤاد", -200], ["ياسمين علي", -90]] as const) {
    await must("karim", "POST", "/api/hr/employees", { name, hire_date: day(offset) });
  }

  const start = -WEEKS * 7;
  const billable: Record<string, { intakeId: string; cost: number; date: string }[]> = {};
  const invoices: { id: string; customerId: string; total: number; date: string }[] = [];
  let tripNo = 0;

  for (let d = start; d <= 0; d++) {
    const date = day(d);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 5 = Friday (closed)
    if (weekday === 5) continue;

    // Receiving: most days, a few products, each from one supplier; graded at intake.
    if (weekday !== 6 || rnd() < 0.5) {
      // Opening day stocks every product; after that, receipts track what sells.
      for (const p of products.filter(() => d === start || rnd() < 0.4)) {
        const supplier = pick(suppliers);
        const received = d === start ? between(500, 800, 10) : between(120, 300, 10);
        const gradeB = rnd() < 0.6 ? between(received * 0.03, received * 0.12, 5) : 0;
        const waste = rnd() < 0.7 ? between(received * 0.01, received * 0.06, 5) : 0;
        const cost = Number((p.spec.cost[0] + rnd() * (p.spec.cost[1] - p.spec.cost[0])).toFixed(2));
        const b = await must("hossam", "POST", "/api/stock/intakes", {
          supplier_id: supplier.id, product_id: p.id, received_date: date, received_qty: received,
          grade_b_qty: gradeB || undefined, waste_qty: waste || undefined, unit_cost: cost,
          location_id: "loc_cold_1", expiry_date: day(30), idempotency_key: `demo-${date}-${p.id}`,
        });
        const intake = b?.intake;
        if (intake?.id) (billable[supplier.id] ??= []).push({ intakeId: intake.id, cost, date });
      }
    }

    // Deliveries: weekdays, a handful of customers, one trip.
    if (d < 0 && weekday !== 6) {
      const today = customers.filter(() => rnd() < 0.45);
      const orders: any[] = [];
      for (const c of today) {
        const lines = products.filter(() => rnd() < 0.35).slice(0, 4);
        if (!lines.length) continue;
        const o = (await must("mona", "POST", "/api/orders", {
          customer_account_id: c.id, customer_name: c.name, delivery_date: date,
          items: lines.map((p) => ({ stock_product_id: p.id, product_name: p.name, quantity: between(20, 120, 5) })),
        }))?.order;
        if (!o) continue;
        for (const it of o.items) {
          const spec = products.find((p) => p.id === it.stockProductId)!.spec;
          await must("mona", "PATCH", `/api/orders/${o.id}/items/${it.id}/price`, { unit_price: (spec.price[0] + rnd() * (spec.price[1] - spec.price[0])).toFixed(2), reason: "سعر التعاقد" });
        }
        await must("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
        for (const it of o.items) await must("ahmed", "POST", `/api/orders/${o.id}/items/${it.id}/prepare`, { quantity: Number(it.requiredQuantity), mark_done: true });
        if (await must("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" })) orders.push(o);
      }
      if (orders.length && vehicle && driver) {
        tripNo++;
        const trip = (await must("sara", "POST", "/api/operations/trips", { trip_date: date, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: orders.map((o) => o.id) }))?.trip;
        if (trip) {
          await must("mostafa", "POST", `/api/operations/trips/${trip.id}/start-loading`, {});
          for (const o of orders) for (const it of o.items) await must("mostafa", "POST", `/api/orders/${o.id}/items/${it.id}/load`, { quantity: Number(it.requiredQuantity), mark_done: true });
          await must("mostafa", "POST", `/api/operations/trips/${trip.id}/loaded`, {});
          await must("mostafa", "POST", `/api/operations/trips/${trip.id}/dispatch`, { crates: Object.fromEntries(orders.map((o) => [o.id, between(4, 16, 1)])) });
          const stops = (await must("mostafa", "GET", `/api/operations/trips/${trip.id}`))?.trip?.stops ?? [];
          for (const stop of stops) {
            const o = orders.find((x) => x.id === stop.orderId);
            const reject = o && rnd() < 0.15 ? [{ order_item_id: o.items[0].id, rejected_qty: between(2, 8, 1), damaged_qty: 0, reason: "جودة أقل من المطلوب" }] : [];
            await must("mostafa", "POST", `/api/operations/stops/${stop.id}/delivery`, { result: "delivered", receiver_name: "مسؤول الاستلام", lines: reject });
          }
          for (const o of orders) {
            const inv = (await must("karim", "POST", "/api/sales/invoices", { order_id: o.id }))?.invoice;
            if (!inv) continue;
            const issued = (await must("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, { issue_date: date }))?.invoice;
            if (issued) invoices.push({ id: issued.id, customerId: o.customerAccountId, total: Number(issued.total), date });
          }
        }
      }
    }

    // Weekly: supplier bills for the week's receipts, payments, customer receipts.
    if (weekday === 4 || d === 0) {
      for (const [supplierId, rows] of Object.entries(billable)) {
        if (!rows.length) continue;
        const bill = (await must("karim", "POST", "/api/purchasing/bills", {
          supplier_id: supplierId, supplier_invoice_no: `INV-${date.replace(/-/g, "")}-${supplierId.slice(-4)}`, bill_date: date,
          lines: rows.map((r) => ({ intake_id: r.intakeId, unit_price: r.cost.toFixed(2) })),
        }))?.bill;
        billable[supplierId] = [];
        if (!bill) continue;
        const posted = await must("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
        if (posted && rnd() < 0.7 && d < -10) {
          await must("karim", "POST", "/api/accounting/payments", { party_id: supplierId, cash_account_id: "bank_main", amount: Number(posted.bill?.total ?? bill.total), method: "bank_transfer", date, auto: true, idempotency_key: `demo-pay-${bill.id}` });
        }
      }
      // Customers settle invoices that are 1-5 weeks old, most of them in full.
      for (const inv of invoices.filter((i) => i.date < day(d - 7) && rnd() < 0.55)) {
        await must("karim", "POST", "/api/accounting/receipts", { party_id: inv.customerId, cash_account_id: rnd() < 0.6 ? "bank_main" : "cash_main", amount: inv.total, method: "bank_transfer", date, allocations: [{ document_id: inv.id, amount: inv.total }], idempotency_key: `demo-rct-${inv.id}` });
        invoices.splice(invoices.indexOf(inv), 1);
      }
    }
  }

  // Today's floor: a few open orders in different stages for the boards.
  for (const c of customers.slice(0, 4)) {
    const lines = products.filter(() => rnd() < 0.4).slice(0, 3);
    if (!lines.length) continue;
    await must("mona", "POST", "/api/orders", { customer_account_id: c.id, customer_name: c.name, delivery_date: day(1), items: lines.map((p) => ({ stock_product_id: p.id, product_name: p.name, quantity: between(20, 80, 5) })) });
  }
  console.log(`done: ${tripNo} delivery days, ${failures} failed calls`);
}

main().catch((e) => { console.error(e); process.exit(1); });
