/* Purchasing end to end: supplier master and prices, RFQ → quotes → award → PO,
   PO approval, receiving against the PO (with sorting, lots and cost), supplier bills
   with three-way matching, debit notes and payables. */
import { call, login, makeChecker, page } from "./_harness";
import { todayBiz } from "./_days";

const { check, section, finish } = makeChecker();
const TAG = `ZZPUR${Date.now() % 1_000_000_000}`;
const taxId = String(200000000 + (Date.now() % 799999999)).slice(0, 9);
let r: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mona", "karim", "omar"]) await login(u);
  const setting = async (key: string, value: unknown) => {
    const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
    const res = await call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: TAG, expected_version: cur.version });
    if (res.status !== 200) throw new Error(`setting ${key}: ${JSON.stringify(res.body)}`);
  };

  section("1. SUPPLIER MASTER");
  r = await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} مزرعة الدلتا`, type: "farm", tax_registration_no: taxId, payment_terms_days: 15, lead_time_days: 1, city: "البحيرة" });
  check("buyer creates a supplier with terms -> 201", r.status === 201 && /^SUP-\d{5,}$/.test(r.body.supplier.code) && r.body.supplier.paymentTermsDays === 15, r.body);
  const farm = r.body.supplier;
  const market = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} تاجر العبور`, type: "market_trader" })).body.supplier;
  check("duplicate tax id -> 409", (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} x`, tax_registration_no: taxId })).status === 409);
  check("unknown supplier type -> 400", (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} y`, type: "pirate" })).status === 400);
  check("a supplier created from the stock gate also gets a code", /^SUP-\d{5,}$/.test((await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} فلاح على الباب` })).body.supplier?.code ?? ""));
  check("stock controller cannot change commercial terms -> 403", (await call("hossam", "PATCH", `/api/purchasing/suppliers/${farm.id}`, { payment_terms_days: 90 })).status === 403);
  // D-2 (Nov 2026): the stock controller reads supplier profiles — never their money, never their terms.
  check("stock controller reads the supplier directory -> 200", (await call("hossam", "GET", "/api/purchasing/suppliers")).status === 200);
  check("…and a supplier's record -> 200", (await call("hossam", "GET", `/api/purchasing/suppliers/${farm.id}`)).status === 200);
  check("…and opens the supplier profile page", (await page("hossam", `/purchasing/suppliers/${farm.id}`)).status === 200);
  check("…its summary and receipts sections -> 200", (await call("hossam", "GET", `/api/profiles/supplier/${farm.id}/summary`)).status === 200 && (await call("hossam", "GET", `/api/profiles/supplier/${farm.id}/receipts`)).status === 200);
  check("…but not its bills or payments -> 403", (await call("hossam", "GET", `/api/profiles/supplier/${farm.id}/bills`)).status === 403 && (await call("hossam", "GET", `/api/profiles/supplier/${farm.id}/payments`)).status === 403);
  check("…nor its statement -> 403", (await call("hossam", "GET", `/api/purchasing/suppliers/${farm.id}/statement?from=2026-01-01&to=2026-12-31`)).status === 403);
  check("…nor create a supplier with terms -> 403", (await call("hossam", "POST", "/api/purchasing/suppliers", { name: `${TAG} z`, category: "vegetable" })).status === 403);
  check("…nor classify one -> 403", (await call("hossam", "PATCH", `/api/purchasing/suppliers/${farm.id}`, { category: "fruit" })).status === 403);
  check("sales cannot see suppliers -> 403", (await call("mona", "GET", "/api/purchasing/suppliers")).status === 403);
  r = await call("karim", "PATCH", `/api/purchasing/suppliers/${farm.id}`, { payment_terms_days: 30, expected_version: farm.version });
  check("finance changes payment terms", r.status === 200 && r.body.supplier.paymentTermsDays === 30, r.body);
  check("stale version -> 409", (await call("karim", "PATCH", `/api/purchasing/suppliers/${farm.id}`, { payment_terms_days: 20, expected_version: farm.version })).status === 409);
  // D-2: the stock controller's identity edit (its stock permission) still works on the same record.
  const farmNow = (await call("omar", "GET", `/api/purchasing/suppliers/${farm.id}`)).body.supplier;
  check("stock controller's identity edit still works -> 200", (await call("hossam", "PATCH", `/api/purchasing/suppliers/${farm.id}`, { phone: "01001234567", expected_version: farmNow.version })).status === 200);
  check("primary contact", (await call("omar", "POST", `/api/purchasing/suppliers/${farm.id}/contacts`, { name: "الحاج سعيد", phone: "0100", is_primary: true })).status === 201);

  section("2. SUPPLIER PRICES (DATED)");
  const tomato = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Tomato`, unit: "KG" })).body.product;
  await call("hossam", "POST", `/api/inventory/products/${tomato.id}/packagings`, { uom: "CRATE", qty_in_base_unit: 20 });
  const onion = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Onion`, unit: "KG" })).body.product;
  r = await call("omar", "POST", `/api/purchasing/suppliers/${farm.id}/prices`, { valid_from: "2026-01-01", prices: [{ product_id: tomato.id, unit_price: "8.5" }, { product_id: onion.id, unit_price: 6 }] });
  check("agreed prices from Jan 1st", r.status === 200 && r.body.created === 2, r.body);
  await call("omar", "POST", `/api/purchasing/suppliers/${market.id}/prices`, { valid_from: "2026-01-01", prices: [{ product_id: tomato.id, unit_price: "7.75" }] });
  check("stock controller cannot see supplier prices -> 403", (await call("hossam", "GET", `/api/purchasing/suppliers/${farm.id}/prices`)).status === 403);
  check("…nor set them -> 403", (await call("hossam", "POST", `/api/purchasing/suppliers/${farm.id}/prices`, { valid_from: "2026-01-01", prices: [{ product_id: tomato.id, unit_price: 1 }] })).status === 403);
  const cmp = (await call("omar", "GET", `/api/purchasing/products/${tomato.id}/prices`)).body;
  check("price comparison for tomato, cheapest first", cmp.prices?.[0]?.supplier.id === market.id && cmp.prices?.[1]?.supplier.id === farm.id, cmp.prices?.map((p: any) => [p.supplier.name, p.unitPrice]));

  section("3. RFQ → QUOTES → AWARD");
  r = await call("omar", "POST", "/api/purchasing/rfqs", { needed_by: "2026-12-20", lines: [{ product_id: tomato.id, quantity: 50, uom: "CRATE" }, { product_id: onion.id, quantity: 300 }], supplier_ids: [farm.id, market.id] });
  check("RFQ to two suppliers -> 201", r.status === 201 && /^RFQ-\d{4}-\d{5}$/.test(r.body.rfq.number), r.body);
  const rfq = r.body.rfq;
  let rd = (await call("omar", "GET", `/api/purchasing/rfqs/${rfq.id}`)).body.rfq;
  const [tLine, oLine] = rd.comparison.map((c: any) => c.line);
  check("quotes before sending -> 409", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/quotes`, { supplier_id: farm.id, lines: [{ rfq_line_id: tLine.id, unit_price: 160 }] })).status === 409);
  check("send", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/send`, {})).status === 200);
  check("farm quotes 165/crate tomato, 5.9/kg onion", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/quotes`, { supplier_id: farm.id, valid_until: "2099-01-01", lines: [{ rfq_line_id: tLine.id, unit_price: 165 }, { rfq_line_id: oLine.id, unit_price: "5.9" }] })).status === 200);
  check("market quotes 150/crate tomato only", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/quotes`, { supplier_id: market.id, lines: [{ rfq_line_id: tLine.id, unit_price: 150, lead_time_days: 0 }] })).status === 200);
  check("an uninvited supplier's quote -> 400", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/quotes`, { supplier_id: (await call("omar", "GET", "/api/purchasing/suppliers")).body.suppliers.find((s: any) => s.id !== farm.id && s.id !== market.id).id, lines: [{ rfq_line_id: tLine.id, unit_price: 1 }] })).status === 400);
  rd = (await call("omar", "GET", `/api/purchasing/rfqs/${rfq.id}`)).body.rfq;
  check("comparison: market cheapest on tomato, farm the only one on onion", rd.comparison[0].cheapestSupplierId === market.id && rd.comparison[1].cheapestSupplierId === farm.id && rd.comparison[1].quotes.length === 1);
  check("stock controller cannot read quotes -> 403", (await call("hossam", "GET", `/api/purchasing/rfqs/${rfq.id}`)).status === 403);
  check("awarding a line to a supplier that did not price it -> 400", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/award`, { awards: [{ rfq_line_id: oLine.id, supplier_id: market.id }] })).status === 400);
  r = await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/award`, { awards: [{ rfq_line_id: tLine.id, supplier_id: market.id }, { rfq_line_id: oLine.id, supplier_id: farm.id }] });
  check("award: one draft PO per supplier", r.status === 201 && r.body.orders.length === 2 && r.body.orders.every((o: any) => o.status === "draft"), r.body);
  const poMarket = r.body.orders.find((o: any) => o.supplierId === market.id);
  const poFarm = r.body.orders.find((o: any) => o.supplierId === farm.id);
  check("awarding twice -> 409", (await call("omar", "POST", `/api/purchasing/rfqs/${rfq.id}/award`, { awards: [{ rfq_line_id: tLine.id, supplier_id: market.id }] })).status === 409);
  let po = (await call("omar", "GET", `/api/purchasing/orders/${poMarket.id}`)).body.order;
  check("market PO: 50 crates = 1000 kg at the quoted 150/crate = 7500", po.lines[0].quantity === "50" && po.lines[0].baseQuantity === "1000" && po.lines[0].unitPrice === "150" && po.lines[0].priceSource === "quotation" && po.total === "7500.00", po.lines[0]);

  section("4. PURCHASE ORDERS AND APPROVAL");
  await setting("purchasing.po_approval_threshold", 5000);
  check("submit the 7,500 PO: waits for finance", (await call("omar", "POST", `/api/purchasing/orders/${poMarket.id}/submit`, {})).body.order?.status === "pending_approval");
  check("sending before approval -> 409", (await call("omar", "POST", `/api/purchasing/orders/${poMarket.id}/send`, {})).status === 409);
  const pa = (await call("karim", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === poMarket.id);
  check("finance has it in the inbox", pa?.type === "purchasing.order" && pa?.canDecide === true, pa);
  check("the buyer cannot approve their own spend -> 403", (await call("omar", "POST", `/api/approvals/${pa.id}/decide`, { decision: "approve" })).status === 403);
  check("finance rejects (with a reason)", (await call("karim", "POST", `/api/approvals/${pa.id}/decide`, { decision: "reject", comment: "اتفاوض على سعر أقل" })).status === 200);
  po = (await call("omar", "GET", `/api/purchasing/orders/${poMarket.id}`)).body.order;
  check("…back to draft for the buyer", po.status === "draft");
  r = await call("omar", "PUT", `/api/purchasing/orders/${poMarket.id}`, { supplier_id: market.id, lines: [{ product_id: tomato.id, quantity: 50, uom: "CRATE", unit_price: 145 }], expected_version: po.version });
  check("a typed price (not agreed) needs prices.manage — the buyer has it", r.status === 200 && r.body.order.lines[0].priceSource === "manual" && r.body.order.total === "7250.00", r.body);
  check("resubmit", (await call("omar", "POST", `/api/purchasing/orders/${poMarket.id}/submit`, {})).body.order?.status === "pending_approval");
  const pa2 = (await call("karim", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === poMarket.id);
  check("finance approves", (await call("karim", "POST", `/api/approvals/${pa2.id}/decide`, { decision: "approve", comment: "تمام" })).status === 200);
  check("…send to the supplier", (await call("omar", "POST", `/api/purchasing/orders/${poMarket.id}/send`, {})).body.order?.status === "sent");
  check("editing a sent PO -> 409", (await call("omar", "PUT", `/api/purchasing/orders/${poMarket.id}`, { supplier_id: market.id, lines: [{ product_id: tomato.id, quantity: 1 }] })).status === 409);
  po = (await call("omar", "GET", `/api/purchasing/orders/${poFarm.id}`)).body.order;
  check("onion PO: 300 × 5.9 = 1770 (under the threshold)", po.total === "1770.00");
  check("…submitting approves it by rule", (await call("omar", "POST", `/api/purchasing/orders/${poFarm.id}/submit`, {})).body.order?.status === "approved");
  check("…and it is sent", (await call("omar", "POST", `/api/purchasing/orders/${poFarm.id}/send`, {})).status === 200);
  r = await call("omar", "POST", "/api/purchasing/orders", { supplier_id: farm.id, lines: [{ product_id: tomato.id, quantity: 10 }] });
  check("a direct PO at the agreed price (8.5/kg)", r.status === 201 && r.body.order.total === "85.00", r.body);
  const poCancel = r.body.order;
  check("cancel needs a reason -> 400", (await call("omar", "POST", `/api/purchasing/orders/${poCancel.id}/cancel`, {})).status === 400);
  check("cancel a draft", (await call("omar", "POST", `/api/purchasing/orders/${poCancel.id}/cancel`, { reason: "مش محتاجينه" })).body.order?.status === "cancelled");
  check("no agreed price and none typed -> 400", (await call("omar", "POST", "/api/purchasing/orders", { supplier_id: market.id, lines: [{ product_id: onion.id, quantity: 1 }] })).status === 400);
  check("supervisor may read POs but not raise them -> 403", (await call("sara", "POST", "/api/purchasing/orders", { supplier_id: farm.id, lines: [{ product_id: tomato.id, quantity: 1 }] })).status === 403);
  const forReceiver = (await call("hossam", "GET", `/api/purchasing/orders/${poMarket.id}`)).body.order;
  const priceKeys = (o: unknown): string[] => JSON.stringify(o).match(/"(unitPrice|discountPct|amounts|net|taxTotal|total|gross|priceSource)":/g) ?? [];
  check("the receiver sees quantities, never prices", forReceiver.lines[0].baseQuantity === "1000" && priceKeys(forReceiver).length === 0, priceKeys(forReceiver));
  check("…in the PO list either", priceKeys((await call("hossam", "GET", "/api/purchasing/orders?open=1")).body).length === 0);
  await setting("purchasing.po_approval_threshold", null);

  // Later sections (receiving, bills) are appended below.
  (globalThis as any).__pur = { farm, market, tomato, onion, poMarket, poFarm };
  await receivingAndBills();
  finish("PURCHASING");
}

async function receivingAndBills() {
  const { farm, market, tomato, onion, poMarket, poFarm } = (globalThis as any).__pur;
  const priceKeys = (o: unknown): string[] => JSON.stringify(o).match(/"(unitPrice|discountPct|amounts|net|taxTotal|total|gross|priceSource|unitCost)":/g) ?? [];
  const order = async (id: string) => (await call("omar", "GET", `/api/purchasing/orders/${id}`)).body.order;
  const intakeOf = async (id: string) => (await call("admin", "GET", `/api/stock/intakes/${id}`)).body.intake;

  section("5. RECEIVING AGAINST THE PO");
  r = await call("hossam", "GET", `/api/purchasing/receiving?supplier_id=${market.id}`);
  const tLineRcv = r.body.lines?.find((l: any) => l.poNumber === poMarket.number);
  check("the gate sees what is still expected from the supplier", r.status === 200 && tLineRcv?.remaining === "1000" && tLineRcv?.product.id === tomato.id, r.body);
  check("…with no prices anywhere", priceKeys(r.body).length === 0, priceKeys(r.body));
  check("the buyer does not receive -> 403", (await call("omar", "GET", "/api/purchasing/receiving")).status === 403);
  const lineId = tLineRcv.lineId;
  check("a supplier other than the PO's -> 400", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: lineId, supplier_id: farm.id, received_kg: 10 })).status === 400);
  check("a product other than the line's -> 400", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: lineId, product_id: onion.id, received_kg: 10 })).status === 400);
  check("a typed cost on a PO receipt -> 400 (the PO sets it)", (await call("admin", "POST", "/api/stock/intakes", { purchase_order_line_id: lineId, received_kg: 10, unit_cost: 1 })).status === 400);
  check("an unknown PO line -> 404", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: "nope", received_kg: 10 })).status === 404);
  const draft = (await call("omar", "POST", "/api/purchasing/orders", { supplier_id: farm.id, lines: [{ product_id: tomato.id, quantity: 10 }] })).body.order;
  check("receiving on a draft (unapproved) PO -> 409", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: draft.lines[0].id, received_kg: 10 })).status === 409);

  r = await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: lineId, received_kg: 400, rejected_kg: 20, rejection_reason: "طماطم مفعوصة", crate_count: 20 });
  check("receive 400 kg (20 sorted out) against the PO -> 201", r.status === 201 && r.body.intake.supplierId === market.id && r.body.intake.productId === tomato.id && r.body.intake.purchaseOrderLine?.po.number === poMarket.number, r.body);
  const rc1 = r.body.intake;
  check("…sorting reason kept, a lot was created", rc1.rejectionReason === "طماطم مفعوصة" && !!rc1.lot?.lotNumber);
  check("…the receiver's copy carries no cost (redacted to null)", r.body.intake.unitCost === null && !JSON.stringify(r.body).includes("7.25"), r.body.intake.unitCost);
  check("…cost from the PO: 145/crate of 20 kg = 7.25/kg", (await intakeOf(rc1.id)).unitCost === "7.25");
  let po = await order(poMarket.id);
  check("PO partially received: 380 good, 20 rejected, 620 left", po.status === "partially_received" && po.lines[0].receivedGood === "380" && po.lines[0].rejected === "20" && po.lines[0].remaining === "620", po.lines[0]);

  check("800 more would exceed 1000 + 10% -> 409", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: lineId, received_kg: 800 })).status === 409);
  r = await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: lineId, entered_qty: 35, entered_uom: "CRATE" });
  check("35 crates (700 kg) — within tolerance -> 201", r.status === 201 && r.body.intake.goodQty === "700", r.body);
  const rc2 = r.body.intake;
  po = await order(poMarket.id);
  check("PO received (1080 of 1000)", po.status === "received" && po.lines[0].remaining === "0", po);
  check("the line drops off the receiving list", !(await call("hossam", "GET", `/api/purchasing/receiving?supplier_id=${market.id}`)).body.lines.some((l: any) => l.lineId === lineId));
  check("a correction past the tolerance -> 409", (await call("hossam", "PATCH", `/api/stock/intakes/${rc2.id}`, { received_kg: 750, reason: TAG, expected_version: rc2.version })).status === 409);
  r = await call("hossam", "PATCH", `/api/stock/intakes/${rc2.id}`, { received_kg: 600, reason: "وزن غلط", expected_version: rc2.version });
  check("corrected down to 600", r.status === 200 && r.body.intake.goodQty === "600", r.body);
  po = await order(poMarket.id);
  check("…the PO goes back to partially received", po.status === "partially_received" && po.lines[0].receivedGood === "980", po.lines[0]);
  r = await call("hossam", "POST", `/api/stock/intakes/${rc1.id}/void`, { reason: "اتسجل على الأمر الغلط", expected_version: rc1.version });
  check("void the first receipt", r.status === 200);
  po = await order(poMarket.id);
  check("…the PO's tally follows (600 good, nothing rejected)", po.status === "partially_received" && po.lines[0].receivedGood === "600" && po.lines[0].rejected === "0", po.lines[0]);
  const audit = (await call("admin", "GET", "/api/audit")).body.logs.filter((l: any) => l.entityId === poMarket.id && l.action === "purchase_order_receipt_status");
  check("receipt status changes are audited", audit.length >= 3, audit.map((l: any) => l.newValue));

  section("6. CONCURRENT RECEIPTS ON ONE LINE");
  const oLineId = (await order(poFarm.id)).lines[0].id;
  const both = await Promise.all([1, 2].map(() => call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: oLineId, received_kg: 200 })));
  const st = both.map((x) => x.status).sort();
  check("two 200 kg receipts race on a 300 kg line (330 ceiling): exactly one wins", st[0] === 201 && st[1] === 409, st);
  check("the rest arrives", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: oLineId, received_kg: 100 })).status === 201);
  check("onion PO fully received", (await order(poFarm.id)).status === "received");
  check("closing needs a reason -> 400", (await call("omar", "POST", `/api/purchasing/orders/${poFarm.id}/close`, {})).status === 400);
  check("close it", (await call("omar", "POST", `/api/purchasing/orders/${poFarm.id}/close`, { reason: "اتسلم بالكامل" })).body.order?.status === "closed");
  check("receiving on a closed PO -> 409", (await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: oLineId, received_kg: 1 })).status === 409);
  check("cancelling a PO with receipts -> 409", (await call("omar", "POST", `/api/purchasing/orders/${poMarket.id}/cancel`, { reason: TAG })).status === 409);
  check("a receipt without a PO still works (walk-in farmer)", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: farm.id, product_id: tomato.id, received_kg: 15 })).status === 201);

  (globalThis as any).__pur2 = { lineId, oLineId, rc2 };
  await bills();
}

async function bills() {
  const { farm, market, tomato, onion } = (globalThis as any).__pur;
  const { rc2 } = (globalThis as any).__pur2;
  const today = todayBiz();

  section("7. SUPPLIER BILLS — THREE-WAY MATCH");
  check("the receiver cannot see bills -> 403", (await call("hossam", "GET", "/api/purchasing/bills")).status === 403);
  check("sales cannot see payables -> 403", (await call("mona", "GET", "/api/purchasing/reports/ap-aging")).status === 403);
  r = await call("omar", "GET", `/api/purchasing/suppliers/${market.id}/billable`);
  const mRcv = r.body.receipts?.find((x: any) => x.intakeId === rc2.id);
  check("billable receipts carry the agreed price: PO 7.25/kg × 600 kg", r.status === 200 && mRcv?.expectedUnitPrice === "7.25" && mRcv?.expectedNet === "4350.00" && mRcv?.priceSource === "po" && mRcv?.poNumber, r.body);
  check("the voided receipt is not billable", !r.body.receipts.some((x: any) => x.goodQty === "380"));
  check("the buyer reads bills but cannot book them -> 403", (await call("omar", "POST", "/api/purchasing/bills", { supplier_id: market.id, supplier_invoice_no: "X", bill_date: today, lines: [{ intake_id: rc2.id, unit_price: "7.25" }] })).status === 403);
  r = await call("karim", "POST", "/api/purchasing/bills", { supplier_id: market.id, supplier_invoice_no: `${TAG}-778`, bill_date: today, lines: [{ intake_id: rc2.id, unit_price: "7.25" }] });
  check("finance books the market's invoice -> 201, matched", r.status === 201 && /^BILL-\d{4}-\d{5}$/.test(r.body.bill.number) && r.body.bill.matchStatus === "matched" && r.body.bill.total === "4350.00" && r.body.bill.status === "draft", r.body);
  const billM = r.body.bill;
  check("…due date from the supplier's terms (cash: same day)", billM.dueDate === today);
  check("the same supplier invoice again (case/spaces ignored) -> 409", (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: market.id, supplier_invoice_no: ` ${TAG.toLowerCase()}-778 `, bill_date: today, lines: [{ intake_id: rc2.id, unit_price: "7.25" }] })).status === 409);
  check("the same receipt on another bill -> 409", (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: market.id, supplier_invoice_no: `${TAG}-779`, bill_date: today, lines: [{ intake_id: rc2.id, unit_price: "7.25" }] })).status === 409);
  check("another supplier's receipt -> 400", (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: farm.id, supplier_invoice_no: `${TAG}-X`, bill_date: today, lines: [{ intake_id: rc2.id, unit_price: "7.25" }] })).status === 400);
  check("the billed receipt can no longer be corrected -> 409", (await call("hossam", "PATCH", `/api/stock/intakes/${rc2.id}`, { received_kg: 590, reason: TAG })).status === 409);
  check("…nor voided -> 409", (await call("hossam", "POST", `/api/stock/intakes/${rc2.id}/void`, { reason: TAG })).status === 409);
  r = await call("karim", "POST", `/api/purchasing/bills/${billM.id}/post`, {});
  check("post: matched bills post at once", r.status === 200 && r.body.bill.status === "posted" && r.body.bill.postedBy && r.body.bill.open === "4350.00", r.body);
  check("a posted bill cannot be edited -> 409", (await call("karim", "PUT", `/api/purchasing/bills/${billM.id}`, { supplier_id: market.id, supplier_invoice_no: `${TAG}-778`, bill_date: today, lines: [{ intake_id: rc2.id, unit_price: "1" }] })).status === 409);
  check("…nor cancelled -> 409", (await call("karim", "POST", `/api/purchasing/bills/${billM.id}/cancel`, { reason: TAG })).status === 409);

  r = await call("karim", "GET", `/api/purchasing/suppliers/${farm.id}/billable`);
  const fr = r.body.receipts;
  const on200 = fr.find((x: any) => x.product.id === onion.id && x.goodQty === "200");
  const on100 = fr.find((x: any) => x.product.id === onion.id && x.goodQty === "100");
  const walkIn = fr.find((x: any) => x.product.id === tomato.id && x.goodQty === "15");
  check("farm: two onion receipts on the PO and a walk-in priced from the agreed list (8.5)", on200?.expectedUnitPrice === "5.9" && on100?.priceSource === "po" && walkIn?.priceSource === "supplier_price" && walkIn?.expectedNet === "127.50", fr);
  r = await call("karim", "POST", "/api/purchasing/bills", { supplier_id: farm.id, supplier_invoice_no: `${TAG}-F1`, bill_date: today, lines: [{ intake_id: on200.intakeId, unit_price: "6.2" }, { intake_id: on100.intakeId, unit_price: "5.9" }, { intake_id: walkIn.intakeId, unit_price: "8.5" }] });
  const billF = r.body.bill;
  check("billed 6.2 on the 200 kg (agreed 5.9): a 5% variance on that line", r.status === 201 && billF.matchStatus === "variance" && billF.variance === "60.00" && billF.lines[0].lineVariance === "60.00", r.body);
  check("…due in 30 days (the farm's terms)", billF.dueDate > today);
  r = await call("karim", "POST", `/api/purchasing/bills/${billF.id}/post`, {});
  check("posting a variance waits for approval", r.body.bill?.status === "pending_approval" && !!r.body.bill?.approvalId, r.body);
  const ap = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === billF.id);
  check("the approval names the difference", ap?.type === "purchasing.bill" && /60\.00/.test(ap?.summary ?? ""), ap);
  check("the accountant who booked it cannot approve its variance -> 403", (await call("karim", "POST", `/api/approvals/${ap.id}/decide`, { decision: "approve" })).status === 403);
  check("editing while it waits -> 409", (await call("karim", "PUT", `/api/purchasing/bills/${billF.id}`, { supplier_id: farm.id, supplier_invoice_no: `${TAG}-F1`, bill_date: today, lines: [{ intake_id: on200.intakeId, unit_price: "5.9" }] })).status === 409);
  check("management rejects it", (await call("admin", "POST", `/api/approvals/${ap.id}/decide`, { decision: "reject", comment: "اتفقنا على 5.9" })).status === 200);
  let bf = (await call("karim", "GET", `/api/purchasing/bills/${billF.id}`)).body.bill;
  check("…back to draft", bf.status === "draft");
  r = await call("karim", "PUT", `/api/purchasing/bills/${billF.id}`, { supplier_id: farm.id, supplier_invoice_no: `${TAG}-F1`, bill_date: today, expected_version: bf.version, lines: [{ intake_id: on200.intakeId, unit_price: "5.95" }, { intake_id: on100.intakeId, unit_price: "5.9" }, { intake_id: walkIn.intakeId, unit_price: "8.5" }] });
  check("the supplier's corrected invoice: 5.95 (10.00 over on 1180 — inside 1%)", r.status === 200 && r.body.bill.matchStatus === "within_tolerance" && r.body.bill.variance === "10.00" && r.body.bill.total === "1907.50", r.body);
  r = await call("karim", "POST", `/api/purchasing/bills/${billF.id}/post`, {});
  check("…posts without approval", r.body.bill?.status === "posted", r.body);

  // A receipt nobody priced: it needs a provisional cost (WS3 ACC-E1 — refused without
  // one); the bill has nothing agreed to match, approval is required, and approving posts it.
  const stranger = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد بدون أسعار` })).body.supplier;
  check("a receipt with no price of any kind -> 400 (a provisional cost is required)", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: stranger.id, product_id: onion.id, received_kg: 50 })).status === 400);
  const sr = (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: stranger.id, product_id: onion.id, received_kg: 50, provisional_unit_cost: "6" })).body.intake;
  r = await call("karim", "POST", "/api/purchasing/bills", { supplier_id: stranger.id, supplier_invoice_no: "1", bill_date: today, lines: [{ intake_id: sr.id, unit_price: "6" }] });
  check("nothing agreed to match against: unpriced", r.body.bill?.matchStatus === "unpriced" && r.body.bill.lines[0].expectedUnitPrice === null, r.body);
  const billS = r.body.bill;
  check("cancel a draft (with a reason)", (await call("karim", "POST", `/api/purchasing/bills/${billS.id}/cancel`, { reason: "اتسجلت غلط" })).body.bill?.status === "cancelled");
  r = await call("karim", "POST", "/api/purchasing/bills", { supplier_id: stranger.id, supplier_invoice_no: "1", bill_date: today, lines: [{ intake_id: sr.id, unit_price: "6" }] });
  check("…its receipt and invoice number are free again", r.status === 201, r.body);
  const billS2 = r.body.bill;
  check("post: waits for approval", (await call("karim", "POST", `/api/purchasing/bills/${billS2.id}/post`, {})).body.bill?.status === "pending_approval");
  const ap2 = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === billS2.id);
  check("management accepts the price", (await call("admin", "POST", `/api/approvals/${ap2.id}/decide`, { decision: "approve", comment: "سعر السوق النهارده" })).status === 200);
  const s2 = (await call("karim", "GET", `/api/purchasing/bills/${billS2.id}`)).body.bill;
  check("…posted, attributed to the approver", s2.status === "posted" && s2.approvedBy && s2.postedBy === s2.approvedBy, s2);

  section("8. DEBIT NOTES AND PAYABLES");
  const mLine = (await call("karim", "GET", `/api/purchasing/bills/${billM.id}`)).body.bill.lines[0];
  check("debit more than billed -> 400", (await call("karim", "POST", `/api/purchasing/bills/${billM.id}/debit-notes`, { reason: "مرتجع", lines: [{ bill_line_id: mLine.id, quantity: 601 }] })).status === 400);
  check("debit note needs a reason -> 400", (await call("karim", "POST", `/api/purchasing/bills/${billM.id}/debit-notes`, { lines: [{ bill_line_id: mLine.id, quantity: 1 }] })).status === 400);
  check("an unknown return document -> 400", (await call("karim", "POST", `/api/purchasing/bills/${billM.id}/debit-notes`, { reason: "x", return_document_id: "nope", lines: [{ bill_line_id: mLine.id, quantity: 1 }] })).status === 400);
  r = await call("karim", "POST", `/api/purchasing/bills/${billM.id}/debit-notes`, { reason: "100 كجم رجعت تالفة", lines: [{ bill_line_id: mLine.id, quantity: 100 }] });
  check("debit 100 kg × 7.25 = 725.00", r.status === 201 && /^DN-\d{4}-\d{5}$/.test(r.body.debitNote.number) && r.body.debitNote.total === "725" && r.body.bill.open === "3625.00", r.body);
  r = await call("karim", "POST", `/api/purchasing/bills/${billM.id}/debit-notes`, { reason: "اتفاق على خصم الباقي", full: true });
  check("the rest in full: exactly 3625.00, nothing left", r.status === 201 && r.body.bill.open === "0.00", r.body.bill);
  check("nothing left to debit -> 409", (await call("karim", "POST", `/api/purchasing/bills/${billM.id}/debit-notes`, { reason: "x", full: true })).status === 409);
  check("debit notes on a draft are refused -> 409", (await call("karim", "POST", `/api/purchasing/bills/${billS.id}/debit-notes`, { reason: "x", full: true })).status === 409);
  const fLine = (await call("karim", "GET", `/api/purchasing/bills/${billF.id}`)).body.bill.lines[0];
  check("farm: debit 150 kg onion at the billed 5.95", (await call("karim", "POST", `/api/purchasing/bills/${billF.id}/debit-notes`, { reason: "فرز بعد الاستلام", lines: [{ bill_line_id: fLine.id, quantity: 150 }] })).body.debitNote?.total === "892.5");

  r = await call("karim", "GET", `/api/purchasing/suppliers/${farm.id}/statement?from=2026-01-01&to=2099-12-31`);
  const st = r.body.statement;
  check("farm statement: bill 1907.50 then debit 892.50, owed 1015.00", r.status === 200 && st.rows.length === 2 && st.rows[0].credit === "1907.50" && st.rows[1].debit === "892.50" && st.closing === "1015.00" && r.body.payable === "1015.00", r.body);
  check("market owed nothing after its debit notes", (await call("karim", "GET", `/api/purchasing/suppliers/${market.id}/statement`)).body.payable === "0.00");
  const aging = (await call("karim", "GET", "/api/purchasing/reports/ap-aging")).body.aging;
  const fa = aging.rows.find((x: any) => x.supplier.id === farm.id);
  check("AP aging: the farm's 1015.00 is not due yet", fa?.total === "1015.00" && fa?.current === "1015.00", fa);
  check("…a fully debited bill is not in the aging", !aging.rows.some((x: any) => x.supplier.id === market.id));
  const late = (await call("karim", "GET", "/api/purchasing/reports/ap-aging?as_of=2099-01-01")).body.aging.rows.find((x: any) => x.supplier.id === farm.id);
  check("…and far in the future it is 90+ days overdue", late?.d90_plus === "1015.00", late);
  check("the buyer reads payables (read-only)", (await call("omar", "GET", "/api/purchasing/reports/ap-aging")).status === 200);
  const auditRows = async (u: string) => (await call(u, "GET", "/api/audit")).body.logs?.filter((l: any) => l.entityType === "supplier_bill" || l.entityType === "debit_note") ?? [];
  check("bill and debit-note events are audited", (await auditRows("admin")).length >= 5);
  check("…and hidden from an auditor without access to payables", (await auditRows("sara")).length === 0);
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
