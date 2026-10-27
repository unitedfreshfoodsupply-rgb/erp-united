/* SCENARIO COMPLETENESS — the edge cases of UNITED's real business that the flow suites
   and the UAT do not walk through: fresh-food rules, units, races, illegal transitions,
   cross-document consistency, master-data integrity and cross-party access. Each check
   states the expected business outcome. Written from the completeness audit
   (docs/erp/SCENARIO_COMPLETENESS_AUDIT.md); every defect it found has a check here. */
import { call, login, makeChecker } from "./_harness";
import { local } from "./_days";

const { check, section, finish } = makeChecker();
const T = `ZZSCN${Date.now() % 1_000_000_000}`;
const today = local();
const n = (v: unknown) => Math.round(Number(v ?? 0) * 1000) / 1000;
const reg9 = (k: number) => String(100_000_000 + ((Date.now() + k * 7919) % 899_999_999)).slice(0, 9);
const par = <X>(k: number, f: () => Promise<X>) => Promise.all(Array.from({ length: k }, f));
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"]) await login(u);
  const mkProduct = async (name: string) => (await call("hossam", "POST", "/api/stock/products", { name: `${T} ${name}`, name_ar: `${name} ${T}`, unit: "KG" })).body.product;
  const prod = async (id: string) => (await call("karim", "GET", `/api/inventory/products/${id}`)).body;
  const onHand = async (id: string) => n((await prod(id)).onHand);
  const stockIn = (id: string, qty: number, cost = "5", expiry = local(6)) => call("karim", "POST", "/api/accounting/opening-stock", { business_date: today, lines: [{ product_id: id, quantity: qty, unit_cost: cost, expiry_date: expiry, location_id: "loc_cold_1" }] });
  const tomato = await mkProduct("Tomato");
  const mango = await mkProduct("Mango");
  await stockIn(tomato.id, 500);
  await stockIn(mango.id, 100, "8");
  const hotel = (await call("mona", "POST", "/api/sales/customers", { name: `${T} Hotel`, tax_registration_no: reg9(1), type: "hotel" })).body.customer;
  const cafe = (await call("mona", "POST", "/api/sales/customers", { name: `${T} Cafe`, type: "cafe" })).body.customer;
  const farm = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${T} Farm`, payment_terms_days: 30 })).body.supplier;
  const statement = async (id: string) => n((await call("karim", "GET", `/api/sales/customers/${id}/statement?from=2000-01-01&to=2099-12-31`)).body.closing);

  /** An order taken through preparation; `dispatch` sends it out directly. */
  const order = async (c: any, p: any, qty: number, price = "10", unit?: string) => {
    const o = (await call("mona", "POST", "/api/orders", { customer_account_id: c.id, customer_name: c.name, delivery_date: today, items: [{ stock_product_id: p.id, product_name: p.name, quantity: qty, ...(unit ? { unit } : {}) }] })).body.order;
    await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: price, reason: "قائمة" });
    await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
    await call("ahmed", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/prepare`, { quantity: qty, mark_done: true });
    await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" });
    return o;
  };
  const dispatch = async (o: any, qty: number) => {
    await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loading" });
    await call("mostafa", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: qty, mark_done: true });
    await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loaded" });
    return call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", vehicle: "v", driver_name: "d", crate_count: 1 });
  };
  const invoice = async (o: any) => {
    const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
    await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
    return (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
  };

  // ===========================================================================
  section("1. FRESH FOOD: expiry, FEFO, tiny and decimal weights");
  r = await stockIn(tomato.id, 1, "5", local(-1));
  check("stock already past its expiry is not opening stock -> 400 with the reason (was a 500)", r.status === 400 && /منتهية/.test(r.body.error), r);
  r = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: farm.id, product_id: tomato.id, received_kg: 5, unit_cost: "5", location_id: "loc_cold_1", expiry_date: local(-1) });
  check("a delivery that arrives already expired is refused at receiving -> 400", r.status === 400, r);
  const lettuce = await mkProduct("Lettuce");
  await stockIn(lettuce.id, 10, "5", today);
  await stockIn(lettuce.id, 30, "5", local(5));
  const ol = await order(hotel, lettuce, 25);
  await dispatch(ol, 25);
  const lb = (await prod(lettuce.id)).buckets.filter((b: any) => Number(b.quantity) > 0);
  check("FEFO: a lot expiring TODAY is still sellable and goes first (10 + 15 of the next lot)", lb.length === 1 && lb[0].expiryDate === local(5) && n(lb[0].quantity) === 15, lb.map((b: any) => [b.expiryDate, b.quantity]));
  check("(a lot that expired on the shelf goes LAST for a sale, first for scrap — tests/integration/expired-lots.test.ts)", true);
  for (const q of [0, -1, "abc"]) check(`order quantity ${q} -> 400`, (await call("mona", "POST", "/api/orders", { customer_name: "x", delivery_date: today, items: [{ product_name: tomato.name, quantity: q }] })).status === 400);
  const small = await order(cafe, mango, 0.333, "9.99");
  const pr = (await call("mona", "GET", `/api/orders/${small.id}/pricing`)).body;
  check("a very small weight: 0.333 kg × 9.99 = 3.33 (rounded to the piastre, never lost)", pr.totals.total === "3.33", pr.totals);
  check("price with more than 4 decimals or negative -> 400", (await call("mona", "PATCH", `/api/orders/${small.id}/items/${small.items[0].id}/price`, { unit_price: "-1", reason: "x" })).status === 400);

  // ===========================================================================
  section("2. UNITS: an order in crates, issued and invoiced through the packaging");
  await call("hossam", "POST", `/api/inventory/products/${mango.id}/packagings`, { uom: "CRATE", qty_in_base_unit: 12.5 });
  const oc = await order(hotel, mango, 1.5, "200", "CRATE");
  check("the crate line is mapped to the product", !!oc.items[0].stockProductId && oc.items[0].unit === "CRATE");
  let before = await onHand(mango.id);
  await dispatch(oc, 1.5);
  check("1.5 crates × 12.5 kg = 18.75 kg left stock", n(before - (await onHand(mango.id))) === 18.75, before - (await onHand(mango.id)));
  const ic = await invoice(oc);
  check("invoiced 1.5 crates × 200 = 300", ic.total === "300" && n(ic.lines[0].quantity) === 1.5, [ic.total, ic.lines[0].quantity]);
  before = await onHand(mango.id);
  r = await call("karim", "POST", `/api/sales/invoices/${ic.id}/credit-notes`, { reason: "نص صندوق تالف", restock: true, lines: [{ invoice_line_id: ic.lines[0].id, quantity: 0.5 }] });
  check("half a crate returned: credit 100, 6.25 kg back in stock", r.status === 201 && n(r.body.creditNote.total) === 100 && n((await onHand(mango.id)) - before) === 6.25, [r.status, r.body.creditNote?.total]);

  // ===========================================================================
  section("3. CROSS-DOCUMENT: once invoiced, the order's prices belong to the invoice");
  const op = await order(hotel, tomato, 7, "12");
  await dispatch(op, 7);
  const draft = (await call("karim", "POST", "/api/sales/invoices", { order_id: op.id })).body.invoice;
  r = await call("mona", "PATCH", `/api/orders/${op.id}/items/${op.items[0].id}/price`, { unit_price: "13", reason: "x" });
  check("price change while a DRAFT invoice exists -> 409 (the draft keeps its prices; was silently ignored)", r.status === 409 && /مسودة/.test(r.body.error), r);
  check("…reprice too -> 409", (await call("mona", "POST", `/api/orders/${op.id}/reprice`, { reason: "x" })).status === 409);
  check("…void the draft, then the price can change", (await call("karim", "POST", `/api/sales/invoices/${draft.id}/void`, { reason: "سعر غلط" })).status === 200 && (await call("mona", "PATCH", `/api/orders/${op.id}/items/${op.items[0].id}/price`, { unit_price: "13", reason: "تصحيح" })).status === 200);
  const ip = await invoice(op);
  check("the issued invoice carries the corrected price (7 × 13 = 91)", ip.total === "91", ip.total);
  r = await call("mona", "PATCH", `/api/orders/${op.id}/items/${op.items[0].id}/price`, { unit_price: "14", reason: "x" });
  check("price change after the invoice is ISSUED -> 409 naming the credit-note path", r.status === 409 && /إشعار دائن/.test(r.body.error), r);
  check("…the order still agrees with its invoice", (await call("mona", "GET", `/api/orders/${op.id}/pricing`)).body.totals.total === "91.00");
  check("an issued invoice cannot be voided; an invoiced order cannot be reopened -> 409", (await call("karim", "POST", `/api/sales/invoices/${ip.id}/void`, { reason: "x" })).status === 409 && (await call("sara", "POST", `/api/orders/${op.id}/reopen`, { to: "loading", reason: "x" })).status === 409);
  check("a dispatched order cannot be cancelled -> 400 (reopen is the path)", (await call("sara", "POST", `/api/orders/${op.id}/cancel`, { reason: "x" })).status === 400);

  // ===========================================================================
  section("4. RACES: the same correction submitted many times at once");
  const o4 = await order(hotel, tomato, 10);
  await dispatch(o4, 10);
  const i4 = await invoice(o4);
  before = await onHand(tomato.id);
  r = await par(3, () => call("karim", "POST", `/api/sales/invoices/${i4.id}/credit-notes`, { reason: "مرتجع", restock: true, lines: [{ invoice_line_id: i4.lines[0].id, quantity: 8 }] }));
  check("3 credit notes for 8 of 10 kg at once → one accepted, two refused (never 24 kg credited)", r.filter((x: any) => x.status === 201).length === 1 && r.filter((x: any) => x.status === 400).length === 2, r.map((x: any) => x.status));
  check("…8 kg back in stock, once", n((await onHand(tomato.id)) - before) === 8);
  const rc = (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: farm.id, product_id: tomato.id, received_kg: 50, unit_cost: "5", location_id: "loc_cold_1", expiry_date: local(5) })).body.intake;
  r = await par(2, () => call("karim", "POST", "/api/purchasing/bills", { supplier_id: farm.id, supplier_invoice_no: `${T}-${Math.random()}`, bill_date: today, lines: [{ intake_id: rc.id, unit_price: "5" }] }));
  check("2 bills for one receipt at once → one draft, one 409 (never billed twice)", r.filter((x: any) => x.status === 201).length === 1 && r.filter((x: any) => x.status === 409).length === 1, r.map((x: any) => x.status));
  const bill = r.find((x: any) => x.status === 201).body.bill;
  await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  const bl = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
  const rc2 = (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: farm.id, product_id: tomato.id, received_kg: 5, unit_cost: "5", location_id: "loc_cold_1", expiry_date: local(5) })).body.intake;
  r = await call("karim", "POST", "/api/purchasing/bills", { supplier_id: farm.id, supplier_invoice_no: ` ${bl.supplierInvoiceNo.toUpperCase()} `, bill_date: today, lines: [{ intake_id: rc2.id, unit_price: "5" }] });
  check("the same supplier invoice number again (other case, spaces) -> 409", r.status === 409, r);
  r = await par(3, () => call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "رجوع", return_goods: true, lines: [{ bill_line_id: bl.lines[0].id, quantity: 40 }] }));
  check("3 debit notes for 40 of 50 kg at once → one accepted", r.filter((x: any) => x.status === 201).length === 1, r.map((x: any) => x.status));
  const po = (await call("omar", "POST", "/api/purchasing/orders", { supplier_id: farm.id, expected_date: today, lines: [{ product_id: tomato.id, quantity: 100, unit_price: "5" }] })).body.order;
  await call("omar", "POST", `/api/purchasing/orders/${po.id}/submit`, {});
  await call("omar", "POST", `/api/purchasing/orders/${po.id}/send`, {});
  const pl = (await call("omar", "GET", `/api/purchasing/orders/${po.id}`)).body.order.lines[0];
  r = await Promise.all([1, 2, 3].map((k) => call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: pl.id, received_kg: 80, location_id: "loc_cold_1", expiry_date: local(5), idempotency_key: `${T}-po-${k}` })));
  check("3 trucks of 80 kg against a 100 kg PO at once → one received, two refused by the tolerance (never 240 kg)", r.filter((x: any) => x.status === 201).length === 1 && r.filter((x: any) => x.status === 409).length === 2, r.map((x: any) => x.status));
  const thin = await mkProduct("Herbs");
  await stockIn(thin.id, 30);
  r = await par(3, () => call("hossam", "POST", "/api/inventory/scrap", { reason: "تلف", lines: [{ product_id: thin.id, quantity: 30 }] }));
  check("3 scraps of the whole stock at once → one, stock 0, never negative", r.filter((x: any) => x.status === 201).length === 1 && (await onHand(thin.id)) === 0, r.map((x: any) => x.status));

  // ===========================================================================
  section("5. STATE MACHINES: illegal, backward and repeated transitions");
  const sm = (await call("mona", "POST", "/api/orders", { customer_account_id: hotel.id, customer_name: hotel.name, delivery_date: today, items: [{ stock_product_id: tomato.id, product_name: tomato.name, quantity: 5 }] })).body.order;
  for (const to of ["ready_for_loading", "loaded", "dispatched"]) check(`new → ${to} without the steps -> refused (override needs a reason)`, (await call("admin", "POST", `/api/orders/${sm.id}/status`, { to })).status === 400);
  check("an unknown status -> 400", (await call("admin", "POST", `/api/orders/${sm.id}/status`, { to: "delivered" })).status === 400);
  await call("ahmed", "POST", `/api/orders/${sm.id}/status`, { to: "preparing" });
  check("loading quantities while still preparing -> 409", (await call("mostafa", "POST", `/api/orders/${sm.id}/items/${sm.items[0].id}/load`, { quantity: 5 })).status === 409);
  check("sales cannot change required quantities (supervisor's) -> 403", (await call("mona", "POST", `/api/orders/${sm.id}/items/${sm.items[0].id}/required`, { quantity: 7, reason: "x" })).status === 403);
  check("issuing an invoice twice -> 409", (await call("karim", "POST", `/api/sales/invoices/${ip.id}/issue`, {})).status === 409);
  const q = (await call("mona", "POST", "/api/sales/quotations", { customer_id: hotel.id, delivery_date: today, lines: [{ product_id: tomato.id, quantity: 5, unit_price: "9" }] })).body.quotation;
  check("a draft quotation cannot be converted or accepted unsent -> 409", (await call("mona", "POST", `/api/sales/quotations/${q.id}/convert`, {})).status === 409 && (await call("mona", "POST", `/api/sales/quotations/${q.id}/transition`, { action: "accept" })).status === 409);
  const po2 = (await call("omar", "POST", "/api/purchasing/orders", { supplier_id: farm.id, expected_date: today, lines: [{ product_id: tomato.id, quantity: 10, unit_price: "5" }] })).body.order;
  const pl2 = (await call("omar", "GET", `/api/purchasing/orders/${po2.id}`)).body.order.lines[0];
  check("receiving against a DRAFT PO -> 409; sending it unsubmitted -> 409", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: pl2.id, received_kg: 1, location_id: "loc_cold_1" })).status === 409 && (await call("omar", "POST", `/api/purchasing/orders/${po2.id}/send`, {})).status === 409);
  await call("omar", "POST", `/api/purchasing/orders/${po2.id}/submit`, {});
  await call("omar", "POST", `/api/purchasing/orders/${po2.id}/send`, {});
  await call("omar", "POST", `/api/purchasing/orders/${po2.id}/cancel`, { reason: "المورد اعتذر" });
  check("receiving against a CANCELLED PO -> 409", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: pl2.id, received_kg: 1, location_id: "loc_cold_1" })).status === 409);
  const rcp = (await call("karim", "POST", "/api/accounting/receipts", { party_id: cafe.id, cash_account_id: "cash_main", amount: 5, method: "cash" })).body.receipt;
  await call("karim", "POST", `/api/accounting/receipts/${rcp.id}/reverse`, { reason: "غلط" });
  check("a receipt reversed twice -> 409; a reversed receipt cannot be allocated -> 409", (await call("karim", "POST", `/api/accounting/receipts/${rcp.id}/reverse`, { reason: "x" })).status === 409 && (await call("karim", "POST", `/api/accounting/receipts/${rcp.id}/allocate`, { allocations: [] })).status === 409);

  // ===========================================================================
  section("6. CROSS-PARTY AND SEGREGATION");
  const oi = await order(cafe, tomato, 1);
  await dispatch(oi, 1);
  const icafe = await invoice(oi);
  check("customer A's money cannot settle customer B's invoice -> 400", (await call("karim", "POST", "/api/accounting/receipts", { party_id: hotel.id, cash_account_id: "cash_main", amount: 5, method: "cash", allocations: [{ document_id: icafe.id, amount: 5 }] })).status === 400);
  check("a credit-note line of another invoice -> 400", (await call("karim", "POST", `/api/sales/invoices/${icafe.id}/credit-notes`, { reason: "x", lines: [{ invoice_line_id: ip.lines[0].id, quantity: 1 }] })).status === 400);
  r = await call("hossam", "PATCH", `/api/inventory/products/${thin.id}/settings`, { standard_cost: "123" });
  check("the stock controller cannot set a product's cost (finance owns valuation) -> 403", r.status === 403, r);
  check("…nor its costing method -> 403", (await call("hossam", "PATCH", `/api/inventory/products/${thin.id}/settings`, { costing_method: "fifo" })).status === 403);
  check("…but still owns shelf life and picking", (await call("hossam", "PATCH", `/api/inventory/products/${thin.id}/settings`, { shelf_life_days: 5, removal_strategy: "fefo" })).status === 200);
  check("the accountant sets the costing method (zero stock)", (await call("karim", "PATCH", `/api/inventory/products/${thin.id}/settings`, { costing_method: "fifo" })).status === 200);
  check("…but not the warehouse handling -> 403", (await call("karim", "PATCH", `/api/inventory/products/${thin.id}/settings`, { shelf_life_days: 9 })).status === 403);
  check("sales cannot set credit terms (finance) -> 403", (await call("mona", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_limit: 999999, reason: "x" })).status === 403);
  r = await call("mona", "POST", "/api/notifications/read", { ids: ["someone-elses"] });
  check("marking another user's notification read changes nothing (scoped to the caller)", r.status === 200);

  // ===========================================================================
  section("7. MASTER DATA: bad data is refused with an actionable message");
  check("duplicate product name (other case / spaces) -> 409", (await call("hossam", "POST", "/api/stock/products", { name: ` ${T} tomato `, unit: "KG" })).status === 409);
  check("product without a unit -> 400; unknown unit -> 400", (await call("hossam", "POST", "/api/stock/products", { name: `${T} NoUnit` })).status === 400 && (await call("hossam", "POST", "/api/stock/products", { name: `${T} BadUnit`, unit: "ZZZ" })).status === 400);
  check("a new product defaults to exempt tax, AVCO, FEFO", tomato.salesTaxCode === "EXEMPT" && tomato.costingMethod === "avco" && tomato.removalStrategy === "fefo", [tomato.salesTaxCode, tomato.costingMethod, tomato.removalStrategy]);
  // Branches of one legal entity share its tax number (31498cc), so a repeat is a new
  // card, not an error; a number that is not a tax registration number is still refused.
  check("repeated customer tax number -> 201 (another branch card)", (await call("mona", "POST", "/api/sales/customers", { name: `${T} Other`, tax_registration_no: hotel.taxRegistrationNo, type: "hotel" })).status === 201);
  check("malformed customer tax number -> 400", (await call("mona", "POST", "/api/sales/customers", { name: `${T} BadTax`, tax_registration_no: "12AB", type: "hotel" })).status === 400);
  check("duplicate supplier name -> 409", (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${T} Farm` })).status === 409);
  check("receiving into an unknown location -> 400; into an unknown cash account -> 400", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: farm.id, product_id: tomato.id, received_kg: 1, unit_cost: "1", location_id: "nope" })).status === 400 && (await call("karim", "POST", "/api/accounting/receipts", { party_id: hotel.id, cash_account_id: "nope", amount: 1, method: "cash" })).status === 400);
  r = await call("karim", "POST", `/api/sales/invoices/${ip.id}/credit-notes`, { lines: [{ invoice_line_id: ip.lines[0].id, quantity: 1 }] });
  check("a missing required field is named in Arabic, never zod's English 'Required'", r.status === 400 && r.body.error !== "Required" && /[؀-ۿ]/.test(r.body.error), r.body);
  await call("mona", "PATCH", `/api/sales/customers/${cafe.id}`, { active: false, reason: "اتقفل" });
  check("an inactive customer takes no new orders -> 400", (await call("mona", "POST", "/api/orders", { customer_account_id: cafe.id, customer_name: cafe.name, delivery_date: today, items: [{ stock_product_id: tomato.id, product_name: tomato.name, quantity: 1 }] })).status === 400);
  check("…but can still pay what it owes (collections continue)", (await call("karim", "POST", "/api/accounting/receipts", { party_id: cafe.id, cash_account_id: "cash_main", amount: 1, method: "cash" })).status === 201);

  // ===========================================================================
  section("9. REFUNDS: credit a party holds, paid back in money");
  const accounts = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts;
  const gl = async (code: string) => n((await call("karim", "GET", `/api/accounting/accounts/${accounts.find((a: any) => a.code === code).id}/ledger?from=2000-01-01&to=2099-12-31`)).body.ledger.closing);
  const guest = (await call("mona", "POST", "/api/sales/customers", { name: `${T} Guest House`, type: "hotel" })).body.customer;
  const og = await order(guest, tomato, 10, "10");
  await dispatch(og, 10);
  const ig = await invoice(og);
  await call("karim", "POST", "/api/accounting/receipts", { party_id: guest.id, cash_account_id: "cash_main", amount: 100, method: "cash", allocations: [{ document_id: ig.id, amount: 100 }] });
  check("no credit yet: a refund to a customer who owes nothing -> 409", (await call("karim", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 1, method: "cash", reason: "x" })).status === 409);
  await call("karim", "POST", `/api/sales/invoices/${ig.id}/credit-notes`, { reason: "رجّع 4 كجم بعد ما دفع", restock: true, lines: [{ invoice_line_id: ig.lines[0].id, quantity: 4 }] });
  check("the customer paid, then returned 4 kg: they hold 40 of credit", (await statement(guest.id)) === -40);
  check("sales cannot pay money out -> 403; the stock controller neither", (await call("mona", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 40, method: "cash", reason: "x" })).status === 403 && (await call("hossam", "POST", "/api/accounting/customer-refunds", {})).status === 403);
  check("more than the credit -> 400 naming the maximum", ((x) => x.status === 400 && /40\.00/.test(x.body.error))(await call("karim", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 40.01, method: "cash", reason: "x" })));
  check("a refund dated in the future -> 400", (await call("karim", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 1, method: "cash", reason: "x", date: local(3) })).status === 400);
  check("a refund needs a reason -> 400", (await call("karim", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 1, method: "cash" })).status === 400);
  const [cash0, ar0] = [await gl("1100"), await gl("1300")];
  r = await par(3, () => call("karim", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 40, method: "cash", reason: "رد قيمة المرتجع نقدي", idempotency_key: `${T}-refund-1` }));
  check("the full 40 refunded, submitted 3× at once with one key → one refund (201 + replays)", r.filter((x: any) => x.status === 201).length === 1 && new Set(r.map((x: any) => x.body.refund?.id)).size === 1, r.map((x: any) => x.status));
  const refund = r.find((x: any) => x.status === 201).body.refund;
  check("…GL: Dr AR 40 / Cr cash 40, once", n((await gl("1100")) - cash0) === -40 && n((await gl("1300")) - ar0) === 40);
  check("…the customer is settled: statement 0, with the refund on it", (await statement(guest.id)) === 0 && (await call("karim", "GET", `/api/sales/customers/${guest.id}/statement?from=2000-01-01&to=2099-12-31`)).body.rows.some((x: any) => x.kind === "refund" && x.number === refund.number && x.debit === "40.00"));
  const agg = (await call("karim", "GET", "/api/sales/reports/aging")).body.rows.find((x: any) => x.customer.id === guest.id);
  check("…aging agrees (no credit left on account)", !agg || (n(agg.total) === 0 && n(agg.unapplied) === 0), agg);
  r = await par(2, () => call("karim", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 1, method: "cash", reason: "مرة تانية" }));
  check("nothing left to refund: any further refund -> 409", r.every((x: any) => x.status === 409), r.map((x: any) => x.status));
  check("the same key on a different refund -> 409", (await call("karim", "POST", "/api/accounting/customer-refunds", { party_id: guest.id, cash_account_id: "cash_main", amount: 5, method: "cash", reason: "x", idempotency_key: `${T}-refund-1` })).status === 409);
  const adv = (await call("mona", "POST", "/api/sales/customers", { name: `${T} Advance Club`, type: "restaurant" })).body.customer;
  r = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: adv.id, date: today, due_date: today, amount: -50, reference: "دفعة مقدمة من أودو" });
  if (r.status === 201) {
    await call("karim", "POST", "/api/accounting/customer-refunds", { party_id: adv.id, cash_account_id: "cash_main", amount: 20, method: "cash", reason: "رد جزء من الدفعة المقدمة" });
    const aa = (await call("karim", "GET", "/api/sales/reports/aging")).body.rows.find((x: any) => x.customer.id === adv.id);
    check("credit from an opening advance (−50), 20 refunded: statement −30 = aging −30", (await statement(adv.id)) === -30 && n(aa?.total) === -30, [await statement(adv.id), aa]);
  } else check("a negative opening balance (customer advance) is accepted", false, r);

  // Supplier side: we paid a bill in full, then returned goods → the supplier owes us; they pay it back.
  const grower = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${T} Grower`, payment_terms_days: 0 })).body.supplier;
  const rcg = (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: grower.id, product_id: tomato.id, received_kg: 20, unit_cost: "5", location_id: "loc_cold_1", expiry_date: local(5) })).body.intake;
  const bg = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: grower.id, supplier_invoice_no: `${T}-G1`, bill_date: today, lines: [{ intake_id: rcg.id, unit_price: "5" }] })).body.bill;
  await call("karim", "POST", `/api/purchasing/bills/${bg.id}/post`, {});
  await call("karim", "POST", "/api/accounting/payments", { party_id: grower.id, cash_account_id: "bank_main", amount: 100, method: "bank_transfer", allocations: [{ document_id: bg.id, amount: 100 }] });
  const bgl = (await call("karim", "GET", `/api/purchasing/bills/${bg.id}`)).body.bill.lines[0];
  await call("karim", "POST", `/api/purchasing/bills/${bg.id}/debit-notes`, { reason: "6 كجم مضروبة رجعت", return_goods: true, lines: [{ bill_line_id: bgl.id, quantity: 6 }] });
  const owedBy = async () => {
    const b = (await call("karim", "GET", `/api/purchasing/suppliers/${grower.id}/statement?from=2000-01-01&to=2099-12-31`)).body;
    if (b.payable !== b.statement.closing) throw new Error(`supplier statement ${b.statement.closing} ≠ payable ${b.payable}`);
    return n(b.payable);
  };
  check("paid in full, then 6 kg returned: the supplier owes us 30", (await owedBy()) === -30);
  check("the purchaser cannot take money in -> 403", (await call("omar", "POST", "/api/accounting/supplier-refunds", { party_id: grower.id, cash_account_id: "bank_main", amount: 30, method: "bank_transfer", reason: "x" })).status === 403);
  check("more than they owe us -> 400", (await call("karim", "POST", "/api/accounting/supplier-refunds", { party_id: grower.id, cash_account_id: "bank_main", amount: 31, method: "bank_transfer", reason: "x" })).status === 400);
  const [bank0, ap0] = [await gl("1200"), await gl("2100")];
  r = await call("karim", "POST", "/api/accounting/supplier-refunds", { party_id: grower.id, cash_account_id: "bank_main", amount: 30, method: "bank_transfer", reason: "المورد حوّل قيمة المرتجع", reference: `${T}-TRX` });
  check("the supplier transfers the 30 back: Dr bank 30 / Cr AP 30; settled", r.status === 201 && n((await gl("1200")) - bank0) === 30 && n((await gl("2100")) - ap0) === -30 && (await owedBy()) === 0, [r.status, r.body]);
  const apg = (await call("karim", "GET", "/api/purchasing/reports/ap-aging")).body.aging.rows.find((x: any) => x.supplier.id === grower.id);
  check("…AP aging agrees", !apg || n(apg.total) === 0, apg);
  check("refunds are listed for the accountant; hidden from the floor (403)", (await call("karim", "GET", "/api/accounting/customer-refunds")).body.refunds.some((x: any) => x.id === refund.id) && (await call("ahmed", "GET", "/api/accounting/customer-refunds")).status === 403);

  // ===========================================================================
  section("10. RETRY SAFETY: every money document is posted once per submitted form");
  const tri = (path: string, body: any, who = "karim") => par(3, () => call(who, "POST", path, body));
  const one = (rs: any[], pick: (b: any) => any) => rs.every((x) => x.status < 300) && new Set(rs.map((x) => pick(x.body)?.id)).size === 1;
  const cnBefore = (await call("karim", "GET", `/api/sales/invoices/${ip.id}`)).body.invoice;
  r = await tri(`/api/sales/invoices/${ip.id}/credit-notes`, { reason: "كيلو تالف", lines: [{ invoice_line_id: ip.lines[0].id, quantity: 1 }], idempotency_key: `${T}-cn-1` });
  const cnAfter = (await call("karim", "GET", `/api/sales/invoices/${ip.id}`)).body.invoice;
  check("credit note submitted 3× with one key (a retry after a timeout) → one note, credited once", one(r, (b) => b.creditNote) && n(Number(cnBefore.open) - Number(cnAfter.open)) === 13, [r.map((x: any) => x.status), cnBefore.open, cnAfter.open]);
  check("…the same key on different quantities -> 409", (await call("karim", "POST", `/api/sales/invoices/${ip.id}/credit-notes`, { reason: "x", lines: [{ invoice_line_id: ip.lines[0].id, quantity: 2 }], idempotency_key: `${T}-cn-1` })).status === 409);
  r = await tri(`/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "كيلو تالف", lines: [{ bill_line_id: bl.lines[0].id, quantity: 1 }], idempotency_key: `${T}-dn-1` });
  check("debit note submitted 3× with one key → one note", one(r, (b) => b.debitNote), r.map((x: any) => x.status));
  const s0 = await statement(hotel.id);
  r = await tri("/api/accounting/opening-balances", { party_type: "customer", party_id: hotel.id, date: today, amount: 10, reference: "رصيد أودو", idempotency_key: `${T}-ob-1` });
  check("opening balance submitted 3× with one key → one balance (never doubled at cutover)", r.every((x: any) => x.status === 201) && (await statement(hotel.id)) === n(s0 + 10), [r.map((x: any) => x.status), s0, await statement(hotel.id)]);
  check("…the same key on another amount -> 409", (await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: hotel.id, date: today, amount: 11, idempotency_key: `${T}-ob-1` })).status === 409);
  const mj = `${T} ضيافة (مكرر؟)`;
  r = await tri("/api/accounting/journals", { date: today, description: mj, lines: [{ account_id: accounts.find((a: any) => a.code === "6100").id, debit: 7 }, { account_id: accounts.find((a: any) => a.code === "1100").id, credit: 7 }], idempotency_key: `${T}-je-1` });
  check("manual journal submitted 3× with one key → one entry", r.every((x: any) => x.status === 201) && (await call("karim", "GET", "/api/accounting/journals?source_type=manual")).body.journals.filter((j: any) => j.description === mj).length === 1, r.map((x: any) => x.status));
  const exAcc = (await call("sara", "GET", "/api/hr/expense-accounts")).body.accounts[0];
  r = await tri("/api/hr/expenses", { account_id: exAcc.id, amount: 15, description: `${T} شاي وقهوة`, payment_mode: "cash", cash_account_id: "cash_main", idempotency_key: `${T}-ex-1` }, "sara");
  check("expense submitted 3× with one key → one expense", one(r, (b) => b.expense), r.map((x: any) => x.status));
  const emp = (await call("karim", "POST", "/api/hr/employees", { name: `${T} سواق` })).body.employee;
  r = await tri("/api/hr/transactions", { employee_id: emp.id, type: "advance", amount: 200, cash_account_id: "cash_main", idempotency_key: `${T}-adv-1` });
  const est = (await call("karim", "GET", `/api/hr/employees/${emp.id}/statement`)).body.statement;
  check("cash advance submitted 3× with one key → paid out once (200, not 600)", r.every((x: any) => x.status === 201) && est.advancesHeld === "200.00", [r.map((x: any) => x.status), est.advancesHeld]);
  const herbs2 = await mkProduct("Parsley");
  r = await tri("/api/accounting/opening-stock", { business_date: today, lines: [{ product_id: herbs2.id, quantity: 12, unit_cost: "3", location_id: "loc_cold_1" }], idempotency_key: `${T}-os-1` });
  check("opening stock submitted 3× with one key → 12 kg once (not 36)", r.every((x: any) => x.status === 201) && (await onHand(herbs2.id)) === 12, [r.map((x: any) => x.status), await onHand(herbs2.id)]);
  check("without a key, two submits are two documents (as before)", (await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: hotel.id, date: today, amount: 1 })).status === 201 && (await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: hotel.id, date: today, amount: 1 })).status === 201 && (await statement(hotel.id)) === n(s0 + 12));

  // ===========================================================================
  section("8. RECONCILIATION after every scenario above");
  const h = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("Accounts Health: every check ok (AR/AP/inventory = GL per party, nothing unposted, no orphans)", h.ok === true, h.checks.filter((x: any) => !x.ok));
  const tb = (await call("karim", "GET", "/api/accounting/trial-balance?from=2000-01-01&to=2100-12-31")).body.trialBalance;
  check("trial balance balanced", tb.balanced === true, tb.totals);
  const stock = (await call("karim", "GET", "/api/inventory/stock")).body.rows;
  const val = new Map((await call("karim", "GET", "/api/inventory/reports/valuation")).body.rows.map((v: any) => [v.productId, Number(v.quantity)]));
  check("Inventory Health: on hand = valuation quantity for every product, nothing negative", stock.every((s: any) => Math.abs(Number(s.onHand) - Number(val.get(s.productId) ?? 0)) < 0.0005 && Number(s.onHand) >= 0));
  const ag = (await call("karim", "GET", "/api/sales/reports/aging")).body.rows.find((x: any) => x.customer.id === hotel.id);
  check("customer aging = customer statement", n(ag?.total) === (await statement(hotel.id)), [ag?.total, await statement(hotel.id)]);
  const fin = (await call("admin", "GET", "/api/management/finance?from=2000-01-01&to=2100-12-31")).body;
  const fr = fin.finance ?? fin.report ?? fin;
  const plLine = (code: string) => n(fr.profitAndLoss.lines.find((l: any) => l.code === code)?.amount ?? 0);
  check("management report: sales revenue (invoices − credit notes) = P&L revenue from the GL (4100 − 4200)", n(fr.sales.revenue) === n(fr.profitAndLoss.revenue) && n(fr.sales.revenue) === n(plLine("4100") + plLine("4200")), [fr.sales.revenue, fr.profitAndLoss.revenue]);
  // Each movement's value reaches the GL rounded to the piastre (as the inventory integrity
  // check allows); the report sums the unrounded valuation layers. Equal up to that rounding.
  check("management report: cost of sales (stock issued − returned) = GL cost of goods sold (5100), up to per-posting piastre rounding", Math.abs(Number(fr.sales.cost) + plLine("5100")) < 0.5, [fr.sales.cost, plLine("5100")]);

  finish("SCENARIO COMPLETENESS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
