/* UNITED's month, end to end — every operational document followed into the ledger and the
   financial statements, with the expected journal effect stated before it is checked.
     opening balances (approved batch) → fresh produce bought and received with grading
     (good / Grade B SKU / waste) → supplier bill → supplier payment with withholding →
     sale: order → prepare → load → dispatch → partial acceptance → invoice → collection
     with a bank charge → sales return with goods back → purchase return with goods out →
     stock count adjustment → fixed asset bought and depreciated → bank-to-cash transfer →
     VAT for the month against the ledger → month-end close (blocks postings) and controlled
     reopen → trial balance, P&L, balance sheet, cash flow, comparatives, integrity.
   The GL is read with raw SQL by system key, so each step's effect is measured, not assumed.
   Isolated test database only: the month-end section closes every earlier open month. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const TAG = `ZZBC${Date.now() % 1_000_000_000}`;
const SUF = String(Date.now()).slice(-6);
const { check, section, finish } = makeChecker();
const n = (v: unknown) => Number(v ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const eq = (a: number, b: number) => Math.abs(a - b) < 0.005;
let r: any;

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"]) await login(u);
  const today = todayBiz();
  const month = today.slice(0, 7);
  const KEYS = ["ar", "ap", "inventory", "grni", "sales", "sales_returns", "cogs", "inventory_adjustment", "ppv", "vat_input", "vat_output", "opening_equity", "retained_earnings", "fa_depreciation"] as const;
  const glKey = async (key: string) => { const [x] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${key}`; return n(x?.b); };
  const glAcc = async (id: string) => { const [x] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum("debit" - "credit") AS b FROM "JournalLine" WHERE "accountId" = ${id}`; return n(x?.b); };
  const cashMain = (await db.cashAccount.findUniqueOrThrow({ where: { id: "cash_main" } })).accountId;
  const bankMain = (await db.cashAccount.findUniqueOrThrow({ where: { id: "bank_main" } })).accountId;
  const extra: Record<string, string> = {};
  type Snap = Record<string, number>;
  const snap = async (): Promise<Snap> => {
    const s: Snap = {};
    for (const k of KEYS) s[k] = await glKey(k);
    s.cash = await glAcc(cashMain); s.bank = await glAcc(bankMain);
    for (const [k, id] of Object.entries(extra)) s[k] = await glAcc(id);
    return s;
  };
  const d = (a: Snap, b: Snap, k: string) => r2(b[k] - a[k]);
  /** Only the named accounts moved, each by the amount given (debit +, credit −). */
  const moved = (a: Snap, b: Snap, expect: Record<string, number>) => {
    const bad: string[] = [];
    for (const k of Object.keys(b)) { const want = expect[k] ?? 0; if (!eq(d(a, b, k), want)) bad.push(`${k}: ${d(a, b, k)} ≠ ${want}`); }
    return bad;
  };
  const approve = async (entityId: string) => { const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === entityId); return a ? call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version }) : null; };
  const receivable = async (id: string) => n((await call("karim", "GET", `/api/sales/customers/${id}/statement?from=2000-01-01&to=2099-12-31`)).body.closing);
  const payable = async (id: string) => n((await call("karim", "GET", `/api/purchasing/suppliers/${id}/statement?from=2000-01-01&to=2099-12-31`)).body.payable);
  const onHand = async (pid: string) => n((await call("hossam", "GET", `/api/inventory/products/${pid}`)).body.onHand);

  // Settings this month needs (deduction accounts); restored at the end.
  const settingsBefore = new Map<string, unknown>();
  const setSetting = async (key: string, value: unknown) => {
    const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
    if (!settingsBefore.has(key)) settingsBefore.set(key, cur?.isDefault ? null : cur?.value);
    return call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: `${TAG} دورة الشهر`, expected_version: cur?.version });
  };

  section("0. MASTER DATA");
  const tomato = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} طماطم`, unit: "KG" })).body.product;
  const tomatoB = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} طماطم درجة تانية`, unit: "KG" })).body.product;
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} سلسلة مطاعم` })).body.customer;
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مزرعة الطماطم`, payment_terms_days: 30 })).body.supplier;
  const bankCharges = (await call("karim", "POST", "/api/accounting/accounts", { code: `6${SUF.slice(-3)}1`, name: `${TAG} Bank charges`, name_ar: `${TAG} مصاريف بنكية`, parent_id: "acc_6000" })).body.account;
  const whtPayable = (await call("karim", "POST", "/api/accounting/accounts", { code: `2${SUF.slice(-3)}1`, name: `${TAG} WHT payable`, name_ar: `${TAG} ضريبة خصم وإضافة مستحقة`, parent_id: "acc_2000" })).body.account;
  check("products (good + Grade B SKU), customer, supplier, bank-charges and WHT accounts", [tomato, tomatoB, customer, supplier, bankCharges, whtPayable].every((x) => !!x?.id), [tomato, tomatoB, customer, supplier, bankCharges, whtPayable]);
  extra.bankCharges = bankCharges.id; extra.whtPayable = whtPayable.id;
  await setSetting("accounting.bank_charges_account", bankCharges.code);
  await setSetting("accounting.withholding_payable_account", whtPayable.code);

  section("1. OPENING BALANCES — APPROVED BATCH, RECONCILED");
  let s0 = await snap();
  const initialPosted = await db.openingBatch.findFirst({ where: { kind: "initial", status: "posted" } });
  r = await call("karim", "POST", "/api/accounting/opening-batches", initialPosted ? { kind: "correction" } : { cutover_date: today });
  const batch = r.body.batch;
  check(`an opening ${initialPosted ? "correction" : "initial"} batch`, r.status === 201 && !!batch?.id, r.body);
  r = await call("karim", "POST", `/api/accounting/opening-batches/${batch.id}/lines`, { lines: [
    { kind: "customer", party_id: customer.id, amount: "3000", reference: `${TAG}-OB-AR` },
    { kind: "supplier", party_id: supplier.id, amount: "2000", reference: `${TAG}-OB-AP` },
    { kind: "gl", account_id: "acc_3200", credit: "1000", description: "فرق الأرصدة على الأرباح المحتجزة" },
  ] });
  const v = (await call("karim", "GET", `/api/accounting/opening-batches/${batch.id}`)).body.batch.validation;
  check("validation: debit 3000 = credit 3000, nothing left in opening equity", r.status === 201 && v.totals.residual === "0.00" && v.problems.length === 0, v);
  check("sent for approval", (await call("karim", "POST", `/api/accounting/opening-batches/${batch.id}/submit`, {})).status === 202);
  const pend = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === batch.id);
  check("the preparer cannot approve it (403)", (await call("karim", "POST", `/api/approvals/${pend?.id}/decide`, { decision: "approve", expected_version: pend?.version })).status === 403);
  r = await approve(batch.id);
  let s1 = await snap();
  check("approved by someone else -> posted", r?.status === 200, r?.body);
  check("GL: AR +3000, AP −2000, retained earnings −1000, opening equity nets to 0", moved(s0, s1, { ar: 3000, ap: -2000, retained_earnings: -1000 }).length === 0, moved(s0, s1, { ar: 3000, ap: -2000, retained_earnings: -1000 }));
  check("statements carry the openings: customer owes 3000, we owe the supplier 2000", (await receivable(customer.id)) === 3000 && (await payable(supplier.id)) === 2000, [await receivable(customer.id), await payable(supplier.id)]);

  section("2. FRESH PRODUCE RECEIVED AND GRADED (1000 kg @ 6.00: 800 good, 150 Grade B, 50 waste)");
  s0 = await snap();
  r = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: supplier.id, product_id: tomato.id, received_date: today, received_kg: 1000, grade_b_qty: 150, waste_qty: 50, grade_b_product_id: tomatoB.id, unit_cost: "6" });
  const intake = r.body.intake;
  s1 = await snap();
  check("intake recorded", r.status === 201 && !!intake?.id, r.body);
  check("stock: 800 kg + 50 kg waste on the good SKU (waste at its own location), 150 kg on the Grade B SKU", (await onHand(tomato.id)) === 850 && (await onHand(tomatoB.id)) === 150, [await onHand(tomato.id), await onHand(tomatoB.id)]);
  const layers = await db.$queryRaw<{ v: Prisma.Decimal }[]>`SELECT coalesce(sum(v."value"), 0) AS v FROM "StockValuationLayer" v JOIN "StockMovement" m ON m."id" = v."movementId" WHERE m."intakeId" = ${intake.id}`;
  check("valuation: the 1000 kg carry the full 6000 (proportional grading)", eq(n(layers[0].v), 6000), layers[0].v);
  check("GL in the same step: Dr inventory 6000 / Cr GRNI 6000, nothing else", moved(s0, s1, { inventory: 6000, grni: -6000 }).length === 0, moved(s0, s1, { inventory: 6000, grni: -6000 }));
  const wasteBucket = ((await call("hossam", "GET", `/api/inventory/products/${tomato.id}`)).body.buckets ?? []).filter((b: any) => b.locationCode === "WASTE").reduce((s: number, b: any) => s + n(b.quantity), 0);
  check("waste sits in the WASTE location, not sellable stock", wasteBucket === 50, wasteBucket);
  const vr = await call("hossam", "POST", `/api/stock/intakes/${intake.id}/void`, { reason: `${TAG} تجربة إلغاء` });
  check("voiding a graded receipt in place is refused, not half-done (its stock went to three places) — books unchanged", vr.status >= 400 && vr.status < 500 && moved(s1, await snap(), {}).length === 0, [vr.status, vr.body]);

  section("3. SUPPLIER BILL MATCHED TO THE RECEIPT, PAID WITH WITHHOLDING");
  s0 = await snap();
  const bill = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: supplier.id, supplier_invoice_no: `${TAG}-INV-1`, bill_date: today, lines: [{ intake_id: intake.id, unit_price: "6" }] })).body.bill;
  r = await call("karim", "POST", `/api/purchasing/bills/${bill?.id}/post`, {});
  if (r.body?.bill?.status === "pending_approval") await approve(bill.id);
  const billNow = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
  s1 = await snap();
  const billTotal = n(billNow.total);
  check(`bill posted for the received goods (${billTotal})`, billNow.status === "posted" && billTotal > 0, billNow);
  check("the bill defaults to everything accepted (800 good + 150 Grade B + 50 waste = 1000 kg × 6 = 6000 net)", eq(n(billNow.net), 6000), billNow.net);
  check("GL: GRNI fully cleared (+6000), AP −total, input VAT +tax, no price variance", moved(s0, s1, { grni: 6000, ap: -billTotal, vat_input: n(billNow.taxTotal) }).length === 0, moved(s0, s1, { grni: 6000, ap: -billTotal, vat_input: n(billNow.taxTotal) }));
  const [grniLeft] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`
    SELECT sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE a."systemKey" = 'grni' AND ((e."sourceType" = 'supplier_bill' AND e."sourceId" = ${bill.id}) OR e."id" IN (SELECT p."entryId" FROM "StockValuationPosting" p JOIN "StockMovement" m ON m."id" = p."movementId" WHERE m."intakeId" = ${intake.id}))`;
  check("…nothing of this receipt is left in GRNI", eq(n(grniLeft?.b), 0), grniLeft);
  s0 = s1;
  r = await call("karim", "POST", "/api/accounting/payments", { party_id: supplier.id, cash_account_id: "bank_main", amount: "5000", method: "bank_transfer", allocations: [{ document_id: bill.id, amount: "5000" }], deductions: [{ kind: "withholding", amount: "50", reference: `${TAG}-WHT` }], idempotency_key: `${TAG}-pay-1` });
  s1 = await snap();
  check("supplier paid 5000 with 50 withheld", r.status === 201, r.body);
  check("GL: AP +5000, bank −4950, WHT payable −50", moved(s0, s1, { ap: 5000, bank: -4950, whtPayable: -50 }).length === 0, moved(s0, s1, { ap: 5000, bank: -4950, whtPayable: -50 }));
  check(`supplier statement: 2000 opening + ${billTotal} − 5000`, eq(await payable(supplier.id), 2000 + billTotal - 5000), await payable(supplier.id));

  section("4. SALE: ORDER 300 kg @ 10 → PREPARE → LOAD → DISPATCH → 290 ACCEPTED → INVOICE");
  const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === "sales.auto_reserve");
  await call("admin", "PATCH", "/api/admin/settings/sales.auto_reserve", { value: true, reason: TAG, expected_version: cur.version });
  const order = (await call("mona", "POST", "/api/orders", { customer_account_id: customer.id, customer_name: customer.name, delivery_date: today, items: [{ stock_product_id: tomato.id, product_name: tomato.name, quantity: 300 }] })).body.order;
  await call("mona", "PATCH", `/api/orders/${order.id}/items/${order.items[0].id}/price`, { unit_price: "10", reason: "سعر العقد" });
  await call("ahmed", "POST", `/api/orders/${order.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${order.id}/items/${order.items[0].id}/prepare`, { quantity: 300, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${order.id}/status`, { to: "ready_for_loading" });
  const vehicle = (await call("sara", "POST", "/api/operations/vehicles", { code: `${TAG}V`, plate: `${TAG}P`, capacity_kg: 2000 })).body.vehicle;
  const driver = (await call("sara", "POST", "/api/operations/drivers", { name: `${TAG} سواق` })).body.driver;
  const trip = (await call("sara", "POST", "/api/operations/trips", { trip_date: today, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: [order.id] })).body.trip;
  await call("mostafa", "POST", `/api/operations/trips/${trip.id}/start-loading`, {});
  await call("mostafa", "POST", `/api/orders/${order.id}/items/${order.items[0].id}/load`, { quantity: 300, mark_done: true });
  await call("mostafa", "POST", `/api/operations/trips/${trip.id}/loaded`, {});
  s0 = await snap();
  r = await call("mostafa", "POST", `/api/operations/trips/${trip.id}/dispatch`, { crates: { [order.id]: 15 } });
  s1 = await snap();
  check("dispatched: 300 kg left stock at cost 6 → COGS +1800 / inventory −1800, nothing else", r.status === 200 && moved(s0, s1, { cogs: 1800, inventory: -1800 }).length === 0, [r.status, moved(s0, s1, { cogs: 1800, inventory: -1800 })]);
  const stop = (await call("mostafa", "GET", `/api/operations/trips/${trip.id}`)).body.trip.stops[0];
  r = await call("mostafa", "POST", `/api/operations/stops/${stop.id}/delivery`, { result: "delivered", receiver_name: "مدير الفرع", lines: [{ order_item_id: order.items[0].id, rejected_qty: 10, reason: "حجم صغير" }] });
  const s2 = await snap();
  check("customer accepts 290; the 10 rejected kg come back: inventory +60 / COGS −60", r.status === 201 && moved(s1, s2, { cogs: -60, inventory: 60 }).length === 0, [r.status, moved(s1, s2, { cogs: -60, inventory: 60 })]);
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: order.id })).body.invoice;
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  const s3 = await snap();
  const invNow = r.body.invoice;
  check("invoice issued for what was accepted: 290 × 10 = 2900 net", r.status === 200 && eq(n(invNow.net), 2900), invNow);
  check("GL: AR + total, sales − net, output VAT − tax", moved(s2, s3, { ar: n(invNow.total), sales: -n(invNow.net), vat_output: -n(invNow.taxTotal) }).length === 0, moved(s2, s3, { ar: n(invNow.total), sales: -n(invNow.net), vat_output: -n(invNow.taxTotal) }));
  await call("admin", "PATCH", "/api/admin/settings/sales.auto_reserve", { value: null, reason: TAG, expected_version: cur.version + 1 });

  section("5. COLLECTION WITH A BANK CHARGE; PART OF THE OPENING BALANCE");
  s0 = await snap();
  r = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, cash_account_id: "bank_main", amount: invNow.total, method: "bank_transfer", allocations: [{ document_id: inv.id, amount: invNow.total }], deductions: [{ kind: "bank_charge", amount: "15" }], idempotency_key: `${TAG}-rct-1` });
  s1 = await snap();
  check("invoice collected by bank, the bank kept 15", r.status === 201, r.body);
  check("GL: AR −total, bank +(total − 15), bank charges +15", moved(s0, s1, { ar: -n(invNow.total), bank: n(invNow.total) - 15, bankCharges: 15 }).length === 0, moved(s0, s1, { ar: -n(invNow.total), bank: n(invNow.total) - 15, bankCharges: 15 }));
  r = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer.id, cash_account_id: "cash_main", amount: "1000", method: "cash", auto: true, idempotency_key: `${TAG}-rct-2` });
  const s2b = await snap();
  check("1000 of the opening balance collected in cash: AR −1000, cash +1000", r.status === 201 && moved(s1, s2b, { ar: -1000, cash: 1000 }).length === 0, [r.status, r.body?.error, moved(s1, s2b, { ar: -1000, cash: 1000 })]);
  check("customer statement: 3000 opening − 1000 = 2000", eq(await receivable(customer.id), 2000), await receivable(customer.id));

  section("6. RETURNS: SALES RETURN WITH GOODS BACK; PURCHASE RETURN WITH GOODS OUT");
  const invLine = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice.lines[0];
  s0 = await snap();
  r = await call("karim", "POST", `/api/sales/invoices/${inv.id}/credit-notes`, { reason: "العميل رجّع 20 كجم", restock: true, lines: [{ invoice_line_id: invLine.id, quantity: 20 }] });
  s1 = await snap();
  const cn = r.body.creditNote;
  check("credit note 20 × 10 = 200 net with the goods back", r.status === 201 && eq(n(cn?.net), 200), r.body);
  check("GL: AR −total, sales returns +200, VAT back, inventory +120 / COGS −120 at the issue cost", moved(s0, s1, { ar: -n(cn.total), sales_returns: 200, vat_output: n(cn.taxTotal), inventory: 120, cogs: -120 }).length === 0, moved(s0, s1, { ar: -n(cn.total), sales_returns: 200, vat_output: n(cn.taxTotal), inventory: 120, cogs: -120 }));
  const bLine = billNow.lines[0];
  s0 = await snap();
  r = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "مرتجع 30 كجم للمورد", return_goods: true, lines: [{ bill_line_id: bLine.id, quantity: 30 }] });
  s1 = await snap();
  const dn = r.body.debitNote;
  check("debit note 30 × 6 = 180 with the goods out", r.status === 201, r.body);
  check("GL: AP +total, inventory −180 at the receipt cost (input VAT back if any)", moved(s0, s1, { ap: n(dn?.total), inventory: -180, vat_input: -n(dn?.taxTotal) }).length === 0, moved(s0, s1, { ap: n(dn?.total), inventory: -180, vat_input: -n(dn?.taxTotal) }));

  section("7. STOCK COUNT: 5 kg SHORT");
  const buckets = (await call("karim", "GET", `/api/inventory/products/${tomato.id}`)).body.buckets ?? [];
  const bucket = buckets.find((b: any) => b.lotId && b.locationCode !== "WASTE" && b.locationType !== "quarantine" && n(b.quantity) >= 5);
  check("a sellable bucket to count (lot-tracked)", !!bucket?.lotId, buckets);
  s0 = await snap();
  r = await call("hossam", "POST", "/api/inventory/adjustments", { reason: `${TAG} جرد: نقص`, warehouse_id: "wh_main", lines: [{ product_id: tomato.id, quantity: -5, location_id: bucket?.locationId, ...(bucket?.lotId ? { lot_id: bucket.lotId } : {}) }] });
  if (r.body?.document?.status === "pending_approval" || r.status === 202) await approve(r.body.document?.id ?? r.body.approval?.entityId);
  s1 = await snap();
  check("count adjustment −5 kg: inventory −30, adjustments expense +30", [200, 201, 202].includes(r.status) && moved(s0, s1, { inventory: -30, inventory_adjustment: 30 }).length === 0, [r.status, r.body?.error, moved(s0, s1, { inventory: -30, inventory_adjustment: 30 })]);

  section("8. FIXED ASSET: A 12,000 SCALE BOUGHT BY BANK AND DEPRECIATED");
  const cat = (await call("karim", "POST", "/api/assets/categories", { code: `BC${SUF}`, name: `${TAG} Scales`, name_ar: `${TAG} موازين`, useful_life_months: 60, residual_percent: 0, depreciation_start: "same_month" })).body.category;
  s0 = await snap();
  r = await call("karim", "POST", "/api/assets", { category_id: cat.id, name: `${TAG} ميزان بسكول`, cost: "12000", acquisition_date: today, in_service_date: today, cash_account_id: "bank_main", idempotency_key: `${TAG}-asset` });
  const asset = r.body.asset;
  extra.assetCost = cat.assetAccountId; extra.accum = cat.accumulatedAccountId;
  s1 = await snap();
  check("asset bought: asset account +12000, bank −12000 (no expense)", r.status === 201 && eq(await glAcc(cat.assetAccountId), 12000) && eq(d(s0, s1, "bank"), -12000) && eq(d(s0, s1, "fa_depreciation"), 0), [r.status, d(s0, s1, "bank")]);
  const dep = await call("karim", "POST", "/api/assets/depreciation", { period: month });
  const s2c = await snap();
  // The run depreciates every asset due this month (other assets may exist): the scale's own
  // share is read from its category's accumulated-depreciation account.
  check("this month's depreciation of the scale: 12000 / 60 = 200 (its accumulated account −200); the run's expense = the run's total", dep.status === 201 && eq(await glAcc(cat.accumulatedAccountId), -200) && eq(d(s1, s2c, "fa_depreciation"), n(dep.body.run.total)), [dep.status, dep.body?.run?.total, d(s1, s2c, "fa_depreciation"), await glAcc(cat.accumulatedAccountId)]);
  check("register = ledger: cost 12000, accumulated 200, book value 11800", (await call("karim", "GET", `/api/assets/${asset.id}`)).body.asset.bookValue === "11800.00");

  section("9. BANK → CASH TRANSFER");
  s0 = await snap();
  r = await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: "cash_main", amount: "1000", date: today, idempotency_key: `${TAG}-tr` });
  if (r.body?.transfer?.status === "pending_approval") await approve(r.body.transfer.id);
  s1 = await snap();
  check("bank −1000, cash +1000, no P&L", moved(s0, s1, { bank: -1000, cash: 1000 }).length === 0, moved(s0, s1, { bank: -1000, cash: 1000 }));

  section("10. VAT FOR THE MONTH AGAINST THE LEDGER");
  const pv = (await call("karim", "GET", `/api/accounting/vat-returns/preview?from=${month}-01&to=${today}`)).body.preview;
  check("the month's VAT summary reconciles with the VAT accounts; it cannot be filed before the period ends", !!pv && !pv.problems.includes("summary_not_reconciled") && pv.problems.includes("period_not_ended"), pv?.problems);
  const [vat] = await db.$queryRaw<{ o: Prisma.Decimal; i: Prisma.Decimal }[]>`
    SELECT coalesce(sum(CASE WHEN a."systemKey" = 'vat_output' THEN l."credit" - l."debit" END), 0) AS o, coalesce(sum(CASE WHEN a."systemKey" = 'vat_input' THEN l."debit" - l."credit" END), 0) AS i
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId" WHERE e."date" <= ${today}`;
  check("preview output/input VAT = the ledger balances at today", eq(n(pv.outputTax), Math.max(n(vat.o), 0)) && eq(n(pv.inputTax), Math.max(n(vat.i), 0)), [pv.outputTax, pv.inputTax, vat]);

  section("11. MONTH-END CLOSE (BLOCKS POSTINGS) AND CONTROLLED REOPEN");
  for (const p of await db.accountingPeriod.findMany({ where: { status: "open", code: { lt: month } }, orderBy: { code: "asc" } })) {
    const c = await call("karim", "POST", `/api/accounting/periods/${p.code}/close`, {});
    if (c.status !== 200) check(`closing earlier month ${p.code}`, false, c.body);
  }
  const plBefore = (await call("karim", "GET", `/api/accounting/pnl?from=${month}-01&to=${today}`)).body;
  r = await call("karim", "POST", `/api/accounting/periods/${month}/close`, {});
  check(`${month} closed`, r.status === 200, r.body);
  check("…a posting into the closed month is refused (409)", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} بعد الإقفال`, lines: [{ account_id: "acc_6100", debit: 1 }, { account_id: "acc_1100", credit: 1 }] })).status === 409);
  const plClosed = (await call("karim", "GET", `/api/accounting/pnl?from=${month}-01&to=${today}`)).body;
  check("…the month's P&L is frozen (same net result after closing; stock valuation and depreciation were already posted)", plClosed.netIncome === plBefore.netIncome, [plBefore.netIncome, plClosed.netIncome]);
  r = await call("karim", "POST", `/api/accounting/periods/${month}/reopen`, { reason: `${TAG} تصحيح فاتورة متأخرة` });
  check("reopen requested with a reason (202) — never direct", r.status === 202, r.body);
  const per = await db.accountingPeriod.findUniqueOrThrow({ where: { code: month } });
  const reopenReq = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === per.id);
  check("…the requester cannot approve their own reopen (403)", (await call("karim", "POST", `/api/approvals/${reopenReq?.id}/decide`, { decision: "approve", expected_version: reopenReq?.version })).status === 403);
  r = await approve(per.id);
  check("…approved by someone else: the month is open again, the reopen is recorded", r?.status === 200 && (await db.accountingPeriod.findUniqueOrThrow({ where: { code: month } })).status === "open", r?.body);

  section("12. THE STATEMENTS AGREE WITH THE LEDGER");
  const from = `${today.slice(0, 4)}-01-01`;
  const tb = (await call("karim", "GET", `/api/accounting/trial-balance?from=${from}&to=${today}`)).body.trialBalance;
  check("trial balance balances", tb?.balanced === true);
  const bs = (await call("karim", "GET", `/api/accounting/balance-sheet?as_of=${today}`)).body;
  check("balance sheet balances", bs._balanced === true, [bs.totalAssets, bs.totalLiabilitiesAndEquity]);
  const cf = (await call("karim", "GET", `/api/management/cash-flow?from=${from}&to=${today}`)).body.report;
  check("cash flow: the three sections = the change in cash and bank", cf._balanced === true, [cf.netCashFlow, cf.cashTotal]);
  const pl = (await call("karim", "GET", `/api/accounting/pnl?from=${from}&to=${today}`)).body;
  const cmp = (await call("karim", "GET", `/api/accounting/comparatives?from=${from}&to=${today}`)).body.report;
  check("comparatives (current) = P&L", eq(n(cmp.profitAndLoss.current.netIncome), n(pl.netIncome)) && eq(n(cmp.profitAndLoss.current.revenue), n(pl.revenue)), [cmp.profitAndLoss.current, pl.netIncome]);
  const yr = (await call("karim", "GET", `/api/accounting/fiscal-years/${today.slice(0, 4)}`)).body.year;
  // The month's depreciation is dated on the month's last day, so compare with the P&L to year end.
  const plYear = (await call("karim", "GET", `/api/accounting/pnl?from=${yr.startDate}&to=${yr.endDate}`)).body;
  check("year-end preview: the closing entry would move exactly this year's result (and refuses until the year ends)", eq(n(yr.netIncome), n(plYear.netIncome)) && yr.problems.some((p: any) => p.code === "year_not_ended"), [yr.netIncome, plYear.netIncome, yr.problems]);
  check("customer and supplier statements = their GL lines", eq(await receivable(customer.id), n((await db.journalLine.aggregate({ where: { partyId: customer.id, account: { systemKey: "ar" } }, _sum: { debit: true, credit: true } }))._sum.debit) - n((await db.journalLine.aggregate({ where: { partyId: customer.id, account: { systemKey: "ar" } }, _sum: { debit: true, credit: true } }))._sum.credit)));
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("integrity check green (AR, AP, inventory, GRNI, fixed assets, VAT, TB, traceability)", health.ok === true, health.checks.filter((c: any) => !c.ok));

  for (const [key, value] of settingsBefore) await setSetting(key, value);
  await db.$disconnect();
  finish("BUSINESS CYCLE");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
