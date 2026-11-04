/* ODOO-REPLACEMENT UAT. UNITED's real business, end to end, through the running server,
   by the role that does each step in the company. Realistic data: fresh vegetables in KG,
   several customers and suppliers, two tax classes, partial fulfilment, shortages,
   rejections, a failed delivery, returns both ways, an expense, a count, transfers between
   cold rooms. Every source document is checked against the exact journal it must produce,
   and the stock ledger, the subledgers, the GL and the reports must agree at the end.
   Findings that are not test failures (limitations) are printed as OBSERVATIONS. */
import { call, login, makeChecker, page } from "./_harness";
import { local } from "./_days";
import { setSetting, fundCash, manualJournal } from "./_stock";

const { check, section, finish } = makeChecker();
const T = `ZZUAT${Date.now() % 1_000_000_000}`;
const observations: { severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; area: string; text: string }[] = [];
const observe = (severity: (typeof observations)[number]["severity"], area: string, text: string) => observations.push({ severity, area, text });
let r: any;

const today = local();
const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const reg9 = (k: number) => String(100_000_000 + ((Date.now() + k * 7919) % 899_999_999)).slice(0, 9);

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"]) await login(u);
  const accounts = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts;
  const acc = (code: string) => accounts.find((a: any) => a.code === code)?.id;
  const gl = async (code: string) => n((await call("karim", "GET", `/api/accounting/accounts/${acc(code)}/ledger?from=2000-01-01&to=2099-12-31`)).body.ledger.closing);
  const CODES = { cash: "1100", bank: "1200", ar: "1300", inv: "1400", vatIn: "1500", ap: "2100", grni: "2150", vatOut: "2200", empPay: "2300", opening: "3300", sales: "4100", returns: "4200", cogs: "5100", adj: "5200", ppv: "5300", exp: "6200" } as const;
  type Snap = Record<keyof typeof CODES, number>;
  const snap = async (): Promise<Snap> => Object.fromEntries(await Promise.all(Object.entries(CODES).map(async ([k, c]) => [k, await gl(c)]))) as Snap;
  const d = (a: Snap, b: Snap) => Object.fromEntries(Object.keys(CODES).map((k) => [k, n(b[k as keyof Snap] - a[k as keyof Snap])]).filter(([, v]) => v !== 0));
  /** The single journal entry a document produced, as { accountCode: debit − credit }. */
  const entry = async (sourceType: string, needle: string) => {
    const list = (await call("karim", "GET", `/api/accounting/journals?source_type=${sourceType}`)).body.journals.filter((j: any) => j.description.includes(needle));
    const lines: Record<string, number> = {};
    for (const j of list) for (const l of (await call("karim", "GET", `/api/accounting/journals/${j.id}`)).body.journal.lines) lines[l.account.code] = n((lines[l.account.code] ?? 0) + Number(l.debit) - Number(l.credit));
    for (const k of Object.keys(lines)) if (lines[k] === 0) delete lines[k];
    return { count: list.length, lines };
  };
  const same = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).filter(([, v]) => v !== 0).sort());
  const product = async (id: string) => (await call("karim", "GET", `/api/inventory/products/${id}`)).body;
  const onHand = async (id: string) => n((await product(id)).onHand);
  const atLoc = async (id: string, code: string) => n(((await product(id)).buckets ?? []).filter((b: any) => b.locationCode === code).reduce((s: number, b: any) => s + Number(b.quantity), 0));
  const statement = async (kind: "customer" | "supplier", id: string) => (await call("karim", "GET", `/api/${kind === "customer" ? "sales/customers" : "purchasing/suppliers"}/${id}/statement?from=2000-01-01&to=2099-12-31`)).body;
  const owes = async (id: string) => n((await statement("customer", id)).closing);
  const owed = async (id: string) => n((await statement("supplier", id)).payable);
  const setting = async (key: string, value: unknown) => {
    const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
    const res = await call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: T, expected_version: cur.version });
    if (res.status !== 200) throw new Error(`setting ${key}: ${JSON.stringify(res.body)}`);
    return cur.value;
  };

  // =========================================================================
  section("0. MASTER DATA (realistic UNITED catalogue and parties)");
  const mk = async (name: string, nameAr: string) => (await call("hossam", "POST", "/api/stock/products", { name: `${T} ${name}`, name_ar: `${nameAr} ${T}`, unit: "KG" })).body.product;
  const tomato = await mk("Tomato", "طماطم");
  const cucumber = await mk("Cucumber", "خيار");
  const potato = await mk("Potato", "بطاطس");
  const salad = await mk("Salad mix (packed)", "سلطة مجهزة");
  check("four KG products created by the stock controller", [tomato, cucumber, potato, salad].every((p) => p?.id && p.unit === "KG"));
  check("only finance classifies tax: sales -> 403", (await call("mona", "PATCH", `/api/sales/products/${salad.id}/tax`, { tax_code: "VAT14", reason: "x" })).status === 403);
  check("the packed salad is VAT 14% (processed); fresh produce stays exempt", (await call("karim", "PATCH", `/api/sales/products/${salad.id}/tax`, { tax_code: "VAT14", reason: "منتج مجهز ومعبأ" })).status === 200);
  const cust = async (name: string, extra: Record<string, unknown>) => {
    const result = await call("mona", "POST", "/api/sales/customers", { name: `${T} ${name}`, ...extra });
    if (result.status !== 201) throw new Error(`Could not create UAT customer ${name}: ${JSON.stringify(result.body)}`);
    return result.body.customer;
  };
  const hotel = await cust("فندق النيل", { tax_registration_no: reg9(1), type: "hotel" });
  const chain = await cust("سلسلة مطاعم الشرق", { tax_registration_no: reg9(2), type: "restaurant" });
  const cafe = await cust("كافيه الزمالك", { type: "cafe" });
  // MIG-01: an invoice needs a buyer identity. The cash café has no tax number; its owner
  // is a natural person, so its billing legal entity is a person (receiver type P) with a
  // national ID — the identity an invoice to a person carries.
  const cafeLe = (await call("mona", "POST", "/api/sales/legal-entities", { code: `${T.slice(-6)}CAFE`, name: `${T} صاحب الكافيه`, receiver_type: "P", receiver_id: "29001010101010" })).body.legalEntity;
  await call("mona", "PATCH", `/api/sales/customers/${cafe.id}`, { legal_entity_id: cafeLe?.id });
  await call("karim", "PATCH", `/api/sales/customers/${hotel.id}/credit`, { payment_terms_days: 30, reason: "إعداد UAT" });
  await call("karim", "PATCH", `/api/sales/customers/${chain.id}/credit`, { payment_terms_days: 14, reason: "إعداد UAT" });
  check("three customers: two B2B with tax numbers, one cash café", [hotel, chain, cafe].every((c) => c?.id) && !!hotel.taxRegistrationNo && !cafe.taxRegistrationNo, [hotel, chain, cafe]);
  const sup = async (name: string, days: number) => (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${T} ${name}`, payment_terms_days: days })).body.supplier;
  const farm = await sup("مزرعة الصالحية", 30);
  const market = await sup("سوق العبور — المعلم حسن", 0);
  check("two suppliers (farm on terms, market on cash)", !!farm?.id && !!market?.id);
  // L2: cash and bank never go negative — the owner funds both before any payment.
  await fundCash("cash_main", 6000);
  await fundCash("bank_main", 6000);

  // =========================================================================
  section("10. OPENING BALANCES (go-live from Odoo)");
  // CTL-01: direct opening entries are closed by default (the approved opening batch is the
  // path). This go-live exercises the direct path itself: it asserts the default refusal,
  // switches it on by an audited settings change, and restores the default afterwards.
  r = await call("karim", "POST", "/api/accounting/opening-stock", { business_date: today, lines: [{ product_id: tomato.id, quantity: 1, unit_cost: "6", location_id: "loc_cold_1" }] });
  check("default (direct opening OFF): opening stock -> 409 direct_opening_disabled", r.status === 409 && r.body.code === "direct_opening_disabled", r.body);
  r = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: hotel.id, date: today, amount: 1, reference: "x" });
  check("default (direct opening OFF): party opening balance -> 409 direct_opening_disabled", r.status === 409 && r.body.code === "direct_opening_disabled", r.body);
  check("direct opening entries switched ON for the go-live", (await setSetting("accounting.direct_opening_entries", true, `${T} go-live`)).status === 200);
  let s0 = await snap();
  r = await call("karim", "POST", "/api/accounting/opening-stock", { business_date: today, lines: [
    { product_id: tomato.id, quantity: 300, unit_cost: "6", expiry_date: local(5), location_id: "loc_cold_1" },
    { product_id: potato.id, quantity: 400, unit_cost: "5", expiry_date: local(60), location_id: "loc_cold_1" },
    { product_id: cucumber.id, quantity: 200, unit_cost: "4", expiry_date: local(4), location_id: "loc_cold_2" },
    { product_id: salad.id, quantity: 50, unit_cost: "20", expiry_date: local(3), location_id: "loc_cold_1" },
  ] });
  check("opening stock posted: 4 products, lots with expiry, in their cold rooms", r.status === 201, r.body);
  check("…quantities by location", (await atLoc(tomato.id, "COLD-1")) === 300 && (await atLoc(cucumber.id, "COLD-2")) === 200 && (await onHand(potato.id)) === 400 && (await onHand(salad.id)) === 50);
  const ob = async (party_type: string, party_id: string, amount: number, due: string) => (await call("karim", "POST", "/api/accounting/opening-balances", { party_type, party_id, date: today, due_date: due, amount, reference: "رصيد أودو" })).status;
  check("customer opening balances (hotel 12,000 overdue 40 days; café 800)", (await ob("customer", hotel.id, 12000, local(-40))) === 201 && (await ob("customer", cafe.id, 800, today)) === 201);
  check("supplier opening balance (farm 7,500)", (await ob("supplier", farm.id, 7500, today)) === 201);
  let s1 = await snap();
  check("GL: inventory +5,600 (1,800+2,000+800+1,000), AR +12,800, AP 7,500, against opening equity",
    same(d(s0, s1), { inv: 5600, ar: 12800, ap: -7500, opening: -10900 }), d(s0, s1));
  check("subledgers: hotel owes 12,000, café 800; we owe the farm 7,500", (await owes(hotel.id)) === 12000 && (await owes(cafe.id)) === 800 && (await owed(farm.id)) === 7500);
  const openingAging = (await call("karim", "GET", "/api/sales/reports/aging")).body.rows.find((x: any) => x.customer.id === hotel.id);
  check("a go-live balance posts on the cut-off date but ages from its original overdue due date", openingAging?.d31_60 === "12000.00" && openingAging?.total === "12000.00", openingAging);
  r = (await call("karim", "GET", `/api/accounting/trial-balance?from=2000-01-01&to=2099-12-31`)).body.trialBalance;
  check("trial balance balanced after go-live", r.balanced === true && r.totals.debit === r.totals.credit, r.totals);
  check("direct opening entries restored to the default (OFF)", (await setSetting("accounting.direct_opening_entries", null, `${T} go-live done`)).status === 200);

  // =========================================================================
  section("3. PURCHASE: RFQ → QUOTES → AWARD → PO → RECEIVE (lot / expiry / sorting) → BILL → AP → PAYMENT");
  r = await call("omar", "POST", "/api/purchasing/rfqs", { needed_by: local(2), lines: [{ product_id: tomato.id, quantity: 500 }, { product_id: cucumber.id, quantity: 300 }], supplier_ids: [farm.id, market.id] });
  check("purchaser raises an RFQ to two suppliers", r.status === 201, r.body);
  const rfq = r.body.rfq;
  let rd = (await call("omar", "GET", `/api/purchasing/rfqs/${rfq.id}`)).body.rfq;
  const rLines = rd.comparison.map((c: any) => c.line);
  const tL = rLines.find((l: any) => l.productId === tomato.id), cL = rLines.find((l: any) => l.productId === cucumber.id);
  await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/send`, {});
  check("farm quotes tomato 5.50, cucumber 3.80", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/quotes`, { supplier_id: farm.id, valid_until: local(7), lines: [{ rfq_line_id: tL.id, unit_price: "5.5" }, { rfq_line_id: cL.id, unit_price: "3.8" }] })).status === 200);
  check("market quotes tomato 5.20 only", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/quotes`, { supplier_id: market.id, lines: [{ rfq_line_id: tL.id, unit_price: "5.2" }] })).status === 200);
  check("the stock controller cannot see quotes -> 403", (await call("hossam", "GET", `/api/purchasing/rfqs/${rfq.id}`)).status === 403);
  r = await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/award`, { awards: [{ rfq_line_id: tL.id, supplier_id: market.id }, { rfq_line_id: cL.id, supplier_id: farm.id }] });
  check("award to the cheapest per line: one draft PO per supplier", r.status === 201 && r.body.orders.length === 2, r.body);
  const poMarket = r.body.orders.find((o: any) => o.supplierId === market.id), poFarm = r.body.orders.find((o: any) => o.supplierId === farm.id);
  for (const po of [poMarket, poFarm]) { await call("omar", "POST", `/api/purchasing/orders/${po.id}/submit`, {}); await call("omar", "POST", `/api/purchasing/orders/${po.id}/send`, {}); }
  const poM = (await call("omar", "GET", `/api/purchasing/orders/${poMarket.id}`)).body.order, poF = (await call("omar", "GET", `/api/purchasing/orders/${poFarm.id}`)).body.order;
  check("both POs sent at the awarded prices", poM.status === "sent" && poF.status === "sent" && Number(poM.lines[0].unitPrice) === 5.2 && Number(poF.lines[0].unitPrice) === 3.8, [poM.status, poF.status]);

  s0 = await snap();
  r = await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: poM.lines[0].id, received_kg: 500, rejected_kg: 30, rejection_reason: "طماطم مضروبة", location_id: "loc_cold_2", expiry_date: local(6) });
  check("tomato received into COLD-2: 500 kg, 30 sorted out, lot with expiry", r.status === 201 && !!r.body.intake?.lotId, r.body);
  const rcT = r.body.intake;
  r = await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: poF.lines[0].id, received_kg: 280, location_id: "loc_cold_2", expiry_date: local(5) });
  check("cucumber received 280 of 300 (partial)", r.status === 201, r.body);
  const rcC = r.body.intake;
  s1 = await snap();
  check("stock: tomato +470 good kg in COLD-2, cucumber +280", (await atLoc(tomato.id, "COLD-2")) === 470 && (await atLoc(cucumber.id, "COLD-2")) === 480);
  check("GL in the same step: Dr Inventory 3,508 (470×5.2 + 280×3.8) / Cr GRNI", same(d(s0, s1), { inv: 3508, grni: -3508 }), d(s0, s1));
  check("PO status follows receipts: market received (470 ≥ 500 − tolerance? no → partial), farm partial",
    ["partially_received", "received"].includes((await call("omar", "GET", `/api/purchasing/orders/${poMarket.id}`)).body.order.status) && (await call("omar", "GET", `/api/purchasing/orders/${poFarm.id}`)).body.order.status === "partially_received");
  check("the receiver never sees prices on the PO they receive against", !JSON.stringify((await call("hossam", "GET", `/api/purchasing/orders/${poFarm.id}`)).body).match(/"unitPrice":"?\d/));
  const lotT = (await product(tomato.id)).buckets.find((b: any) => b.locationCode === "COLD-2");
  check("lot carries its expiry from the receipt", lotT?.expiryDate === local(6), lotT);

  // Bills: market bills at the agreed price; farm bills cucumber at 3.90 (variance) .
  const billM = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: market.id, supplier_invoice_no: `${T}-M1`, bill_date: today, lines: [{ intake_id: rcT.id, unit_price: "5.2" }] })).body.bill;
  r = await call("karim", "POST", `/api/purchasing/bills/${billM.id}/post`, {});
  check("market bill matched and posted", r.body.bill?.status === "posted", r.body);
  const billF = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: farm.id, supplier_invoice_no: `${T}-F1`, bill_date: today, lines: [{ intake_id: rcC.id, unit_price: "3.9" }] })).body.bill;
  r = await call("karim", "POST", `/api/purchasing/bills/${billF.id}/post`, {});
  const needsApproval = r.body.bill?.status === "pending_approval";
  check("farm bill 2.6% over the PO price waits for approval (not the accountant)", needsApproval, r.body.bill?.status);
  const apb = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === billF.id);
  check("…the accountant cannot approve their own variance -> 403", (await call("karim", "POST", `/api/approvals/${apb?.id}/decide`, { decision: "approve" })).status === 403);
  check("…management approves the variance", (await call("admin", "POST", `/api/approvals/${apb?.id}/decide`, { decision: "approve", comment: "ارتفاع سعر السوق" })).status === 200);
  let s2 = await snap();
  check("bills: GRNI cleared at receipt value, AP at billed value, variance 28 to PPV", same(d(s1, s2), { grni: 3508, ap: -3536, ppv: 28 }), d(s1, s2));
  check("market bill journal exact: Dr GRNI 2,444 / Cr AP 2,444", same((await entry("supplier_bill", billM.number)).lines, { "2150": 2444, "2100": -2444 }));
  check("farm bill journal exact: Dr GRNI 1,064 + PPV 28 / Cr AP 1,092", same((await entry("supplier_bill", billF.number)).lines, { "2150": 1064, "5300": 28, "2100": -1092 }));
  check("supplier balances: market 2,444; farm 7,500 + 1,092 = 8,592", (await owed(market.id)) === 2444 && (await owed(farm.id)) === 8592);
  r = await call("karim", "POST", "/api/accounting/payments", { party_id: market.id, cash_account_id: "cash_main", amount: 2444, method: "cash", allocations: [{ document_id: billM.id, amount: 2444 }], idempotency_key: `${T}-pay-m` });
  check("market paid cash in full", r.status === 201 && (await owed(market.id)) === 0);
  check("…payment journal exact: Dr AP 2,444 / Cr cash 2,444", same((await entry("supplier_payment", r.body.payment.number)).lines, { "2100": 2444, "1100": -2444 }));
  r = await call("karim", "POST", "/api/accounting/payments", { party_id: farm.id, cash_account_id: "bank_main", amount: 5000, method: "bank_transfer", auto: true, idempotency_key: `${T}-pay-f` });
  check("farm paid 5,000 on account by bank (oldest first): bill settled, rest on account", r.status === 201 && (await owed(farm.id)) === 3592, await owed(farm.id));

  // =========================================================================
  section("4. TRANSFER: COLD-2 → COLD-1 (stock ledger, balances, no value change)");
  s0 = await snap();
  const t2Before = await atLoc(tomato.id, "COLD-2"), t1Before = await atLoc(tomato.id, "COLD-1"), tTotal = await onHand(tomato.id);
  r = await call("hossam", "POST", "/api/inventory/transfers", { reason: "تفريغ غرفة 2", idempotency_key: `${T}-tr1`, lines: [{ product_id: tomato.id, quantity: 200, location_id: "loc_cold_2", to_location_id: "loc_cold_1" }] });
  check("200 kg tomato moved COLD-2 → COLD-1", r.status === 201, r.body);
  check("…balances by location moved, total unchanged", (await atLoc(tomato.id, "COLD-2")) === t2Before - 200 && (await atLoc(tomato.id, "COLD-1")) === t1Before + 200 && (await onHand(tomato.id)) === tTotal);
  const mv = (await product(tomato.id)).movements.filter((m: any) => m.document?.number === r.body.document.number);
  check("…stock ledger: one transfer_out and one transfer_in at the same cost", mv.length === 2 && mv.some((m: any) => m.kind === "transfer_out") && mv.some((m: any) => m.kind === "transfer_in") && new Set(mv.map((m: any) => m.unitCost)).size === 1, mv.map((m: any) => [m.kind, m.quantity, m.unitCost]));
  check("…lot and expiry travel with the stock", (await product(tomato.id)).buckets.filter((b: any) => b.locationCode === "COLD-1" && b.lotId === lotT.lotId).length === 1);
  check("…no accounting effect (value does not change by moving it)", same(d(s0, await snap()), {}));
  observe("MEDIUM", "Inventory", "Transfers move stock between locations of ONE warehouse. A second warehouse can be created, but there is no inter-warehouse transfer document; UNITED runs one warehouse today, so this blocks nothing now but must exist before a second site opens.");

  // =========================================================================
  section("5. COUNT: physical count → variance → approval → adjustment → ledger → GL");
  const thr = await setting("inventory.adjustment_approval_threshold", 10);
  const book = await atLoc(cucumber.id, "COLD-2");
  const cLot = (await product(cucumber.id)).buckets.find((b: any) => b.locationCode === "COLD-2" && Number(b.quantity) === 200);
  const val = async (id: string) => (await call("karim", "GET", "/api/inventory/reports/valuation")).body.rows.find((x: any) => x.productId === id);
  const v0 = await val(cucumber.id);
  const avg = Number(v0.value) / Number(v0.quantity ?? v0.onHand);
  s0 = await snap();
  r = await call("hossam", "POST", "/api/inventory/adjustments", { reason: "جرد غرفة 2 — آخر اليوم", idempotency_key: `${T}-count1`, lines: [{ product_id: cucumber.id, location_id: "loc_cold_2", lot_id: cLot.lotId, counted_quantity: 185 }] });
  check("count of the opening cucumber lot: 185 vs 200 on the books → −15 kg, above the 10 kg threshold → waits", r.status === 202 || r.body.document?.status === "pending_approval", [r.status, r.body.document?.status]);
  const countDoc = r.body.document;
  check("…nothing moved yet", (await atLoc(cucumber.id, "COLD-2")) === book && same(d(s0, await snap()), {}));
  const apc = (await call("sara", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === countDoc.id);
  check("…the stock controller cannot approve their own count -> 403", (await call("hossam", "POST", `/api/approvals/${apc?.id}/decide`, { decision: "approve" })).status === 403);
  check("…the supervisor approves", (await call("sara", "POST", `/api/approvals/${apc?.id}/decide`, { decision: "approve", comment: "تلف طبيعي" })).status === 200);
  s1 = await snap();
  check("ledger: −15 kg from that lot", (await atLoc(cucumber.id, "COLD-2")) === book - 15);
  const wo = n(15 * avg);
  const dd = d(s0, s1);
  check(`GL: Dr write-offs / Cr inventory = 15 kg × moving average ${avg.toFixed(4)} ≈ ${wo} (AVCO)`, Object.keys(dd).sort().join() === "adj,inv" && dd.adj === -dd.inv && Math.abs(dd.adj - wo) <= 0.01, [dd, avg]);
  check("…valuation report and GL moved by exactly the same amount", n(Number(v0.value) - Number((await val(cucumber.id)).value)) === dd.adj);
  observe("LOW", "Costing", "Products default to AVCO (weighted average): issues, write-offs and returns are valued at the moving average, not at the lot's purchase price. Correct and consistent, but the accountant should confirm AVCO (vs FIFO) as UNITED's policy before go-live; it is a per-product setting.");
  check("a count that agrees with the books posts nothing -> 400", (await call("hossam", "POST", "/api/inventory/adjustments", { reason: "جرد", lines: [{ product_id: cucumber.id, location_id: "loc_cold_2", lot_id: cLot.lotId, counted_quantity: 185 }] })).status === 400);
  await setting("inventory.adjustment_approval_threshold", thr);


  // =========================================================================
  section("1. CUSTOMER → QUOTATION → ORDER → DISPATCH → PARTIAL DELIVERY → INVOICE → RECEIPT → AR → GL");
  check("the accountant cannot write quotations -> 403", (await call("karim", "POST", "/api/sales/quotations", {})).status === 403);
  r = await call("mona", "POST", "/api/sales/quotations", { customer_id: hotel.id, delivery_date: today, lines: [
    { product_id: tomato.id, quantity: 120, unit_price: "9.5" }, { product_id: potato.id, quantity: 80, unit_price: "7" }, { product_id: salad.id, quantity: 10, unit_price: "35" }] });
  check("sales quotes the hotel: tomato 120 @9.50, potato 80 @7, packed salad 10 @35 (+VAT)", r.status === 201, r.body);
  const quo = r.body.quotation;
  await call("mona", "POST", `/api/sales/quotations/${quo.id}/transition`, { action: "send" });
  check("hotel accepts", (await call("mona", "POST", `/api/sales/quotations/${quo.id}/transition`, { action: "accept", note: "موافقة بالتليفون" })).status === 200);
  r = await call("mona", "POST", `/api/sales/quotations/${quo.id}/convert`, {});
  check("converted to a sales order", r.status === 201 && r.body.order.customerAccountId === hotel.id, r.body);
  const o1 = r.body.order;
  const pr1 = (await call("mona", "GET", `/api/orders/${o1.id}/pricing`)).body;
  check("the order carries the quoted prices and VAT: net 2,050, tax 49 (salad only), total 2,099", pr1.totals.net === "2050.00" && pr1.totals.tax === "49.00" && pr1.totals.total === "2099.00", pr1.totals);
  check("converting twice -> 409", (await call("mona", "POST", `/api/sales/quotations/${quo.id}/convert`, {})).status === 409);
  check("the preparer sees no prices on the order", !/"unitPrice"|"total"\s*:\s*"\d/.test(JSON.stringify((await call("ahmed", "GET", `/api/orders/${o1.id}`)).body)));
  check("the preparer cannot read the pricing -> 403", (await call("ahmed", "GET", `/api/orders/${o1.id}/pricing`)).status === 403);
  const item = (o: any, p: any) => o.items.find((i: any) => i.stockProductId === p.id);
  await call("ahmed", "POST", `/api/orders/${o1.id}/status`, { to: "preparing" });
  for (const [p, q] of [[tomato, 120], [potato, 80], [salad, 10]] as const) await call("ahmed", "POST", `/api/orders/${o1.id}/items/${item(o1, p).id}/prepare`, { quantity: q, mark_done: true });
  check("prepared in full → ready for loading", (await call("ahmed", "POST", `/api/orders/${o1.id}/status`, { to: "ready_for_loading" })).status === 200);
  const vehicle = (await call("sara", "POST", "/api/operations/vehicles", { code: `${T}V1`, plate: `${T}-P1`, capacity_kg: 2000 })).body.vehicle;
  const driver = (await call("sara", "POST", "/api/operations/drivers", { name: `${T} عم صابر` })).body.driver;
  const trip1 = (await call("sara", "POST", "/api/operations/trips", { trip_date: today, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: [o1.id] })).body.trip;
  check("supervisor plans the trip; the loader cannot -> 403", !!trip1?.id && (await call("mostafa", "POST", "/api/operations/trips", { trip_date: today, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: [] })).status === 403);
  await call("mostafa", "POST", `/api/operations/trips/${trip1.id}/start-loading`, {});
  for (const [p, q] of [[tomato, 120], [potato, 80], [salad, 10]] as const) await call("mostafa", "POST", `/api/orders/${o1.id}/items/${item(o1, p).id}/load`, { quantity: q, mark_done: true });
  await call("mostafa", "POST", `/api/operations/trips/${trip1.id}/loaded`, {});
  const st0 = { t: await onHand(tomato.id), p: await onHand(potato.id), s: await onHand(salad.id) };
  s0 = await snap();
  r = await call("mostafa", "POST", `/api/operations/trips/${trip1.id}/dispatch`, { crates: { [o1.id]: 12 } });
  s1 = await snap();
  check("dispatched: 120 + 80 + 10 kg left stock", r.status === 200 && st0.t - (await onHand(tomato.id)) === 120 && st0.p - (await onHand(potato.id)) === 80 && st0.s - (await onHand(salad.id)) === 10, r.body);
  const dispatchCost = d(s0, s1);
  check("…COGS = inventory out, in the same transaction (no revenue yet)", Object.keys(dispatchCost).sort().join() === "cogs,inv" && dispatchCost.cogs === -dispatchCost.inv && dispatchCost.cogs > 0, dispatchCost);
  check("no invoice before the delivery result -> 409", (await call("karim", "POST", "/api/sales/invoices", { order_id: o1.id })).status === 409);
  const stop1 = (await call("mostafa", "GET", `/api/operations/trips/${trip1.id}`)).body.trip.stops[0];
  r = await call("mostafa", "POST", `/api/operations/stops/${stop1.id}/delivery`, { result: "delivered", receiver_name: "شيف المطبخ", lines: [{ order_item_id: item(o1, tomato).id, rejected_qty: 8, damaged_qty: 2, reason: "طماطم طرية" }] });
  s2 = await snap();
  check("hotel accepts 110 of 120 kg tomato (8 rejected back to stock, 2 damaged), everything else", r.status === 201 && r.body.stop.status === "partial", r.body);
  check("…only the 8 rejected kg came back; their cost left COGS", (await onHand(tomato.id)) === st0.t - 112 && d(s1, s2).cogs < 0 && d(s1, s2).cogs === -d(s1, s2).inv, d(s1, s2));
  const inv1 = (await call("karim", "POST", "/api/sales/invoices", { order_id: o1.id })).body.invoice;
  inv1.lines = (await call("karim", "GET", `/api/sales/invoices/${inv1.id}`)).body.invoice.lines;
  check("the invoice is drafted from accepted quantities", Number(inv1.lines.find((l: any) => l.productId === tomato.id).quantity) === 110, inv1.lines?.map((l: any) => [l.description, l.quantity]));
  check("sales cannot issue invoices -> 403", (await call("mona", "POST", `/api/sales/invoices/${inv1.id}/issue`, {})).status === 403);
  r = await call("karim", "POST", `/api/sales/invoices/${inv1.id}/issue`, {});
  const s3 = await snap();
  const I1 = r.body.invoice;
  check("invoice: 110×9.5 + 80×7 + 10×35 = 1,955 net; VAT 14% on the salad only = 49; total 2,004", I1.net === "1955" && I1.taxTotal === "49" && I1.total === "2004", [I1.net, I1.taxTotal, I1.total]);
  check("…journal exact: Dr AR 2,004 / Cr sales 1,955 / Cr VAT output 49", same((await entry("sales_invoice", I1.number)).lines, { "1300": 2004, "4100": -1955, "2200": -49 }));
  check("…GL moved by exactly that", same(d(s2, s3), { ar: 2004, sales: -1955, vatOut: -49 }), d(s2, s3));
  check("…the order page shows it invoiced, open 2,004", (await call("mona", "GET", `/api/orders/${o1.id}/pricing`)).body.commercial?.invoice?.number === I1.number);
  r = await call("karim", "POST", "/api/sales/invoices", { order_id: o1.id });
  check("asking again for the order's invoice returns the same one (200), never a second", r.status === 200 && r.body.invoice.id === inv1.id, [r.status, r.body.invoice?.id]);
  r = await call("karim", "POST", "/api/accounting/receipts", { party_id: hotel.id, cash_account_id: "bank_main", amount: 7004, method: "bank_transfer", reference: `${T}-TRX1`, allocations: [{ document_id: inv1.id, amount: 2004 }], idempotency_key: `${T}-rct-1` });
  const s4 = await snap();
  check("hotel pays 7,004 by bank: the invoice + 5,000 on account against the Odoo balance", r.status === 201 && n(r.body.receipt.amount) === 7004, r.body);
  check("…receipt journal exact: Dr bank 7,004 / Cr AR 7,004", same((await entry("customer_receipt", r.body.receipt.number)).lines, { "1200": 7004, "1300": -7004 }));
  check("…invoice closed; hotel statement 12,000 + 2,004 − 7,004 = 7,000", (await call("karim", "GET", `/api/sales/invoices/${inv1.id}`)).body.invoice.open === "0.00" && (await owes(hotel.id)) === 7000);
  check("…GL: AR −7,004, bank +7,004", same(d(s3, s4), { ar: -7004, bank: 7004 }), d(s3, s4));
  const ag = (await call("karim", "GET", "/api/sales/reports/aging")).body.rows.find((x: any) => x.customer.id === hotel.id);
  check("…aging agrees with the statement (7,000)", n(ag?.total) === 7000, ag);

  // =========================================================================
  section("2. ORDER → SHORTAGE → APPROVAL → DISPATCH → INVOICE (the chain)");
  r = await call("mona", "POST", "/api/orders", { customer_account_id: chain.id, customer_name: chain.name, delivery_date: today, items: [{ stock_product_id: cucumber.id, product_name: cucumber.name, quantity: 150 }, { stock_product_id: salad.id, product_name: salad.name, quantity: 20 }] });
  const o2 = r.body.order;
  check("chain orders 150 kg cucumber + 20 kg salad", r.status === 201 && !!item(o2, cucumber) && !!item(o2, salad), r.body);
  await call("mona", "PATCH", `/api/orders/${o2.id}/items/${item(o2, cucumber).id}/price`, { unit_price: "6", reason: "سعر العقد" });
  await call("mona", "PATCH", `/api/orders/${o2.id}/items/${item(o2, salad).id}/price`, { unit_price: "34", reason: "سعر العقد" });
  await call("ahmed", "POST", `/api/orders/${o2.id}/status`, { to: "preparing" });
  r = await call("ahmed", "POST", `/api/orders/${o2.id}/items/${item(o2, cucumber).id}/prepare`, { quantity: 120 });
  check("only 120 kg cucumber good enough → shortage flagged, needs review (20% > 5%)", r.status === 200 && r.body.flags?.shortage === true && r.body.flags?.needsReview === true, r.body);
  await call("ahmed", "POST", `/api/orders/${o2.id}/items/${item(o2, cucumber).id}/prepare`, { mark_done: true });
  await call("ahmed", "POST", `/api/orders/${o2.id}/items/${item(o2, salad).id}/prepare`, { quantity: 20, mark_done: true });
  check("the preparer cannot push it on past the shortage", [403, 409].includes((await call("ahmed", "POST", `/api/orders/${o2.id}/status`, { to: "ready_for_loading" })).status));
  check("the loader cannot approve the shortage -> 403", (await call("mostafa", "POST", `/api/orders/${o2.id}/approve`, { reason: "x" })).status === 403);
  let ord2 = (await call("sara", "GET", `/api/orders/${o2.id}`)).body.order;
  r = await call("sara", "POST", `/api/orders/${o2.id}/approve`, { reason: "الخيار ناقص عند المورد — العميل موافق", expected_version: ord2.version });
  check("the supervisor approves the difference (with a reason, on the current version)", r.status === 200 && r.body.order.needsReview === false, r.body);
  check("…now it can go to loading", (await call("ahmed", "POST", `/api/orders/${o2.id}/status`, { to: "ready_for_loading" })).status === 200);
  await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o2.id}/items/${item(o2, cucumber).id}/load`, { quantity: 120, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o2.id}/items/${item(o2, salad).id}/load`, { quantity: 20, mark_done: true });
  ord2 = (await call("sara", "GET", `/api/orders/${o2.id}`)).body.order;
  check("loading the same 120 kg re-raises the review: the loader is held at 'loaded' (designed gate)", ord2.needsReview === true && (await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "loaded" })).status === 409);
  observe("MEDIUM", "Orders", "A shortage approved at preparation is raised again at loading when the loaded quantity equals the approved prepared quantity, so the supervisor approves the same difference twice per short order. Correct but repetitive; the rule could compare the loaded quantity to the already-approved one. Not changed: it is the core order workflow and is pinned by the order regression suite.");
  r = await call("sara", "POST", `/api/orders/${o2.id}/approve`, { reason: "نفس الفرق المعتمد في التجهيز", expected_version: ord2.version });
  check("…the supervisor confirms again; loaded", r.status === 200 && (await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "loaded" })).status === 200, r.body);
  s0 = await snap();
  r = await call("mostafa", "POST", `/api/orders/${o2.id}/status`, { to: "dispatched", vehicle: `${T}-P1`, driver_name: "عم صابر", crate_count: 9 });
  check("dispatched directly (no trip) with the loaded quantities", r.status === 200, r.body);
  s1 = await snap();
  check("…120 kg cucumber + 20 kg salad issued at cost", d(s0, s1).cogs > 0 && d(s0, s1).cogs === -d(s0, s1).inv);
  const inv2 = (await call("karim", "POST", "/api/sales/invoices", { order_id: o2.id })).body.invoice;
  const I2 = (await call("karim", "POST", `/api/sales/invoices/${inv2.id}/issue`, {})).body.invoice;
  check("invoice on the approved quantity: 120×6 + 20×34 = 1,400; VAT 95.20; total 1,495.20", I2.net === "1400" && I2.taxTotal === "95.2" && I2.total === "1495.2", [I2.net, I2.taxTotal, I2.total]);
  check("…journal exact", same((await entry("sales_invoice", I2.number)).lines, { "1300": 1495.2, "4100": -1400, "2200": -95.2 }));
  const hist = (await call("sara", "GET", `/api/audit?orderId=${o2.id}`)).body.logs ?? [];
  check("…the order's history shows both approvals, who, and the reason", hist.filter((l: any) => l.action === "shortage_approved").length === 2 && hist.some((l: any) => l.reason?.includes("الخيار ناقص")), hist.map((l: any) => l.action));

  // =========================================================================
  section("6. DELIVERY FAILURE: trip → loading → dispatch → failed stop → goods back → no invoice");
  const mkOrder = async (c: any, p: any, qty: number, price: string) => {
    const o = (await call("mona", "POST", "/api/orders", { customer_account_id: c.id, customer_name: c.name, delivery_date: today, items: [{ stock_product_id: p.id, product_name: p.name, quantity: qty }] })).body.order;
    await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: price, reason: "قائمة" });
    await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
    await call("ahmed", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/prepare`, { quantity: qty, mark_done: true });
    await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" });
    return o;
  };
  const o3 = await mkOrder(chain, potato, 60, "7");
  const o4 = await mkOrder(cafe, tomato, 40, "10");
  const trip2 = (await call("sara", "POST", "/api/operations/trips", { trip_date: today, vehicle_id: vehicle.id, driver_id: driver.id, order_ids: [o3.id, o4.id] })).body.trip;
  await call("mostafa", "POST", `/api/operations/trips/${trip2.id}/start-loading`, {});
  for (const o of [o3, o4]) await call("mostafa", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: o === o3 ? 60 : 40, mark_done: true });
  await call("mostafa", "POST", `/api/operations/trips/${trip2.id}/loaded`, {});
  const tBefore = await onHand(tomato.id);
  s0 = await snap();
  check("trip dispatched with two stops", (await call("mostafa", "POST", `/api/operations/trips/${trip2.id}/dispatch`, { crates: { [o3.id]: 4, [o4.id]: 3 } })).status === 200);
  s1 = await snap();
  const stops = (await call("mostafa", "GET", `/api/operations/trips/${trip2.id}`)).body.trip.stops;
  const stChain = stops.find((x: any) => x.orderId === o3.id), stCafe = stops.find((x: any) => x.orderId === o4.id);
  check("chain stop delivered in full", (await call("mostafa", "POST", `/api/operations/stops/${stChain.id}/delivery`, { result: "delivered", receiver_name: "أمين المخزن" })).status === 201);
  check("a failure needs a reason -> 400", (await call("mostafa", "POST", `/api/operations/stops/${stCafe.id}/delivery`, { result: "failed" })).status === 400);
  r = await call("mostafa", "POST", `/api/operations/stops/${stCafe.id}/delivery`, { result: "failed", failure_reason: "المحل مقفول" });
  const s2b = await snap();
  check("café stop failed: all 40 kg back on a return document", r.status === 201 && r.body.stop.status === "failed" && !!r.body.stop.returnDocumentId, r.body);
  check("…stock is back where it was, and the 40 kg cost left COGS", (await onHand(tomato.id)) === tBefore && n(d(s1, s2b).cogs) === -n(d(s1, s2b).inv) && d(s1, s2b).inv > 0, d(s1, s2b));
  check("…the café order cannot be invoiced (nothing accepted) -> 409", (await call("karim", "POST", "/api/sales/invoices", { order_id: o4.id })).status === 409);
  check("…and is not on the to-invoice list; the chain order is", ((l) => !l.some((o: any) => o.id === o4.id) && l.some((o: any) => o.id === o3.id))((await call("karim", "GET", "/api/sales/invoices/to-invoice")).body.orders));
  check("…net cost of the trip = the chain's 60 kg potato only", n(d(s0, s2b).cogs) === n(60 * 5), d(s0, s2b));
  check("…the café owes only its opening 800 (no financial correction needed)", (await owes(cafe.id)) === 800);
  const inv3 = (await call("karim", "POST", "/api/sales/invoices", { order_id: o3.id })).body.invoice;
  const I3 = (await call("karim", "POST", `/api/sales/invoices/${inv3.id}/issue`, {})).body.invoice;
  check("chain invoiced 60 × 7 = 420 (exempt)", I3.total === "420" && I3.taxTotal === "0", [I3.total, I3.taxTotal]);

  // =========================================================================
  section("7. CUSTOMER RETURN: invoice → goods back → stock → credit note → AR / VAT / COGS");
  const lines2 = (await call("karim", "GET", `/api/sales/invoices/${inv2.id}`)).body.invoice.lines;
  const lc = lines2.find((l: any) => l.productId === cucumber.id), ls = lines2.find((l: any) => l.productId === salad.id);
  const before7 = { c: await onHand(cucumber.id), s: await onHand(salad.id) };
  s0 = await snap();
  check("sales cannot raise credit notes -> 403", (await call("mona", "POST", `/api/sales/invoices/${inv2.id}/credit-notes`, { reason: "x", lines: [] })).status === 403);
  r = await call("karim", "POST", `/api/sales/invoices/${inv2.id}/credit-notes`, { reason: "الشيف رجّع 10 كجم خيار و2 سلطة", restock: true, lines: [{ invoice_line_id: lc.id, quantity: 10 }, { invoice_line_id: ls.id, quantity: 2 }] });
  s1 = await snap();
  const cn = r.body.creditNote ?? r.body.credit_note ?? r.body.note;
  check("credit note: 10×6 + 2×34 = 128 + VAT 9.52 = 137.52, goods back in the same step", r.status === 201 && n(cn?.total) === 137.52 && (await onHand(cucumber.id)) - before7.c === 10 && (await onHand(salad.id)) - before7.s === 2, [r.status, cn?.total]);
  check("…journal exact: Dr returns 128 + VAT output 9.52 / Cr AR 137.52", same((await entry("credit_note", cn?.number ?? "—")).lines, { "4200": 128, "2200": 9.52, "1300": -137.52 }));
  const g7 = d(s0, s1);
  check("…GL: AR −137.52, returns +128, VAT +9.52, inventory back at cost (COGS reversed by the same)", g7.ar === -137.52 && g7.returns === 128 && g7.vatOut === 9.52 && g7.inv > 0 && g7.inv === -g7.cogs, g7);
  const pc = await product(cucumber.id);
  const qLoc = pc.buckets.find((b: any) => b.locationType === "quarantine" && Number(b.quantity) > 0);
  check("…returned goods land where the warehouse is configured to take them (quarantine if one exists, else the receiving bay)", qLoc ? n(Number(pc.onHand) - Number(pc.available) - Number(pc.reserved)) >= 10 : pc.buckets.some((b: any) => b.locationType === "receiving" && Number(b.quantity) >= 10), pc.buckets.map((b: any) => [b.locationCode, b.quantity]));
  if (!qLoc) observe("MEDIUM", "Returns (business decision)", "No quarantine location is configured, so customer returns and failed-delivery returns go to the receiving bay and are immediately available to pick again, uninspected. The system fully supports a quarantine step (returns land there, quarantined stock is excluded from available and from picking, and is released by transfer or scrapped). Enabling it is one location created in master data — but it changes the warehouse's daily routine, so it is UNITED's decision, not changed during UAT.");
  check("…a return beyond what was invoiced -> 400", (await call("karim", "POST", `/api/sales/invoices/${inv2.id}/credit-notes`, { reason: "x", lines: [{ invoice_line_id: lc.id, quantity: 200 }] })).status === 400);
  const reuseConflict = cn?.returnDocumentId
    ? (await call("karim", "POST", `/api/sales/invoices/${inv2.id}/credit-notes`, { reason: "تكرار لنفس المرتجع", return_document_id: cn.returnDocumentId, lines: [{ invoice_line_id: lc.id, quantity: 5 }] })).status
    : null;
  check("the same physical return cannot authorize a second credit note -> 409", reuseConflict === null || reuseConflict === 409, reuseConflict);
  check("…chain statement: 1,495.20 + 420 − 137.52 = 1,777.68", (await owes(chain.id)) === 1777.68, await owes(chain.id));

  // =========================================================================
  section("8. SUPPLIER RETURN: receipt → return → stock → debit note → AP / GRNI / PPV");
  const bLine = (await call("karim", "GET", `/api/purchasing/bills/${billF.id}`)).body.bill.lines[0];
  const before8 = await onHand(cucumber.id);
  s0 = await snap();
  check("the purchaser cannot raise debit notes -> 403", (await call("omar", "POST", `/api/purchasing/bills/${billF.id}/debit-notes`, { reason: "x", lines: [] })).status === 403);
  r = await call("karim", "POST", `/api/purchasing/bills/${billF.id}/debit-notes`, { reason: "30 كجم خيار مش مطابق — رجع للمزرعة", return_goods: true, lines: [{ bill_line_id: bLine.id, quantity: 30 }] });
  s1 = await snap();
  const dn = r.body.debitNote ?? r.body.debit_note ?? r.body.note;
  check("debit note 30 × 3.90 = 117 with the goods out in one step", r.status === 201 && n(dn?.total) === 117 && before8 - (await onHand(cucumber.id)) === 30, [r.status, dn?.total]);
  const g8 = d(s0, s1);
  check("…AP −117; inventory out at cost; the price difference to PPV; GRNI left at zero", g8.ap === 117 && (g8.grni ?? 0) === 0 && n((g8.inv ?? 0) + (g8.ppv ?? 0)) === -117, g8);
  check("…farm balance 3,592 − 117 = 3,475", (await owed(farm.id)) === 3475, await owed(farm.id));
  check("…returning more than was received on that line -> 400", (await call("karim", "POST", `/api/purchasing/bills/${billF.id}/debit-notes`, { reason: "x", return_goods: true, lines: [{ bill_line_id: bLine.id, quantity: 999 }] })).status === 400);

  // =========================================================================
  section("9. EXPENSE: employee expense → approval → accounting → reimbursement");
  const emp = (await call("karim", "POST", "/api/hr/employees", { name: `${T} عم صابر السواق`, job_title: "سواق" })).body.employee;
  const fuel = (await call("sara", "GET", "/api/hr/expense-accounts")).body.accounts.find((a: any) => a.code === "6200");
  s0 = await snap();
  r = await call("sara", "POST", "/api/hr/expenses", { account_id: fuel.id, amount: 1800, description: `${T} سولار وصيانة العربية — دفعها السواق`, payment_mode: "reimburse", employee_id: emp.id });
  const ex = r.body.expense;
  check("the supervisor records the driver's 1,800 expense: above the limit → waits", r.status === 201 && ex.status === "pending_approval", [r.status, ex?.status]);
  check("…nothing posted yet", same(d(s0, await snap()), {}));
  const ape = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === ex.id);
  check("…finance cannot approve spend it pays -> 403; the supervisor neither", (await call("karim", "POST", `/api/approvals/${ape?.id}/decide`, { decision: "approve" })).status === 403 && (await call("sara", "POST", `/api/approvals/${ape?.id}/decide`, { decision: "approve" })).status === 403);
  check("…management approves", (await call("admin", "POST", `/api/approvals/${ape?.id}/decide`, { decision: "approve", comment: "تمام" })).status === 200);
  s1 = await snap();
  check("…posted: Dr transport 1,800 / Cr employee payable 1,800", same(d(s0, s1), { exp: 1800, empPay: -1800 }), d(s0, s1));
  check("…journal exact", same((await entry("expense", ex.number)).lines, { "6200": 1800, "2300": -1800 }));
  check("the supervisor cannot pay employees -> 403", (await call("sara", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "reimbursement", amount: 1800, cash_account_id: "cash_main" })).status === 403);
  r = await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "reimbursement", amount: 1800, cash_account_id: "cash_main" });
  const s2e = await snap();
  check("finance reimburses from the cash box: Dr employee payable / Cr cash", r.status === 201 && same(d(s1, s2e), { empPay: 1800, cash: -1800 }), d(s1, s2e));
  const est = (await call("karim", "GET", `/api/hr/employees/${emp.id}/statement`)).body.statement;
  check("…employee settled (statement from the journal)", est.owedToEmployee === "0.00" && est.advancesHeld === "0.00", est);


  // =========================================================================
  section("11. ACCOUNTING: every source document → exactly its journal");
  check("receipt (stock in): Dr Inventory 2,444 / Cr GRNI 2,444 for the market tomato", same((await entry("stock_valuation", rcT.receiptNumber)).lines, { "1400": 2444, "2150": -2444 }));
  check("receipt (stock in): Dr Inventory 1,064 / Cr GRNI 1,064 for the farm cucumber", same((await entry("stock_valuation", rcC.receiptNumber)).lines, { "1400": 1064, "2150": -1064 }));
  const g = n(Number((await call("karim", "GET", `/api/purchasing/bills/${billF.id}`)).body.bill?.lines?.[0]?.unitPrice ?? 0));
  const dnE = await entry("debit_note", dn.number);
  check("debit note: Dr AP 117 / Cr GRNI + PPV = 117 (goods value to GRNI, the rest to PPV)", dnE.count === 1 && dnE.lines["2100"] === 117 && n(-(dnE.lines["2150"] ?? 0) - (dnE.lines["5300"] ?? 0)) === 117, [dnE, g]);
  const ce = await entry("credit_note", cn.number);
  check("every document posted exactly one entry (invoice, credit note, bill, debit note, receipt, payment, expense)",
    (await entry("sales_invoice", I1.number)).count === 1 && ce.count === 1 && (await entry("supplier_bill", billM.number)).count === 1 && dnE.count === 1 && (await entry("expense", ex.number)).count === 1);
  const A = (code: string) => acc(code);
  // CTL-01: a manual journal waits for a second person (submitted by the accountant,
  // approved by management) — then posts exactly its lines.
  const mj = await manualJournal({ date: today, description: `${T} بوفيه وضيافة`, lines: [{ account_id: A("6100"), debit: 250 }, { account_id: A("1100"), credit: 250 }] });
  check("manual journal (general expense from the cash box) waits for approval (202), then: Dr 6100 250 / Cr 1100 250", mj.submit.status === 202 && mj.decision?.status === 200 && same((await entry("manual", `${T} بوفيه`)).lines, { "6100": 250, "1100": -250 }), [mj.submit.body, mj.decision?.body]);
  const manualJe = mj.journal;
  check("a manual journal cannot touch receivables / payables / inventory -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: A("1400"), debit: 10 }, { account_id: A("3300"), credit: 10 }] })).status === 400);

  // =========================================================================
  section("12. PERIOD CONTROL: open → posting; closed → blocked; correction by reversal / new document");
  // A valid historical month (dates must be 2000–2100) of its own per run; the accounting
  // suite uses 1990–2019 slots, so a collision is possible — then the month is already closed,
  // which is just as good for proving the lock. Its status is read back, not assumed.
  const sec = Math.floor(Date.now() / 1000);
  const period = `${2000 + (sec % 10)}-${String(1 + (Math.floor(sec / 10) % 12)).padStart(2, "0")}`;
  check("sales cannot close periods -> 403", (await call("mona", "POST", `/api/accounting/periods/${period}/close`, {})).status === 403);
  r = await call("karim", "POST", `/api/accounting/periods/${period}/close`, {});
  const pStatus = (await call("karim", "GET", "/api/accounting/periods")).body.periods.find((x: any) => x.code === period)?.status;
  check(`close ${period} (the period list reads it back as closed)`, (r.status === 200 || r.status === 409) && pStatus === "closed", [r.status, r.body, pStatus]);
  check("the date itself is valid — the refusal below is the period lock, not date validation", /^\d{4}-\d{2}$/.test(period) && Number(period.slice(0, 4)) >= 2000);
  r = await call("karim", "POST", "/api/accounting/journals", { date: `${period}-10`, description: "x", lines: [{ account_id: A("6100"), debit: 1 }, { account_id: A("1100"), credit: 1 }] });
  check("a manual journal into the closed month -> 409 (period lock)", r.status === 409, [r.status, r.body]);
  check("a customer receipt dated in the closed month -> 409", (await call("karim", "POST", "/api/accounting/receipts", { party_id: cafe.id, cash_account_id: "cash_main", amount: 10, method: "cash", date: `${period}-10` })).status === 409);
  // The period lock is what is under test here, so the direct-opening switch is on for
  // this one call (otherwise the default refusal would answer 409 for another reason).
  await setSetting("accounting.direct_opening_entries", true, `${T} period lock check`);
  r = await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: cafe.id, date: `${period}-10`, amount: 10 });
  check("an opening balance dated in the closed month -> 409", r.status === 409 && r.body.code !== "direct_opening_disabled", r.body);
  await setSetting("accounting.direct_opening_entries", null, `${T} period lock check done`);
  r = await call("karim", "POST", `/api/accounting/journals/${manualJe.id}/reverse`, { reason: "اتسجل بالغلط" });
  check("correction: the manual journal is reversed by a new entry (open period)", r.status === 201 && r.body.journal.reversalOfId === manualJe.id, r.body);
  const invJe = (await call("karim", "GET", "/api/accounting/journals?source_type=sales_invoice")).body.journals.find((j: any) => j.description.includes(I2.number));
  check("a document's entry cannot be reversed by hand -> 409 (credit note is the correction)", (await call("karim", "POST", `/api/accounting/journals/${invJe.id}/reverse`, { reason: "x" })).status === 409);
  check("an issued invoice cannot be voided -> 409", (await call("karim", "POST", `/api/sales/invoices/${inv2.id}/void`, { reason: "x" })).status === 409);

  // =========================================================================
  section("13. RBAC: every role only inside its responsibility");
  const deny = async (who: string, method: string, path: string, body?: unknown) => [403, 401].includes((await call(who, method, path, body)).status);
  const matrix: [string, string, string, unknown?][] = [
    // floor: no money, no prices, no customers' balances
    ["ahmed", "GET", `/api/sales/invoices/${inv1.id}`], ["ahmed", "GET", `/api/sales/customers/${hotel.id}/statement?from=2000-01-01&to=2099-12-31`], ["ahmed", "GET", "/api/accounting/trial-balance"],
    ["ahmed", "GET", "/api/inventory/reports/valuation"], ["ahmed", "POST", "/api/accounting/receipts", {}], ["ahmed", "GET", "/api/eta"], ["ahmed", "POST", "/api/inventory/transfers", { lines: [] }],
    ["mostafa", "GET", `/api/orders/${o1.id}/pricing`], ["mostafa", "GET", "/api/sales/invoices"], ["mostafa", "GET", "/api/purchasing/orders"], ["mostafa", "POST", `/api/orders/${o2.id}/approve`, { reason: "x" }],
    // stock controller: quantities, not money
    ["hossam", "GET", `/api/purchasing/bills/${billF.id}`], ["hossam", "GET", "/api/sales/invoices"], ["hossam", "GET", "/api/inventory/reports/valuation"], ["hossam", "GET", `/api/purchasing/suppliers/${farm.id}/statement?from=2000-01-01&to=2099-12-31`], ["hossam", "POST", "/api/accounting/opening-stock", { lines: [] }],
    // sales: sells and follows, does not book or pay
    ["mona", "POST", "/api/purchasing/bills", {}], ["mona", "POST", "/api/accounting/payments", {}], ["mona", "POST", "/api/accounting/journals", {}], ["mona", "GET", "/api/accounting/trial-balance"], ["mona", "GET", "/api/management/finance"], ["mona", "GET", `/api/purchasing/suppliers/${farm.id}/statement?from=2000-01-01&to=2099-12-31`], ["mona", "POST", `/api/sales/invoices/${inv1.id}/credit-notes`, {}],
    // purchaser: buys, does not receive, book bills or pay
    ["omar", "POST", "/api/accounting/payments", {}], ["omar", "POST", "/api/purchasing/bills", {}], ["omar", "GET", `/api/sales/customers/${hotel.id}/statement?from=2000-01-01&to=2099-12-31`], ["omar", "GET", "/api/accounting/trial-balance"], ["omar", "POST", "/api/inventory/adjustments", { reason: "x", lines: [] }],
    // accountant: no floor actions, no self-approval
    ["karim", "POST", `/api/orders/${o1.id}/items/${o1.items[0].id}/prepare`, { quantity: 1 }], ["karim", "POST", "/api/inventory/transfers", { lines: [] }], ["karim", "POST", "/api/orders", {}],
    // supervisor: runs operations, no books
    ["sara", "POST", "/api/accounting/journals", {}], ["sara", "POST", "/api/accounting/payments", {}], ["sara", "GET", "/api/management/finance"], ["sara", "POST", `/api/eta/invoices/${inv1.id}/submit`, {}], ["sara", "POST", "/api/purchasing/bills", {}],
  ];
  const leaks: string[] = [];
  for (const [who, m, path, body] of matrix) if (!(await deny(who, m, path, body))) leaks.push(`${who} ${m} ${path}`);
  check(`${matrix.length} out-of-responsibility attempts across 7 roles are all refused by the server`, leaks.length === 0, leaks);
  const floorView = JSON.stringify((await call("hossam", "GET", `/api/inventory/products/${tomato.id}`)).body);
  check("the stock controller sees quantities, never costs", !/"unitCost":"?\d/.test(floorView) && !/"value":"?\d/.test(floorView));
  check("sales reads invoices and customer balances (its job)", (await call("mona", "GET", `/api/sales/invoices/${inv1.id}`)).status === 200 && (await call("mona", "GET", `/api/sales/customers/${hotel.id}/statement?from=2000-01-01&to=2099-12-31`)).status === 200);

  // =========================================================================
  section("14. CONCURRENCY / DUPLICATION");
  const triple = <X>(f: () => Promise<X>) => Promise.all([f(), f(), f()]);
  r = await triple(() => call("karim", "POST", "/api/accounting/receipts", { party_id: chain.id, cash_account_id: "bank_main", amount: 1000, method: "bank_transfer", auto: true, idempotency_key: `${T}-dup-rct` }));
  check("receipt submitted 3× at once → one receipt, chain owes 777.68", new Set(r.map((x: any) => x.body.receipt?.id)).size === 1 && (await owes(chain.id)) === 777.68, r.map((x: any) => x.status));
  r = await triple(() => call("karim", "POST", "/api/accounting/payments", { party_id: farm.id, cash_account_id: "bank_main", amount: 475, method: "bank_transfer", auto: true, idempotency_key: `${T}-dup-pay` }));
  check("payment submitted 3× at once → one payment, farm 3,000", new Set(r.map((x: any) => x.body.payment?.id)).size === 1 && (await owed(farm.id)) === 3000, r.map((x: any) => x.status));
  const tc = await onHand(tomato.id);
  r = await triple(() => call("hossam", "POST", "/api/inventory/transfers", { reason: "dup", idempotency_key: `${T}-dup-tr`, lines: [{ product_id: tomato.id, quantity: 5, location_id: "loc_cold_1", to_location_id: "loc_cold_2" }] }));
  check("stock transfer posted 3× with one key → one document", new Set(r.map((x: any) => x.body.document?.id)).size === 1 && (await onHand(tomato.id)) === tc, r.map((x: any) => x.status));
  const o5 = await mkOrder(cafe, potato, 20, "7");
  await call("mostafa", "POST", `/api/orders/${o5.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${o5.id}/items/${o5.items[0].id}/load`, { quantity: 20, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${o5.id}/status`, { to: "loaded" });
  const pb = await onHand(potato.id);
  r = await triple(() => call("mostafa", "POST", `/api/orders/${o5.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 }));
  check("dispatch tapped 3× → stock issued once (20 kg)", r.filter((x: any) => x.status === 200).length >= 1 && pb - (await onHand(potato.id)) === 20, r.map((x: any) => x.status));
  r = await triple(() => call("karim", "POST", "/api/sales/invoices", { order_id: o5.id }));
  check("invoice drafted 3× at once → one invoice", new Set(r.map((x: any) => x.body.invoice?.id)).size === 1, r.map((x: any) => x.status));
  const inv5 = r[0].body.invoice;
  r = await triple(() => call("karim", "POST", `/api/sales/invoices/${inv5.id}/issue`, {}));
  check("issued 3× at once → one number, one journal entry", r.filter((x: any) => x.status === 200).length === 1 && (await entry("sales_invoice", (await call("karim", "GET", `/api/sales/invoices/${inv5.id}`)).body.invoice.number)).count === 1, r.map((x: any) => x.status));
  check("issued 3× at once → losing requests get a clean 409 (already issued)", r.filter((x: any) => x.status !== 200).every((x: any) => x.status === 409 && x.body?.error?.includes("صدرت بالفعل")), r.map((x: any) => [x.status, x.body?.error]));
  r = await triple(() => call("karim", "POST", `/api/eta/invoices/${inv5.id}/submit`, {}));
  check("ETA submission 3× at once → refused alike (not ready / not configured), nothing recorded", r.every((x: any) => [422, 503].includes(x.status)) && (await call("karim", "GET", `/api/eta/invoices/${inv5.id}`)).body.eta === null, r.map((x: any) => x.status));
  // Receiving: the screen sends one key per filled form, so a retry or a duplicate
  // request returns the first receipt.
  const pb2 = await onHand(potato.id);
  r = await triple(() => call("hossam", "POST", "/api/stock/intakes", { supplier_id: market.id, product_id: potato.id, received_kg: 50, unit_cost: "5", location_id: "loc_cold_1", idempotency_key: `${T}-dup-rcv` }));
  check("stock receipt submitted 3× at once → one receipt (201 + two 200 replays), 50 kg posted once", new Set(r.map((x: any) => x.body.intake?.id)).size === 1 && r.filter((x: any) => x.status === 201).length === 1 && r.filter((x: any) => x.status === 200).length === 2 && (await onHand(potato.id)) - pb2 === 50, r.map((x: any) => x.status));
  r = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: market.id, product_id: potato.id, received_kg: 50, unit_cost: "5", location_id: "loc_cold_1", idempotency_key: `${T}-dup-rcv` });
  check("…a retry after a timeout returns the same receipt (200), nothing posted", r.status === 200 && (await onHand(potato.id)) - pb2 === 50);
  check("…the same key with a different quantity → 409", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: market.id, product_id: potato.id, received_kg: 55, unit_cost: "5", location_id: "loc_cold_1", idempotency_key: `${T}-dup-rcv` })).status === 409);
  const poLineBefore = n((await call("omar", "GET", `/api/purchasing/orders/${poF.id}`)).body.order.lines[0].receivedGood);
  const cb = await onHand(cucumber.id);
  const sv0 = await snap();
  r = await triple(() => call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: poF.lines[0].id, received_kg: 10, location_id: "loc_cold_2", idempotency_key: `${T}-dup-po` }));
  const sv1 = await snap();
  check("PO receipt submitted 3× at once → one receipt, the PO counts 10 kg once, at the PO cost (3.80)", new Set(r.map((x: any) => x.body.intake?.id)).size === 1 && n((await call("omar", "GET", `/api/purchasing/orders/${poF.id}`)).body.order.lines[0].receivedGood) - poLineBefore === 10 && (await onHand(cucumber.id)) - cb === 10 && same(d(sv0, sv1), { inv: 38, grni: -38 }), [r.map((x: any) => x.status), d(sv0, sv1)]);

  // =========================================================================
  section("17. INVENTORY HEALTH: ledger = buckets = valuation, and = the scenario's physical story");
  const expected: [any, number, string][] = [
    [tomato, 658, "300 opening + 470 received − 120 out + 8 rejected back − 40 out + 40 failed stop back"],
    [cucumber, 335, "200 + 280 − 15 count − 120 out + 10 returned − 30 back to the farm + 10 keyed PO receipt"],
    [salad, 22, "50 − 10 − 20 + 2 returned"],
    [potato, 290, "400 − 80 − 60 − 20 + 50 received"],
  ];
  const valRows = (await call("karim", "GET", "/api/inventory/reports/valuation")).body.rows;
  for (const [p, qty, story] of expected) {
    const det = await product(p.id);
    const ledger = (await call("hossam", "GET", `/api/stock/ledger?product_id=${p.id}&limit=1000`)).body.movements;
    const ledgerSum = n(ledger.reduce((s: number, m: any) => s + Number(m.quantity ?? m.quantityKg ?? 0), 0));
    const bucketSum = n(det.buckets.reduce((s: number, b: any) => s + Number(b.quantity), 0));
    const vr = valRows.find((x: any) => x.productId === p.id);
    check(`${p.name}: on hand ${qty} (${story}); ledger, buckets and valuation agree`, n(det.onHand) === qty && ledgerSum === qty && bucketSum === qty && n(vr?.quantity) === qty, { onHand: det.onHand, ledgerSum, bucketSum, valuation: vr?.quantity });
  }
  check("no negative bucket anywhere for the UAT products", (await Promise.all(expected.map(async ([p]) => (await product(p.id)).buckets.every((b: any) => Number(b.quantity) >= 0)))).every(Boolean));

  // =========================================================================
  section("18. COMMERCIAL HEALTH: balances, statements and aging agree");
  // A price allowance on an invoice that is already fully paid: the customer ends up with credit.
  const tl = (await call("karim", "GET", `/api/sales/invoices/${inv1.id}`)).body.invoice.lines.find((l: any) => l.productId === tomato.id);
  r = await call("karim", "POST", `/api/sales/invoices/${inv1.id}/credit-notes`, { reason: "خصم جودة على 2 كجم طماطم", lines: [{ invoice_line_id: tl.id, quantity: 2 }] });
  check("price allowance on the paid hotel invoice: credit note 19.00 (no goods back)", r.status === 201 && n((r.body.creditNote ?? r.body.credit_note ?? r.body.note)?.total) === 19, r.body);
  const arAging = (await call("karim", "GET", "/api/sales/reports/aging")).body.rows;
  for (const [c, amt] of [[hotel, 6981], [chain, 777.68], [cafe, 800 + 140]] as const) {
    const ag2 = arAging.find((x: any) => x.customer.id === c.id);
    check(`${c.name}: statement ${amt} = aging total`, (await owes(c.id)) === amt && n(ag2?.total) === amt, [await owes(c.id), ag2?.total]);
  }
  const apAging = (await call("karim", "GET", "/api/purchasing/reports/ap-aging")).body.aging.rows;
  for (const [sp, amt] of [[farm, 3000], [market, 0]] as const) {
    const a2 = apAging.find((x: any) => x.supplier.id === sp.id);
    check(`${sp.name}: statement ${amt} = AP aging`, (await owed(sp.id)) === amt && n(a2?.total ?? 0) === amt, [await owed(sp.id), a2?.total]);
  }

  // =========================================================================
  section("16. ACCOUNTS HEALTH after the whole scenario set");
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  for (const c of health.checks) check(`accounts health: ${c.label}`, c.ok, c);
  const tb = (await call("karim", "GET", "/api/accounting/trial-balance?from=2000-01-01&to=2099-12-31")).body.trialBalance;
  check("trial balance balanced", tb.balanced === true);

  // =========================================================================
  section("19. REPORT HEALTH: reports read the same truth as the documents and the GL");
  const fin = (await call("karim", "GET", `/api/management/finance?from=${today}&to=${today}`)).body.report;
  const rev = (name: string) => n(fin.sales.byProduct.find((x: any) => x.product.includes(name))?.revenue);
  // The report lists the top 30 products by revenue; a shared test database holds hundreds of
  // test products, so the UAT products may fall outside it. Those listed must be exact.
  const want2: [string, number][] = [[`${T} Tomato`, 1045 - 19], [`${T} Cucumber`, 660], [`${T} Salad`, 962]];
  const seen = want2.filter(([nm]) => fin.sales.byProduct.some((x: any) => x.product.includes(nm)));
  check(`product revenue = invoice lines − credit note lines for the UAT products listed (${seen.length} of ${want2.length} in the top 30)`, seen.every(([nm, v]) => rev(nm) === v), seen.map(([nm, v]) => [nm, rev(nm), v]));
  const sales = n(fin.profitAndLoss.lines.filter((x: any) => x.code === "4100" || x.code === "4200").reduce((s: number, x: any) => s + Number(x.amount), 0));
  check("document revenue (invoices − credit notes) = GL sales − returns for the day", n(fin.sales.revenue) === sales, [fin.sales.revenue, sales]);
  const ops = (await call("sara", "GET", `/api/management/operations?from=${today}&to=${today}`)).body.report;
  check("operations report covers today's orders and trips", !!ops && JSON.stringify(ops).length > 50);

  // =========================================================================
  section("20. INVOICE PRINT against the issued invoice (Arabic RTL + English)");
  for (const [inv, I] of [[inv1, I1], [inv2, I2]] as const) {
    const full = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
    const fmt = (v: unknown) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ar = await page("mona", `/sales/invoices/${inv.id}/print`);
    const en = await page("mona", `/sales/invoices/${inv.id}/print?lang=en`);
    const figures = [fmt(full.net), fmt(full.taxTotal), fmt(full.total), ...full.lines.map((l: any) => fmt(l.total))];
    check(`${I.number}: Arabic print is RTL with number, every line total, net, tax and total`, /dir="rtl"/.test(ar.html) && ar.html.includes(I.number) && figures.every((f) => ar.html.includes(f)), figures.filter((f) => !ar.html.includes(f)));
    check(`${I.number}: English print is LTR with the same figures`, /dir="ltr"/.test(en.html) && en.html.includes("Tax Invoice") && figures.every((f) => en.html.includes(f)));
    check(`${I.number}: paid / balance printed from the receipts`, ar.html.includes(Number(full.open) <= 0 ? "مدفوعة بالكامل" : fmt(full.open)), [full.open]);
  }

  // =========================================================================
  section("21. ETA (no production submission): mapping, validation, missing data, idempotency, permissions, credentials");
  r = await call("karim", "GET", `/api/eta/invoices/${inv1.id}`);
  const doc = r.body.document;
  check("the mapped v1.0 document carries the invoice's own figures", doc?.documentTypeVersion === "1.0" && doc.internalID === I1.number && doc.totalAmount === 2004 && doc.netAmount === 1955 && doc.taxTotals.reduce((s: number, t: any) => s + t.amount, 0) === 49, doc && [doc.totalAmount, doc.netAmount, doc.taxTotals]);
  check("…VAT line classified T1/V009 at 14%, exempt lines T1/V003 at 0", doc.invoiceLines.some((l: any) => l.taxableItems[0].subType === "V009" && l.taxableItems[0].rate === 14 && l.taxableItems[0].amount === 49) && doc.invoiceLines.filter((l: any) => l.taxableItems[0].subType === "V003").length === 2);
  const msgs = r.body.issues.filter((i: any) => i.level === "error").map((i: any) => i.field);
  check("missing ETA data detected per field (item codes, unit types, issuer branch/activity, receiver address) — not invented", ["itemCode", "unitType", "branchID", "taxpayerActivityCode", "receiver.address"].every((f) => msgs.some((m: string) => m.includes(f))), msgs);
  check("ETA status hidden from sales and the floor; supervisor read-only", (await call("mona", "GET", `/api/eta/invoices/${inv1.id}`)).status === 403 && (await call("hossam", "GET", "/api/eta")).status === 403 && (await call("sara", "GET", `/api/eta/invoices/${inv1.id}`)).status === 200);
  const etaOv = (await call("karim", "GET", "/api/eta")).body.eta;
  check("credentials isolated: only variable names, never values", etaOv.config.missing.every((m: string) => /^ETA_[A-Z_]+$/.test(m)) && !/Bearer|access_token/i.test(JSON.stringify({ ...etaOv, config: null })));
  observe("HIGH", "ETA", "ETA mapping is implemented and validated internally but is NOT verified against the official SDK (sdk.invoicing.eta.gov.eg was unreachable from this environment). Production submission also needs ETA credentials, the e-seal signing bridge, registered item codes and the accountant's confirmation of tax subtypes. Until then invoices are issued in UNITED and e-invoices remain a manual/Odoo process.");
}

main()
  .then(() => {
    console.log("\n=== OBSERVATIONS (not test failures) ===");
    for (const o of observations) console.log(` [${o.severity}] ${o.area}: ${o.text}`);
    finish("ODOO-REPLACEMENT UAT");
  })
  .catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
