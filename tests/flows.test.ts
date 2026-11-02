/* UNITED's real business flows, end to end, across every department. Each step is
   checked where its effects must land: stock quantity, stock value, the GL accounts,
   the customer / supplier balance and statement, and the reports — and the ledger
   integrity check must come out clean at the end. This is the "can Odoo be removed"
   suite: one source of truth, no module stopping short of the next. */
import { call, login, makeChecker } from "./_harness";
import { todayBiz, bizDay } from "./_days";
import { setSetting, taxNo, fundCash } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `ZZFLOW${Date.now() % 1_000_000_000}`;
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"]) await login(u);
  const today = todayBiz();
  const accounts = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts;
  const acc = (code: string) => accounts.find((a: any) => a.code === code).id;
  const gl = async (code: string) => Number((await call("karim", "GET", `/api/accounting/accounts/${acc(code)}/ledger?from=2000-01-01&to=2099-12-31`)).body.ledger.closing);
  const snapshot = async () => ({ inv: await gl("1400"), cogs: await gl("5100"), ar: await gl("1300"), ap: await gl("2100"), grni: await gl("2150"), bank: await gl("1200"), sales: await gl("4100"), returns: await gl("4200"), opening: await gl("3300") });
  const delta = (a: any, b: any, k: string) => Math.round((b[k] - a[k]) * 100) / 100;
  const onHand = async (pid: string) => Number((await call("hossam", "GET", `/api/inventory/products/${pid}`)).body.onHand);
  const stockValue = async (pid: string) => Number((await call("karim", "GET", "/api/inventory/reports/valuation")).body.rows.find((x: any) => x.productId === pid)?.value ?? 0);
  const receivable = async (id: string) => (await call("karim", "GET", `/api/sales/customers/${id}/statement?from=2000-01-01&to=2099-12-31`)).body.closing;
  const payable = async (id: string) => (await call("karim", "GET", `/api/purchasing/suppliers/${id}/statement?from=2000-01-01&to=2099-12-31`)).body.payable;

  // -------------------------------------------------------------------------
  section("1. GO-LIVE: OPENING BALANCES FROM ODOO");
  const potato = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Potato`, unit: "KG" })).body.product;
  // MIG-01: the chain is invoiced below, so its card carries a 9-digit tax number.
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} سلسلة مطاعم`, tax_registration_no: taxNo() })).body.customer;
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مزرعة البطاطس`, payment_terms_days: 30 })).body.supplier;
  check("only accounting brings balances over -> 403 for the floor and sales", (await call("hossam", "POST", "/api/accounting/opening-stock", { lines: [] })).status === 403 && (await call("mona", "POST", "/api/accounting/opening-balances", {})).status === 403);
  // CTL-01: direct opening entries are closed by default (an approved opening batch is the
  // path). This go-live scenario exercises the direct path itself, so it switches it on by
  // an audited settings change and restores the default at the end of the section.
  r = await call("karim", "POST", "/api/accounting/opening-stock", { business_date: today, lines: [{ product_id: potato.id, quantity: 200, unit_cost: "6", expiry_date: "2099-01-01" }] });
  check("default (direct opening OFF): opening stock -> 409 direct_opening_disabled", r.status === 409 && r.body.code === "direct_opening_disabled", r.body);
  r = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: customer.id, date: today, amount: 5000, reference: "رصيد أودو" });
  check("default (direct opening OFF): party opening balance -> 409 direct_opening_disabled", r.status === 409 && r.body.code === "direct_opening_disabled", r.body);
  check("…nothing was posted", (await onHand(potato.id)) === 0 && (await receivable(customer.id)) === "0.00");
  check("direct opening entries switched ON for the go-live scenario", (await setSetting("accounting.direct_opening_entries", true, `${TAG} go-live scenario`)).status === 200);
  check("opening stock without a unit cost -> 400 (never valued at zero by accident)", (await call("karim", "POST", "/api/accounting/opening-stock", { business_date: today, lines: [{ product_id: potato.id, quantity: 5 }] })).status === 400);
  let s0 = await snapshot();
  r = await call("karim", "POST", "/api/accounting/opening-stock", { business_date: today, lines: [{ product_id: potato.id, quantity: 200, unit_cost: "6", expiry_date: "2099-01-01" }] });
  check("opening stock: 200 kg potato at 6", r.status === 201, r.body);
  let s1 = await snapshot();
  check("…stock 200 kg, valued 1200", (await onHand(potato.id)) === 200 && (await stockValue(potato.id)) === 1200);
  check("…GL: Dr Inventory 1200 / Cr opening equity 1200 (not an expense)", delta(s0, s1, "inv") === 1200 && delta(s0, s1, "opening") === -1200);
  r = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: customer.id, date: today, amount: 5000, reference: "رصيد أودو" });
  check("customer owes 5000 from Odoo", r.status === 201, r.body);
  await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "supplier", party_id: supplier.id, date: today, amount: 3000, reference: "رصيد أودو" });
  check("…the customer's statement and the GL agree: 5000", (await receivable(customer.id)) === "5000.00");
  check("…the supplier's statement says we owe 3000", (await payable(supplier.id)) === "3000.00");
  check("direct opening entries restored to the default (OFF)", (await setSetting("accounting.direct_opening_entries", null, `${TAG} go-live scenario done`)).status === 200);

  // -------------------------------------------------------------------------
  section("2. PURCHASE: PO → RECEIVE (SORTED) → STOCK & VALUE → BILL → AP → PAYMENT");
  // L2: the bank never goes negative — the owner funds it before the supplier is paid.
  await fundCash("bank_main", 5000);
  const po = (await call("omar", "POST", "/api/purchasing/orders", { supplier_id: supplier.id, lines: [{ product_id: potato.id, quantity: 500, unit_price: "5" }] })).body.order;
  await call("omar", "POST", `/api/purchasing/orders/${po.id}/submit`, {});
  check("PO approved and sent", (await call("omar", "POST", `/api/purchasing/orders/${po.id}/send`, {})).body.order?.status === "sent");
  s0 = await snapshot();
  const before = await onHand(potato.id);
  r = await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: po.lines[0].id, received_kg: 500, rejected_kg: 20, rejection_reason: "مضروبة" });
  check("received 500 kg, 20 sorted out", r.status === 201, r.body);
  const receipt = r.body.intake;
  s1 = await snapshot();
  check("…only the accepted 480 kg entered stock", (await onHand(potato.id)) - before === 480);
  check("…and the GL moved in the same step: Dr Inventory 2400 / Cr GRNI 2400", delta(s0, s1, "inv") === 2400 && delta(s0, s1, "grni") === -2400, [delta(s0, s1, "inv"), delta(s0, s1, "grni")]);
  check("…the PO shows partially received (480 of 500)", (await call("omar", "GET", `/api/purchasing/orders/${po.id}`)).body.order.status === "partially_received");
  const bill = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: supplier.id, supplier_invoice_no: `${TAG}-B1`, bill_date: today, lines: [{ intake_id: receipt.id, unit_price: "5" }] })).body.bill;
  check("bill matched and posted", (await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {})).body.bill?.status === "posted");
  let s2 = await snapshot();
  check("…GRNI cleared, AP up 2400", delta(s1, s2, "grni") === 2400 && delta(s1, s2, "ap") === -2400);
  check("…supplier balance 3000 + 2400 = 5400", (await payable(supplier.id)) === "5400.00");
  r = await call("karim", "POST", "/api/accounting/payments", { party_id: supplier.id, cash_account_id: "bank_main", amount: 2400, method: "bank_transfer", allocations: [{ document_id: bill.id, amount: 2400 }] });
  let s3 = await snapshot();
  check("bill paid by bank: AP down 2400, bank down 2400", r.status === 201 && delta(s2, s3, "ap") === 2400 && delta(s2, s3, "bank") === -2400);
  check("…bill closed, supplier back to the opening 3000", (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill.open === "0.00" && (await payable(supplier.id)) === "3000.00");
  const paid = r.body.payment;
  r = await call("karim", "POST", `/api/accounting/payments/${paid.id}/reverse`, { reason: "التحويل رجع" });
  const s3b = await snapshot();
  check("returned transfer reversed: AP +2400 owed again, bank +2400, bill open again", r.status === 201 && delta(s3, s3b, "ap") === -2400 && delta(s3, s3b, "bank") === 2400 && (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill.open === "2400.00" && (await payable(supplier.id)) === "5400.00", r.body);
  r = await call("karim", "POST", "/api/accounting/payments", { party_id: supplier.id, cash_account_id: "bank_main", amount: 2400, method: "bank_transfer", allocations: [{ document_id: bill.id, amount: 2400 }] });
  check("…paid again: bill closed, back to the opening 3000", r.status === 201 && (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill.open === "0.00" && (await payable(supplier.id)) === "3000.00");

  // -------------------------------------------------------------------------
  section("3. SALE: ORDER → RESERVE → PREPARE → LOAD → TRIP → PARTIAL DELIVERY → INVOICE → PAYMENT");
  // WF-01 (replaces switching sales.auto_reserve on for the scenario): reservation is always on.
  const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === "sales.auto_reserve");
  check("automatic reservation is always on", cur?.value === true, cur);
  const order = (await call("mona", "POST", "/api/orders", { customer_account_id: customer.id, customer_name: customer.name, delivery_date: today, items: [{ stock_product_id: potato.id, product_name: potato.name, quantity: 100 }] })).body.order;
  check("sales takes the order", !!order?.id && order.items[0].stockProductId === potato.id, order);
  await call("mona", "PATCH", `/api/orders/${order.id}/items/${order.items[0].id}/price`, { unit_price: "9", reason: "سعر العقد" });
  const reserved = (await call("hossam", "GET", `/api/inventory/products/${potato.id}`)).body;
  check("stock reserved for it (available drops, on-hand does not)", Number(reserved.reserved) >= 100, [reserved.onHand, reserved.reserved, reserved.available]);
  await call("ahmed", "POST", `/api/orders/${order.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${order.id}/items/${order.items[0].id}/prepare`, { quantity: 100, mark_done: true });
  check("prepared, ready for loading", (await call("ahmed", "POST", `/api/orders/${order.id}/status`, { to: "ready_for_loading" })).status === 200);
  const vehicle = (await call("sara", "POST", "/api/operations/vehicles", { code: `${TAG}V`, plate: `${TAG}P`, capacity_kg: 1000 })).body.vehicle;
  const driver = (await call("sara", "POST", "/api/operations/drivers", { name: `${TAG} سواق` })).body.driver;
  const trip = (await call("sara", "POST", "/api/operations/trips", { trip_date: today, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: [order.id] })).body.trip;
  await call("mostafa", "POST", `/api/operations/trips/${trip.id}/start-loading`, {});
  await call("mostafa", "POST", `/api/orders/${order.id}/items/${order.items[0].id}/load`, { quantity: 100, mark_done: true });
  await call("mostafa", "POST", `/api/operations/trips/${trip.id}/loaded`, {});
  s0 = await snapshot();
  const stockBeforeDispatch = await onHand(potato.id);
  r = await call("mostafa", "POST", `/api/operations/trips/${trip.id}/dispatch`, { crates: { [order.id]: 5 } });
  s1 = await snapshot();
  check("dispatched: 100 kg left stock", r.status === 200 && stockBeforeDispatch - (await onHand(potato.id)) === 100);
  check("…COGS and inventory moved at once (100 kg at cost)", delta(s0, s1, "cogs") > 0 && delta(s0, s1, "cogs") === -delta(s0, s1, "inv"), [delta(s0, s1, "cogs"), delta(s0, s1, "inv")]);
  const issueCost = delta(s0, s1, "cogs");
  check("no invoice before the customer's acceptance -> 409", (await call("karim", "POST", "/api/sales/invoices", { order_id: order.id })).status === 409);
  const stop = (await call("mostafa", "GET", `/api/operations/trips/${trip.id}`)).body.trip.stops[0];
  r = await call("mostafa", "POST", `/api/operations/stops/${stop.id}/delivery`, { result: "delivered", receiver_name: "مدير الفرع", lines: [{ order_item_id: order.items[0].id, rejected_qty: 10, damaged_qty: 5, reason: "حجم صغير / مضروب" }] });
  s2 = await snapshot();
  check("customer accepts 85 of 100 (10 rejected back to stock, 5 damaged)", r.status === 201 && r.body.stop.status === "partial");
  check("…the 10 rejected kg are back in stock and their cost left COGS", (await onHand(potato.id)) === stockBeforeDispatch - 90 && delta(s1, s2, "cogs") < 0 && delta(s1, s2, "cogs") === -delta(s1, s2, "inv"));
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: order.id })).body.invoice;
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  s3 = await snapshot();
  check("invoiced only what was accepted: 85 × 9 = 765", r.status === 200 && r.body.invoice.total === "765", r.body.invoice?.total);
  check("…AR +765, sales +765", delta(s2, s3, "ar") === 765 && delta(s2, s3, "sales") === -765);
  check("…customer owes 5000 + 765", (await receivable(customer.id)) === "5765.00");
  const pay = { party_id: customer.id, cash_account_id: "bank_main", amount: 765, method: "bank_transfer", allocations: [{ document_id: inv.id, amount: 765 }], idempotency_key: `${TAG}-rct-1` };
  const taps = await Promise.all([1, 2, 3].map(() => call("karim", "POST", "/api/accounting/receipts", pay)));
  r = taps[0];
  const s4 = await snapshot();
  check("customer pays the invoice by bank: AR −765, bank +765", r.status === 201 && delta(s3, s4, "ar") === -765 && delta(s3, s4, "bank") === 765);
  check("…the same submit three times at once is one receipt (money recorded once)", taps.every((t) => [200, 201].includes(t.status)) && new Set(taps.map((t) => t.body.receipt.id)).size === 1, taps.map((t) => t.status));
  check("…the same key on a different amount -> 409", (await call("karim", "POST", "/api/accounting/receipts", { ...pay, amount: 700 })).status === 409);
  check("…invoice closed; the customer still owes the opening 5000", (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice.open === "0.00" && (await receivable(customer.id)) === "5000.00");

  // The cheque bounces: the receipt is taken back by a reversal document, never edited.
  const rct = taps[0].body.receipt;
  check("only senior finance reverses money -> 403 for sales", (await call("mona", "POST", `/api/accounting/receipts/${rct.id}/reverse`, { reason: "x" })).status === 403);
  r = await call("karim", "POST", `/api/accounting/receipts/${rct.id}/reverse`, { reason: "شيك مرتجع" });
  const s4b = await snapshot();
  check("bounced cheque reversed: AR +765, bank −765", r.status === 201 && delta(s4, s4b, "ar") === 765 && delta(s4, s4b, "bank") === -765, r.body);
  check("…the invoice is open again and the customer owes 5765", (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice.open === "765.00" && (await receivable(customer.id)) === "5765.00");
  const stmt = (await call("karim", "GET", `/api/sales/customers/${customer.id}/statement?from=2000-01-01&to=2099-12-31`)).body;
  check("…the statement shows the receipt and its reversal, not a silent edit", stmt.rows.some((x: any) => x.kind === "receipt" && x.number === rct.number) && stmt.rows.some((x: any) => x.kind === "receipt_reversal" && x.number === rct.number && x.debit === "765.00"));
  check("…reversing twice -> 409; allocating a reversed receipt -> 409", (await call("karim", "POST", `/api/accounting/receipts/${rct.id}/reverse`, { reason: "x" })).status === 409 && (await call("karim", "POST", `/api/accounting/receipts/${rct.id}/allocate`, { auto: true })).status === 409);
  r = await call("karim", "POST", "/api/accounting/receipts", { ...pay, idempotency_key: `${TAG}-rct-2`, method: "cash", cash_account_id: "cash_main" });
  check("customer pays again in cash: invoice closed, owes the opening 5000", r.status === 201 && (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice.open === "0.00" && (await receivable(customer.id)) === "5000.00", r.body);
  const arAcc = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts.find((a: any) => a.code === "1300");
  const expAcc = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts.find((a: any) => a.code === "6100");
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: "تسوية يدوية", lines: [{ account_id: arAcc.id, debit: 10, party_type: "customer", party_id: customer.id }, { account_id: expAcc.id, credit: 10 }] });
  check("a manual journal cannot touch receivables (only documents move a control account) -> 400", r.status === 400 && /حساب مراقبة/.test(r.body.error ?? r.body.message ?? JSON.stringify(r.body)), r.body);

  const fin = (await call("karim", "GET", `/api/management/finance?from=${today}&to=${today}`)).body.report;
  const row = fin.sales.byProduct.find((p: any) => p.product.includes(`${TAG} Potato`));
  check("management report: revenue 765, cost = what left net of what came back", row?.revenue === "765.00" && Math.abs(Number(row.cost) - (issueCost + delta(s1, s2, "cogs"))) < 0.01, row);

  // -------------------------------------------------------------------------
  section("4. RETURNS: CREDIT NOTE WITH GOODS BACK, DEBIT NOTE WITH GOODS OUT");
  const line = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice.lines[0];
  const stockBefore = await onHand(potato.id);
  s0 = await snapshot();
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "العميل رجّع 5 كجم", restock: true, lines: [{ invoice_line_id: line.id, quantity: 5 }] });
  s1 = await snapshot();
  check("credit note 5 × 9 = 45 with the goods back in one step", r.status === 201 && (await onHand(potato.id)) - stockBefore === 5, r.body);
  check("…AR −45, sales returns +45, inventory up and COGS down by their cost", delta(s0, s1, "ar") === -45 && delta(s0, s1, "returns") === 45 && delta(s0, s1, "inv") > 0 && delta(s0, s1, "inv") === -delta(s0, s1, "cogs"));
  check("…the customer now has 45 on account (statement 4955)", (await receivable(customer.id)) === "4955.00");
  const bLine = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill.lines[0];
  const stock2 = await onHand(potato.id);
  s0 = await snapshot();
  r = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "مرتجع 20 كجم للمورد", return_goods: true, lines: [{ bill_line_id: bLine.id, quantity: 20 }] });
  s1 = await snapshot();
  check("debit note 20 × 5 = 100 with the goods out in one step", r.status === 201 && stock2 - (await onHand(potato.id)) === 20, r.body);
  check("…AP −100 (supplier owes us), inventory −100 at the receipt's cost, no GRNI left behind", delta(s0, s1, "ap") === 100 && delta(s0, s1, "inv") === -100 && delta(s0, s1, "grni") === 0, [delta(s0, s1, "ap"), delta(s0, s1, "inv"), delta(s0, s1, "grni")]);
  check("…supplier balance 3000 − 100 = 2900", (await payable(supplier.id)) === "2900.00");

  // -------------------------------------------------------------------------
  section("5. ONE SOURCE OF TRUTH");
  const integ = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  for (const c of integ.checks) check(`integrity: ${c.label}`, c.ok, c);
  check("the floor cannot read the integrity check -> 403", (await call("ahmed", "GET", "/api/accounting/integrity")).status === 403);
  finish("CONNECTED FLOWS");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
