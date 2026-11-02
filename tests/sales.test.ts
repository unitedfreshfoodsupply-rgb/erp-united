/* Sales end to end: the customer master, credit terms, and how an incoming order
   finds its customer account (exactly, or not at all). */
import { call, login, makeChecker } from "./_harness";

const { check, section, finish } = makeChecker();
const TAG = `ZZSAL${Date.now() % 1_000_000_000}`;
const taxId = String(100000000 + (Date.now() % 899999999)).slice(0, 9);
let r: any;
const incomingOrder = (body: Record<string, unknown>) => call(null, "POST", "/api/orders", {
  ...body, external_id: `${TAG}-${Date.now()}-${Math.random()}`,
}, { "x-api-key": process.env.N8N_API_KEY! });

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mona", "karim"]) await login(u);

  section("1. CUSTOMER MASTER");
  r = await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Grand Hotel`, name_ar: `${TAG} الفندق الكبير`, type: "hotel", tax_registration_no: taxId, phone: "01000000000", city: "القاهرة", external_ref: `${TAG}-EXT-1` });
  check("sales creates a customer -> 201", r.status === 201 && /^CUS-\d{5,}$/.test(r.body.customer?.code), r.body);
  const hotel = r.body.customer;
  check("the same tax id is now allowed to repeat across cards (uniqueness removed)", (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Other`, tax_registration_no: taxId })).status === 201);
  check("a tax id that is not 9 digits -> 400", (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Bad`, tax_registration_no: "12345" })).status === 400);
  check("unknown customer type -> 400", (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Bad2`, type: "spaceship" })).status === 400);
  check("blank name -> 400", (await call("mona", "POST", "/api/sales/customers", { name: "  " })).status === 400);
  check("a name already used by another customer -> 409", (await call("mona", "POST", "/api/sales/customers", { name: `${TAG}  grand-hotel` })).status === 409);
  check("preparer cannot read customers -> 403", (await call("ahmed", "GET", "/api/sales/customers")).status === 403);
  check("stock controller cannot read customers -> 403", (await call("hossam", "GET", "/api/sales/customers")).status === 403);
  check("accountant can read customers", (await call("karim", "GET", `/api/sales/customers/${hotel.id}`)).status === 200);
  check("accountant cannot create customers -> 403", (await call("karim", "POST", "/api/sales/customers", { name: `${TAG} X` })).status === 403);
  check("search finds it by part of the name", (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG} Grand`)}`)).body.customers.some((c: any) => c.id === hotel.id));

  r = await call("mona", "PATCH", `/api/sales/customers/${hotel.id}`, { phone: "01111111111", expected_version: hotel.version });
  check("edit with the current version -> 200", r.status === 200 && r.body.customer.phone === "01111111111" && r.body.customer.version === hotel.version + 1, r.body);
  check("edit with a stale version -> 409", (await call("mona", "PATCH", `/api/sales/customers/${hotel.id}`, { phone: "0", expected_version: hotel.version })).status === 409);
  check("sales cannot touch credit fields through the general edit", (await call("mona", "PATCH", `/api/sales/customers/${hotel.id}`, { credit_limit: 1 })).body.customer?.creditLimit === null);

  section("2. CREDIT TERMS ARE FINANCE'S");
  check("sales cannot set credit -> 403", (await call("mona", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_limit: 1000, reason: "x" })).status === 403);
  check("supervisor cannot set credit -> 403", (await call("sara", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_limit: 1000, reason: "x" })).status === 403);
  check("credit change needs a reason -> 400", (await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_limit: 1000 })).status === 400);
  r = await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_limit: "50000.50", payment_terms_days: 30, reason: "اتفاقية توريد 2026" });
  check("accountant sets 30 days and 50,000.50 EGP", r.status === 200 && r.body.customer.creditLimit === "50000.5" && r.body.customer.paymentTermsDays === 30, r.body);
  check("negative limit -> 400", (await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_limit: -1, reason: "x" })).status === 400);
  check("terms beyond a year -> 400", (await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { payment_terms_days: 400, reason: "x" })).status === 400);
  check("hold without a reason for the hold -> 400", (await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_hold: true, reason: "x" })).status === 400);
  r = await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_hold: true, credit_hold_reason: "فواتير متأخرة", reason: "متابعة التحصيل" });
  check("hold with a reason", r.status === 200 && r.body.customer.creditHold === true);
  r = await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { credit_hold: false, reason: "اتسدد" });
  check("release the hold clears its reason", r.status === 200 && r.body.customer.creditHold === false && r.body.customer.creditHoldReason === null);

  section("3. NAMES, ALIASES, CONTACTS");
  r = await call("mona", "POST", `/api/sales/customers/${hotel.id}/aliases`, { alias: `${TAG} جراند` });
  check("add an alias", r.status === 201, r.body);
  const alias = r.body.alias;
  const other = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Cafe Nile` })).body.customer;
  check("an alias already owned by another customer -> 409", (await call("mona", "POST", `/api/sales/customers/${other.id}/aliases`, { alias: `${TAG} جراند` })).status === 409);
  const canonical = (await call("mona", "GET", `/api/sales/customers/${hotel.id}`)).body.customer.aliases.find((a: any) => a.kind === "canonical");
  check("the canonical name cannot be removed as an alias -> 400", (await call("mona", "DELETE", `/api/sales/customers/aliases/${canonical.id}`)).status === 400);
  r = await call("mona", "POST", `/api/sales/customers/${hotel.id}/contacts`, { name: "أ. هشام", role: "مدير المشتريات", phone: "0122", is_primary: true });
  check("add a primary contact", r.status === 201 && r.body.contact.isPrimary === true, r.body);
  const c1 = r.body.contact;
  r = await call("mona", "POST", `/api/sales/customers/${hotel.id}/contacts`, { name: "أ. ريم", phone: "0100", is_primary: true });
  check("a second primary demotes the first", r.status === 201 && r.body.contact.isPrimary === true);
  const contacts = (await call("mona", "GET", `/api/sales/customers/${hotel.id}`)).body.customer.contacts;
  check("…exactly one primary remains", contacts.filter((c: any) => c.isPrimary).length === 1 && contacts.find((c: any) => c.id === c1.id)?.isPrimary === false);

  section("4. ORDERS FIND THEIR CUSTOMER — EXACTLY");
  const order = (name: string, extra: Record<string, unknown> = {}) => incomingOrder({
    customer_name: name, delivery_date: "2026-12-10", items: [{ product_name: "Mango", quantity: 5 }], ...extra,
  });
  r = await order(`${TAG} grand_hotel`);
  check("written differently (case, separators) → mapped by name", r.body.order?.customerAccountId === hotel.id, r.body.order);
  r = await order(`${TAG} الفندق الكبير`);
  check("the Arabic name maps too", r.body.order?.customerAccountId === hotel.id);
  r = await order(`${TAG} جراند`);
  check("…and the alias", r.body.order?.customerAccountId === hotel.id);
  r = await order("اسم مختلف تماماً", { customer_id: `${TAG}-EXT-1` });
  check("the integration's customer id wins over the name", r.body.order?.customerAccountId === hotel.id);
  r = await order(`${TAG} Grand Hotl`);
  check("a near miss is NOT guessed: unmapped", r.status === 201 && r.body.order.customerAccountId === null);
  const typo = r.body.order;
  r = await order(`${TAG} whoever`, { customer_account_id: other.id });
  check("an account chosen on screen is used as-is", r.body.order?.customerAccountId === other.id);
  check("an unknown account id -> 400", (await order(`${TAG} x`, { customer_account_id: "nope" })).status === 400);

  section("5. A PERSON MAPS WHAT DID NOT MATCH");
  const unmapped = (await call("mona", "GET", "/api/sales/customers/unmapped")).body.names;
  check("the typo shows on the unmapped list", unmapped.some((n: any) => n.customerName === `${TAG} Grand Hotl` && n.orders >= 1), unmapped.slice(0, 5));
  check("preparer cannot map -> 403", (await call("ahmed", "POST", "/api/sales/customers/map", { customer_name: `${TAG} Grand Hotl`, customer_id: hotel.id })).status === 403);
  r = await call("mona", "POST", "/api/sales/customers/map", { customer_name: `${TAG} Grand Hotl`, customer_id: hotel.id });
  check("map it: alias recorded, open orders linked", r.status === 200 && r.body.ordersLinked >= 1, r.body);
  check("the earlier order is now linked", (await call("sara", "GET", `/api/orders/${typo.id}`)).body.order.customerAccountId === hotel.id);
  check("the next order with that spelling maps by itself", (await order(`${TAG} Grand Hotl`)).body.order.customerAccountId === hotel.id);
  check("mapping a name another customer owns -> 409", (await call("mona", "POST", "/api/sales/customers/map", { customer_name: `${TAG} Grand Hotl`, customer_id: other.id })).status === 409);

  section("6. A CLOSED ACCOUNT COLLECTS NOTHING NEW");
  const cafe = (await call("mona", "GET", `/api/sales/customers/${other.id}`)).body.customer;
  check("deactivate the cafe", (await call("mona", "PATCH", `/api/sales/customers/${other.id}`, { active: false, expected_version: cafe.version })).status === 200);
  check("its name no longer maps", (await order(`${TAG} Cafe Nile`)).body.order.customerAccountId === null);
  check("choosing it explicitly -> 400", (await order(`${TAG} y`, { customer_account_id: other.id })).status === 400);
  check("it is hidden from the default list", !(await call("mona", "GET", "/api/sales/customers")).body.customers.some((c: any) => c.id === other.id));
  check("…and shown with include_inactive", (await call("mona", "GET", "/api/sales/customers?include_inactive=1")).body.customers.some((c: any) => c.id === other.id));

  section("7. AUDIT");
  const hist = await call("mona", "GET", `/api/sales/customers/${hotel.id}/history`);
  const actions = (hist.body.logs ?? []).map((l: any) => l.action);
  for (const a of ["customer_created", "customer_edited", "customer_credit_changed", "customer_alias_added", "customer_contact_added", "order_customer_mapped"]) check(`customer history records ${a}`, actions.includes(a), actions.slice(0, 12));
  const credit = hist.body.logs.find((l: any) => l.action === "customer_credit_changed" && l.fieldChanged === "creditLimit");
  check("credit change carries who, old, new and why", credit?.userName === "كريم" && credit?.oldValue === null && credit?.newValue === "50000.5" && credit?.reason === "اتفاقية توريد 2026", credit);
  check("preparer cannot read customer history -> 403", (await call("ahmed", "GET", `/api/sales/customers/${hotel.id}/history`)).status === 403);

  section("8. PRICE LISTS AND DATED PRICES");
  const mango = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Mango`, unit: "KG" })).body.product;
  await call("hossam", "POST", `/api/inventory/products/${mango.id}/packagings`, { uom: "CRATE", qty_in_base_unit: 18 });
  const juice = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Juice`, unit: "KG" })).body.product;
  check("stock controller cannot see price lists -> 403", (await call("hossam", "GET", "/api/sales/price-lists")).status === 403);
  check("accountant can read prices", (await call("karim", "GET", "/api/sales/price-lists")).status === 200);
  check("accountant cannot create a price list -> 403", (await call("karim", "POST", "/api/sales/price-lists", { code: `${TAG}X`, name: "x" })).status === 403);
  r = await call("mona", "POST", "/api/sales/price-lists", { code: `${TAG}-STD`, name: "الأسعار العامة", is_default: true });
  check("sales creates the default list", r.status === 201 && r.body.priceList.isDefault === true, r.body);
  const std = r.body.priceList;
  r = await call("mona", "POST", "/api/sales/price-lists", { code: `${TAG}-HOTEL`, name: "فنادق" });
  const hotelList = r.body.priceList;
  check("a second list", r.status === 201 && hotelList.isDefault === false);
  check("lowercase / bad code is normalised or refused", (await call("mona", "POST", "/api/sales/price-lists", { code: "bad code!", name: "x" })).status === 400);
  r = await call("mona", "POST", `/api/sales/price-lists/${std.id}/prices`, { valid_from: "2026-12-01", prices: [{ product_id: mango.id, unit_price: "20" }, { product_id: juice.id, unit_price: 30 }] });
  check("prices from Dec 1st", r.status === 200 && r.body.created === 2, r.body);
  r = await call("mona", "POST", `/api/sales/price-lists/${std.id}/prices`, { valid_from: "2026-12-09", prices: [{ product_id: mango.id, unit_price: "22.5" }] });
  check("mango goes up from Dec 9th (a new row, history kept)", r.status === 200 && r.body.created === 1);
  check("negative price -> 400", (await call("mona", "POST", `/api/sales/price-lists/${std.id}/prices`, { valid_from: "2026-12-09", prices: [{ product_id: mango.id, unit_price: -1 }] })).status === 400);
  check("5 decimals -> 400", (await call("mona", "POST", `/api/sales/price-lists/${std.id}/prices`, { valid_from: "2026-12-09", prices: [{ product_id: mango.id, unit_price: "1.12345" }] })).status === 400);
  check("a unit the product has no packaging for -> 400", (await call("mona", "POST", `/api/sales/price-lists/${std.id}/prices`, { valid_from: "2026-12-09", prices: [{ product_id: mango.id, uom: "PALLET", unit_price: 1 }] })).status === 400);
  await call("mona", "POST", `/api/sales/price-lists/${hotelList.id}/prices`, { valid_from: "2026-12-01", prices: [{ product_id: mango.id, unit_price: "18" }] });
  const det = (await call("mona", "GET", `/api/sales/price-lists/${std.id}?date=2026-12-10`)).body;
  check("the list as of Dec 10th shows mango at 22.5", det.current.some((x: any) => x.productId === mango.id && x.unitPrice === "22.5"), det.current);
  const det5 = (await call("mona", "GET", `/api/sales/price-lists/${std.id}?date=2026-12-05`)).body;
  check("…and as of Dec 5th at 20", det5.current.some((x: any) => x.productId === mango.id && x.unitPrice === "20"));

  section("9. TAX CLASS PER PRODUCT");
  const taxes = (await call("mona", "GET", "/api/sales/tax-rates")).body.taxRates.map((t: any) => t.code);
  check("tax classes: EXEMPT, VAT14, VAT0", ["EXEMPT", "VAT14", "VAT0"].every((c) => taxes.includes(c)), taxes);
  check("tax classification is finance's: sales -> 403", (await call("mona", "PATCH", `/api/sales/products/${juice.id}/tax`, { tax_code: "VAT14", reason: "x" })).status === 403);
  check("changing a product's tax needs a reason -> 400", (await call("karim", "PATCH", `/api/sales/products/${juice.id}/tax`, { tax_code: "VAT14" })).status === 400);
  check("unknown tax -> 400", (await call("karim", "PATCH", `/api/sales/products/${juice.id}/tax`, { tax_code: "VAT99", reason: "x" })).status === 400);
  r = await call("karim", "PATCH", `/api/sales/products/${juice.id}/tax`, { tax_code: "VAT14", reason: "عصير مصنّع — خاضع للضريبة" });
  check("juice is VAT 14%", r.status === 200 && r.body.product.salesTaxCode === "VAT14", r.body);

  section("10. ORDERS ARE PRICED WHEN THEY ARRIVE");
  check("assigning a customer list needs pricing.manage (accountant -> 403)", (await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/price-list`, { price_list_id: hotelList.id, reason: "x" })).status === 403);
  r = await call("mona", "PATCH", `/api/sales/customers/${hotel.id}/price-list`, { price_list_id: hotelList.id, reason: "عقد الفنادق" });
  check("the hotel gets the hotel list", r.status === 200 && r.body.customer.priceListId === hotelList.id, r.body);
  r = await incomingOrder({ customer_name: `${TAG} Grand Hotel`, customer_account_id: hotel.id, delivery_date: "2026-12-10", items: [
    { product_name: `${TAG} Mango`, quantity: 10 },
    { product_name: `${TAG} Mango`, quantity: 2, unit: "CRATE" },
    { product_name: `${TAG} Juice`, quantity: 3 },
    { product_name: `${TAG} شيء مش متعرف`, quantity: 1 },
  ] });
  const po = r.body.order;
  check("order created", r.status === 201, r.body);
  check("the order payload itself carries no prices", po.items.every((i: any) => i.price === undefined && i.unitPrice === undefined));
  let pr = (await call("mona", "GET", `/api/orders/${po.id}/pricing`)).body;
  const ln = (i: number) => pr.lines.find((l: any) => l.itemId === po.items[i].id);
  check("mango from the hotel list: 10 × 18 = 180", ln(0).amounts?.net === "180.00" && ln(0).price.source === "list", ln(0));
  check("a crate = 18 kg × 18 = 324; 2 crates = 648", ln(1).price?.unitPrice === "324" && ln(1).amounts?.net === "648.00", ln(1));
  check("juice is not on the hotel list → default list: 3 × 30 = 90 + 14% = 102.60", ln(2).amounts?.net === "90.00" && ln(2).amounts?.tax === "12.60" && ln(2).amounts?.total === "102.60", ln(2));
  check("the unknown product stays unpriced", ln(3).price === null && pr.unpricedLines === 1);
  check("totals: net 918.00, tax 12.60, total 930.60", pr.totals.net === "918.00" && pr.totals.tax === "12.60" && pr.totals.total === "930.60", pr.totals);
  check("preparer cannot read prices -> 403", (await call("ahmed", "GET", `/api/orders/${po.id}/pricing`)).status === 403);
  check("stock controller cannot read prices -> 403", (await call("hossam", "GET", `/api/orders/${po.id}/pricing`)).status === 403);
  check("…and the preparer's order view has no price in it", !JSON.stringify((await call("ahmed", "GET", `/api/orders/${po.id}`)).body).includes("unitPrice"));
  r = await incomingOrder({ customer_name: `${TAG} walk-in`, delivery_date: "2026-12-05", items: [{ product_name: `${TAG} Mango`, quantity: 1 }] });
  check("an unknown customer is priced from the default list, by the delivery date (20 on Dec 5th)", (await call("mona", "GET", `/api/orders/${r.body.order.id}/pricing`)).body.lines[0].price?.unitPrice === "20");
  const walkIn = r.body.order;

  section("11. A PERSON CHANGES A PRICE — WITH A REASON");
  check("preparer cannot override -> 403", (await call("ahmed", "PATCH", `/api/orders/${po.id}/items/${po.items[2].id}/price`, { unit_price: 1, reason: "x" })).status === 403);
  check("override without a reason -> 400", (await call("mona", "PATCH", `/api/orders/${po.id}/items/${po.items[2].id}/price`, { unit_price: 28 })).status === 400);
  check("discount above 100% -> 400", (await call("mona", "PATCH", `/api/orders/${po.id}/items/${po.items[2].id}/price`, { unit_price: 28, discount_pct: 101, reason: "x" })).status === 400);
  check("pricing an unmapped line -> 400 (its tax is unknown)", (await call("mona", "PATCH", `/api/orders/${po.id}/items/${po.items[3].id}/price`, { unit_price: 5, reason: "x" })).status === 400);
  r = await call("mona", "PATCH", `/api/orders/${po.id}/items/${po.items[2].id}/price`, { unit_price: "28", discount_pct: 5, reason: "عرض أسبوعي" });
  check("juice at 28 with 5% off", r.status === 200 && r.body.price.source === "manual", r.body);
  pr = (await call("mona", "GET", `/api/orders/${po.id}/pricing`)).body;
  check("84.00 − 4.20 = 79.80 + 11.17 VAT = 90.97", ln(2).amounts.gross === "84.00" && ln(2).amounts.discount === "4.20" && ln(2).amounts.net === "79.80" && ln(2).amounts.tax === "11.17" && ln(2).amounts.total === "90.97", ln(2).amounts);
  await call("mona", "POST", `/api/sales/price-lists/${hotelList.id}/prices`, { valid_from: "2026-12-10", prices: [{ product_id: mango.id, unit_price: "19" }, { product_id: juice.id, unit_price: "25" }] });
  r = await call("mona", "POST", `/api/orders/${po.id}/reprice`, {});
  check("reprice refreshes list prices", r.status === 200 && r.body.priced >= 1, r.body);
  pr = (await call("mona", "GET", `/api/orders/${po.id}/pricing`)).body;
  check("…mango now 19 from the hotel's Dec 10th price", ln(0).price.unitPrice === "19");
  check("…the manual juice price is untouched", ln(2).price.unitPrice === "28" && ln(2).price.source === "manual");
  check("a used price cannot be corrected in place -> 409", (await call("mona", "POST", `/api/sales/price-lists/${hotelList.id}/prices`, { valid_from: "2026-12-10", prices: [{ product_id: mango.id, unit_price: "19.5" }] })).status === 409);
  r = await call("mona", "POST", `/api/sales/price-lists/${hotelList.id}/prices`, { valid_from: "2026-12-11", prices: [{ product_id: mango.id, unit_price: "19.5" }] });
  check("…the next day's price is a new row", r.status === 200 && r.body.created === 1);

  section("12. MAPPING LATER PRICES LATER");
  r = await call("sara", "POST", "/api/stock/products", { name: `${TAG} شيء مش متعرف بقى معروف`, unit: "KG" });
  const known = r.body.product;
  await call("mona", "POST", `/api/sales/price-lists/${std.id}/prices`, { valid_from: "2026-12-01", prices: [{ product_id: known.id, unit_price: "7" }] });
  r = await call("sara", "POST", "/api/stock/products/mapping", { product_name: `${TAG} شيء مش متعرف`, product_id: known.id, reason: "ده نفس الصنف" });
  check("map the unknown line to a product", r.status === 200 || r.status === 201, r.body);
  pr = (await call("mona", "GET", `/api/orders/${po.id}/pricing`)).body;
  check("…and it is priced (7 from the default list)", ln(3).price?.unitPrice === "7" && pr.unpricedLines === 0, ln(3));
  r = await call("mona", "POST", "/api/sales/customers/map", { customer_name: `${TAG} walk-in`, customer_id: hotel.id });
  check("map the walk-in name to the hotel", r.status === 200);
  check("…its order is repriced from the hotel list (18 on Dec 5th)", (await call("mona", "GET", `/api/orders/${walkIn.id}/pricing`)).body.lines[0].price?.unitPrice === "18");

  const histP = (await call("sara", "GET", `/api/audit?orderId=${po.id}`)).body.logs.map((l: any) => l.action);
  check("order history records pricing and the override", histP.includes("order_priced") && histP.includes("order_line_price_overridden"), histP);

  // ------------------------------------------------------------------------
  const setting = async (key: string, value: unknown) => {
    const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
    const r = await call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: TAG, expected_version: cur.version });
    if (r.status !== 200) throw new Error(`setting ${key}: ${JSON.stringify(r.body)}`);
  };

  section("13. QUOTATIONS");
  const qBody = { customer_id: hotel.id, delivery_date: "2026-12-12", lines: [{ product_id: mango.id, quantity: 10 }, { product_id: juice.id, quantity: "2.5", unit_price: "26" }] };
  check("accountant cannot write quotations -> 403", (await call("karim", "POST", "/api/sales/quotations", qBody)).status === 403);
  check("preparer cannot read quotations -> 403", (await call("ahmed", "GET", "/api/sales/quotations")).status === 403);
  r = await call("mona", "POST", "/api/sales/quotations", qBody);
  check("sales quotes the hotel -> 201", r.status === 201 && /^QUO-\d{4}-\d{5}$/.test(r.body.quotation.number) && r.body.quotation.status === "draft", r.body);
  let quo = (await call("mona", "GET", `/api/sales/quotations/${r.body.quotation.id}`)).body.quotation;
  check("mango from the hotel list on Dec 12th (19.5); juice by hand (26)", quo.lines[0].unitPrice === "19.5" && quo.lines[0].priceSource === "list" && quo.lines[1].unitPrice === "26" && quo.lines[1].priceSource === "manual", quo.lines);
  check("totals: 195 + 65 + 9.10 VAT = 269.10", quo.totals.net === "260.00" && quo.totals.tax === "9.10" && quo.totals.total === "269.10", quo.totals);
  check("valid until defaults to today + 3 days", quo.validUntil > quo.createdAt.slice(0, 10));
  check("accountant can read it", (await call("karim", "GET", `/api/sales/quotations/${quo.id}`)).status === 200);
  const noPrice = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Rare`, unit: "KG" })).body.product;
  check("a product with no price and none typed -> 400", (await call("mona", "POST", "/api/sales/quotations", { customer_id: hotel.id, lines: [{ product_id: noPrice.id, quantity: 1 }] })).status === 400);
  check("valid until in the past -> 400", (await call("mona", "POST", "/api/sales/quotations", { ...qBody, valid_until: "2020-01-01" })).status === 400);
  check("zero quantity -> 400", (await call("mona", "POST", "/api/sales/quotations", { customer_id: hotel.id, lines: [{ product_id: mango.id, quantity: 0 }] })).status === 400);
  check("an inactive customer -> 400", (await call("mona", "POST", "/api/sales/quotations", { ...qBody, customer_id: other.id })).status === 400);
  r = await call("mona", "PUT", `/api/sales/quotations/${quo.id}`, { ...qBody, lines: [{ product_id: mango.id, quantity: 12 }, qBody.lines[1]], expected_version: quo.version });
  check("a draft can be rewritten", r.status === 200, r.body);
  check("rewriting with a stale version -> 409", (await call("mona", "PUT", `/api/sales/quotations/${quo.id}`, { ...qBody, expected_version: quo.version })).status === 409);
  check("accept before sending -> 409", (await call("mona", "POST", `/api/sales/quotations/${quo.id}/transition`, { action: "accept" })).status === 409);
  check("send", (await call("mona", "POST", `/api/sales/quotations/${quo.id}/transition`, { action: "send" })).status === 200);
  check("a sent quotation cannot be rewritten -> 409", (await call("mona", "PUT", `/api/sales/quotations/${quo.id}`, qBody)).status === 409);
  check("unknown action -> 400", (await call("mona", "POST", `/api/sales/quotations/${quo.id}/transition`, { action: "maybe" })).status === 400);
  check("customer accepts", (await call("mona", "POST", `/api/sales/quotations/${quo.id}/transition`, { action: "accept", note: "وافق بالتليفون" })).status === 200);
  r = await call("mona", "POST", `/api/sales/quotations/${quo.id}/convert`, {});
  check("convert to an order -> 201", r.status === 201 && r.body.order.customerAccountId === hotel.id && r.body.order.deliveryDate === "2026-12-12", r.body);
  const qOrder = r.body.order;
  pr = (await call("mona", "GET", `/api/orders/${qOrder.id}/pricing`)).body;
  check("the order carries the quoted prices", pr.lines.every((l: any) => l.price?.source === "quotation") && pr.totals.net === "299.00" && pr.totals.total === "308.10", pr.totals);
  quo = (await call("mona", "GET", `/api/sales/quotations/${quo.id}`)).body.quotation;
  check("the quotation is converted and points at its order", quo.status === "converted" && quo.order?.id === qOrder.id);
  check("converting twice -> 409", (await call("mona", "POST", `/api/sales/quotations/${quo.id}/convert`, {})).status === 409);
  const q2 = (await call("mona", "POST", "/api/sales/quotations", qBody)).body.quotation;
  await call("mona", "POST", `/api/sales/quotations/${q2.id}/transition`, { action: "send" });
  check("rejecting needs a reason -> 400", (await call("mona", "POST", `/api/sales/quotations/${q2.id}/transition`, { action: "reject" })).status === 400);
  check("customer rejects", (await call("mona", "POST", `/api/sales/quotations/${q2.id}/transition`, { action: "reject", note: "السعر عالي" })).status === 200);
  check("a rejected quotation cannot become an order -> 409", (await call("mona", "POST", `/api/sales/quotations/${q2.id}/convert`, {})).status === 409);
  check("the list filters by status", (await call("mona", "GET", "/api/sales/quotations?status=rejected")).body.quotations.some((x: any) => x.id === q2.id));

  section("14. CREDIT CONTROL — BLOCK");
  await setting("sales.credit_check_mode", "block");
  const small = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Small Cafe` })).body.customer;
  await call("karim", "PATCH", `/api/sales/customers/${small.id}/credit`, { payment_terms_days: 15, credit_limit: 100, reason: "عميل جديد" });
  r = await incomingOrder({ customer_account_id: small.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 10 }] });
  const over = r.body.order;
  check("225 EGP on a 100 EGP limit: waiting for finance", over.creditStatus === "pending_approval", over);
  const ap = (await call("karim", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === over.id && a.type === "sales.credit");
  check("finance sees it in the approvals inbox", ap?.canDecide === true, ap);
  check("…sales cannot decide it", (await call("mona", "POST", `/api/approvals/${ap.id}/decide`, { decision: "approve" })).status === 403);
  check("the floor cannot start it -> 409", (await call("sara", "POST", `/api/orders/${over.id}/status`, { to: "preparing" })).status === 409);
  check("…not even a supervisor override", (await call("sara", "POST", `/api/orders/${over.id}/status`, { to: "loading", reason: "مستعجل" })).status === 409);
  r = await call("karim", "POST", `/api/approvals/${ap.id}/decide`, { decision: "approve", comment: "هيدفع كاش المرة دي" });
  check("finance approves", r.status === 200, r.body);
  check("…and preparation may start", (await call("sara", "POST", `/api/orders/${over.id}/status`, { to: "preparing" })).status === 200);
  const exp = (await call("karim", "GET", `/api/sales/customers/${small.id}/exposure`)).body;
  check("exposure shows the open order against the limit", exp.openOrders === "225.00" && exp.creditLimit === "100.00" && exp.available === "-125.00", exp);
  r = await incomingOrder({ customer_account_id: small.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 1 }] });
  check("a second order also exceeds it", r.body.order.creditStatus === "pending_approval");
  const second = r.body.order;
  check("cancelling it", (await call("sara", "POST", `/api/orders/${second.id}/cancel`, { reason: "اتلغى" })).status === 200);
  check("…withdraws its credit request", !(await call("karim", "GET", "/api/approvals?status=pending")).body.approvals.some((a: any) => a.entityId === second.id));
  const noLimit = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} No Limit` })).body.customer;
  await call("karim", "PATCH", `/api/sales/customers/${noLimit.id}/credit`, { payment_terms_days: 7, reason: "آجل" });
  r = await incomingOrder({ customer_account_id: noLimit.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 1 }] });
  check("a credit customer with no limit defined needs approval", r.body.order.creditStatus === "pending_approval" && /حد/.test(r.body.order.creditNote));
  const noLimitOrder = r.body.order;
  const cash = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Cash Buyer` })).body.customer;
  r = await incomingOrder({ customer_account_id: cash.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 100 }] });
  check("a cash customer is not credit-controlled", r.body.order.creditStatus === "not_applicable");
  check("…and starts at once", (await call("sara", "POST", `/api/orders/${r.body.order.id}/status`, { to: "preparing" })).status === 200);
  await call("karim", "PATCH", `/api/sales/customers/${cash.id}/credit`, { credit_hold: true, credit_hold_reason: "شيك مرتجع", reason: "x" });
  r = await incomingOrder({ customer_account_id: cash.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 1 }] });
  check("…but on credit hold even a cash customer waits for finance", r.body.order.creditStatus === "pending_approval" && r.body.order.creditNote === "العميل موقوف آجل");
  const holdOrder = r.body.order;
  const holdReq = (await call("karim", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === holdOrder.id);
  check("…finance sees why (the hold reason) on the request", /شيك مرتجع/.test(`${holdReq?.summary ?? ""} ${holdReq?.requestReason ?? ""}`), holdReq);
  check("…the floor's view of the order does not", !JSON.stringify((await call("ahmed", "GET", `/api/orders/${holdOrder.id}`)).body).includes("شيك مرتجع"));
  check("…and the request is raised by the credit control, not by whoever created the order", holdReq?.requestedBy === "رقابة الائتمان");
  r = await incomingOrder({ customer_name: `${TAG} someone new`, delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 1 }] });
  check("an unmapped customer cannot be judged: not applicable", r.body.order.creditStatus === "not_applicable");
  const rej = (await call("karim", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === noLimitOrder.id && a.type === "sales.credit");
  check("finance rejects a credit request (with a reason)", (await call("karim", "POST", `/api/approvals/${rej.id}/decide`, { decision: "reject", comment: "لازم حد ائتمان الأول" })).status === 200);
  check("…the order is marked rejected and still cannot start", (await call("sara", "GET", `/api/orders/${noLimitOrder.id}`)).body.order.creditStatus === "rejected" && (await call("sara", "POST", `/api/orders/${noLimitOrder.id}/status`, { to: "preparing" })).status === 409);

  section("15. CREDIT CONTROL — WARN");
  await setting("sales.credit_check_mode", "warn");
  const karimUnread = (await call("karim", "GET", "/api/notifications")).body.unread;
  r = await incomingOrder({ customer_account_id: small.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 5 }] });
  check("warn: over the limit is flagged, not held", r.body.order.creditStatus === "warning");
  check("…the floor may start it", (await call("sara", "POST", `/api/orders/${r.body.order.id}/status`, { to: "preparing" })).status === 200);
  check("…and finance is told", (await call("karim", "GET", "/api/notifications")).body.unread > karimUnread);
  await setting("sales.credit_check_mode", null);

  section("16. AUTOMATIC RESERVATION");
  await call("hossam", "POST", "/api/stock/intakes", { provisional_unit_cost: "1", supplier_id: (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier.id, product_id: mango.id, received_kg: 100 });
  const avail = async () => (await call("sara", "GET", `/api/inventory/products/${mango.id}`)).body;
  const base = await avail();
  await setting("sales.auto_reserve", true);
  r = await incomingOrder({ customer_account_id: hotel.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 30 }] });
  const ro = r.body.order;
  let a = await avail();
  check("an order reserves its 30 kg on arrival", Number(a.reserved) - Number(base.reserved) === 30, [base.reserved, a.reserved]);
  check("editing the required quantity moves the reservation", (await call("sara", "POST", `/api/orders/${ro.id}/items/${ro.items[0].id}/required`, { quantity: 40, reason: "زودوا" })).status === 200 && Number((await avail()).reserved) - Number(base.reserved) === 40);
  r = await incomingOrder({ customer_account_id: hotel.id, customer_name: "x", delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 500 }] });
  a = await avail();
  check("a bigger order than the stock reserves what there is (never refused)", r.status === 201 && a.available === "0", a.available);
  check("cancelling releases it", (await call("sara", "POST", `/api/orders/${r.body.order.id}/cancel`, { reason: "x" })).status === 200 && Number((await avail()).available) > 0);
  await setting("sales.auto_reserve", null);

  section("17. INVOICE A DISPATCHED ORDER");
  const ship = { vehicle: "ن ق ل 1", driver_name: "سواق", crate_count: 2 };
  check("an order still in work cannot be invoiced -> 409", (await call("karim", "POST", "/api/sales/invoices", { order_id: qOrder.id })).status === 409);
  check("loading", (await call("sara", "POST", `/api/orders/${qOrder.id}/status`, { to: "loading", reason: "مباشر" })).status === 200);
  const qo = (await call("sara", "GET", `/api/orders/${qOrder.id}`)).body.order;
  const mangoLine = qo.items.find((i: any) => i.stockProductId === mango.id);
  const juiceLine = qo.items.find((i: any) => i.stockProductId === juice.id);
  await call("sara", "POST", `/api/orders/${qOrder.id}/items/${mangoLine.id}/load`, { quantity: 11.5, mark_done: true });
  await call("sara", "POST", `/api/orders/${qOrder.id}/items/${juiceLine.id}/load`, { quantity: 2.5, mark_done: true });
  r = await call("sara", "POST", `/api/orders/${qOrder.id}/status`, { to: "dispatched", reason: "خرج", ...ship });
  check("dispatched with 11.5 kg of mango loaded (12 ordered)", r.status === 200, r.body);
  const todo = (await call("karim", "GET", "/api/sales/invoices/to-invoice")).body.orders;
  check("it is on the accountant's to-invoice list", todo.some((o: any) => o.id === qOrder.id && o.unpricedLines === 0), todo.slice(0, 3));
  check("sales cannot draft invoices -> 403", (await call("mona", "POST", "/api/sales/invoices", { order_id: qOrder.id })).status === 403);
  check("preparer cannot see invoices -> 403", (await call("ahmed", "GET", "/api/sales/invoices")).status === 403);
  r = await call("karim", "POST", "/api/sales/invoices", { order_id: qOrder.id });
  check("accountant drafts the invoice -> 201", r.status === 201 && r.body.invoice.status === "draft" && r.body.invoice.number === null, r.body);
  const inv0 = r.body.invoice;
  check("again: the same draft comes back (200)", (await call("karim", "POST", "/api/sales/invoices", { order_id: qOrder.id })).body.invoice?.id === inv0.id);
  let inv = (await call("karim", "GET", `/api/sales/invoices/${inv0.id}`)).body.invoice;
  const il = (pid: string) => inv.lines.find((l: any) => l.productId === pid);
  check("invoiced on what left: 11.5 kg × 19.5 = 224.25", il(mango.id).quantity === "11.5" && il(mango.id).net === "224.25", il(mango.id));
  check("juice 2.5 × 26 = 65 + 9.10 VAT", il(juice.id).net === "65" && il(juice.id).tax === "9.1");
  check("invoice total 298.35", inv.total === "298.35" && inv.taxTotal === "9.1", [inv.net, inv.taxTotal, inv.total]);
  r = await call("karim", "POST", `/api/sales/invoices/${inv0.id}/void`, { reason: "مراجعة" });
  check("a draft can be voided", r.status === 200 && r.body.invoice.status === "void");
  check("…which frees the order to be invoiced again", (await call("karim", "POST", "/api/sales/invoices", { order_id: qOrder.id })).status === 201);
  inv = (await call("karim", "GET", `/api/sales/invoices?order_id=${qOrder.id}&status=draft`)).body.invoices[0];
  check("a future issue date -> 400", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, { issue_date: "2099-01-01" })).status === 400);
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, { expected_version: inv.version });
  check("issue: numbered INV-YYYY-#####, due in 30 days, buyer frozen", r.status === 200 && /^INV-\d{4}-\d{5}$/.test(r.body.invoice.number) && r.body.invoice.buyerTaxId === taxId && r.body.invoice.dueDate > r.body.invoice.issueDate, r.body);
  inv = r.body.invoice;
  check("issuing twice -> 409", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {})).status === 409);
  check("an issued invoice cannot be voided -> 409", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/void`, { reason: "x" })).status === 409);
  check("…and the order cannot be reopened while it stands -> 409", (await call("sara", "POST", `/api/orders/${qOrder.id}/reopen`, { to: "loading", reason: "x" })).status === 409);
  check("sales can read invoices", (await call("mona", "GET", `/api/sales/invoices/${inv.id}`)).status === 200);

  section("18. CREDIT NOTES");
  inv = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
  const mLine = inv.lines.find((l: any) => l.productId === mango.id);
  const jLine = inv.lines.find((l: any) => l.productId === juice.id);
  check("credit note needs a reason -> 400", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { lines: [{ invoice_line_id: mLine.id, quantity: 1 }] })).status === 400);
  check("more than invoiced -> 400", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "x", lines: [{ invoice_line_id: mLine.id, quantity: 12 }] })).status === 400);
  check("a line from another invoice -> 400", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "x", lines: [{ invoice_line_id: "nope", quantity: 1 }] })).status === 400);
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "2 كيلو رجعوا تالفين", lines: [{ invoice_line_id: mLine.id, quantity: 2 }] });
  check("credit 2 kg of mango: 39.00", r.status === 201 && /^CN-\d{4}-\d{5}$/.test(r.body.creditNote.number) && r.body.creditNote.total === "39", r.body);
  check("crediting 10 more kg -> 400 (only 9.5 left)", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "x", lines: [{ invoice_line_id: mLine.id, quantity: 10 }] })).status === 400);
  inv = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
  check("invoice shows 39 credited, 259.35 open", inv.credited === "39.00" && inv.open === "259.35", [inv.credited, inv.open]);
  const recv = (await call("karim", "GET", `/api/sales/customers/${hotel.id}/exposure`)).body;
  check("the hotel's receivable is 259.35", recv.receivable === "259.35", recv);
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "إلغاء باقي الفاتورة", full: true });
  check("credit the rest in full: exactly 259.35, to the piastre", r.status === 201 && r.body.creditNote.total === "259.35", r.body.creditNote);
  check("nothing left to credit -> 409", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "x", full: true })).status === 409);
  check("receivable back to 0", (await call("karim", "GET", `/api/sales/customers/${hotel.id}/exposure`)).body.receivable === "0.00");
  check("sales cannot issue credit notes -> 403", (await call("mona", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "x", full: true })).status === 403);
  void jLine;

  section("19. STATEMENT AND AGING");
  const st = (await call("karim", "GET", `/api/sales/customers/${hotel.id}/statement`)).body;
  check("statement: invoice, two credit notes, closing 0", st.rows.length === 3 && st.rows[0].kind === "invoice" && st.rows[0].debit === "298.35" && st.closing === "0.00", st);
  check("…running balance after the first credit is 259.35", st.rows[1].balance === "259.35");
  check("bad period -> 400", (await call("karim", "GET", `/api/sales/customers/${hotel.id}/statement?from=2026-12-01&to=2026-01-01`)).status === 400);
  // A second invoice, left open, ages.
  r = await incomingOrder({ customer_account_id: hotel.id, customer_name: "x", delivery_date: "2026-12-12", items: [{ product_name: `${TAG} Mango`, quantity: 4 }] });
  const o4 = r.body.order;
  await call("sara", "POST", `/api/orders/${o4.id}/status`, { to: "dispatched", reason: "خرج", ...ship });
  const d4 = (await call("karim", "POST", "/api/sales/invoices", { order_id: o4.id })).body.invoice;
  check("an invoice may carry a past date", (await call("karim", "POST", `/api/sales/invoices/${d4.id}/issue`, { issue_date: "2026-08-01" })).status === 200);
  const ag = (await call("karim", "GET", "/api/sales/reports/aging?as_of=2026-10-08")).body;
  const hRow = ag.rows.find((x: any) => x.customer.id === hotel.id);
  check("aging: due Aug 31st, 38 days overdue on Oct 8th → 31–60 bucket (4 × 19.5 = 78)", hRow?.d31_60 === "78.00" && hRow?.total === "78.00", hRow);
  check("preparer cannot read aging -> 403", (await call("ahmed", "GET", "/api/sales/reports/aging")).status === 403);
  const expo = (await call("karim", "GET", `/api/sales/customers/${hotel.id}/exposure`)).body;
  check("credit exposure counts the open invoice as receivable", expo.receivable === "78.00", expo);

  finish("SALES");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
