/* WS3 (remediation 2026-11) ACC-E1 — receipts at a PROVISIONAL cost, revalued by the bill.
     receive 100 kg at a provisional 10 → sell 40 → bill at 12:
       COGS of the 40 = 480 (400 at issue + 80 when the bill posts), the 60 left = 720,
       PPV 0, GRNI cleared, the inventory account = the valuation layers, TB balanced;
     a bill LOWER than the provisional cost (9) takes cost off the same way;
     a debit note without goods (an allowance) lowers the receipt's cost — half, then the
       rest: a debit note for the whole line takes the bill's revaluation back exactly;
     goods returned after the bill leave at the billed cost (no price variance);
     legacy receipts at an UNKNOWN cost (from before this rule) bill exactly as before;
     receipts without any cost are refused; reports flag provisional stock until billed.
   GL movements are read by system key with raw SQL (as tests/business-cycle.test.ts does). */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";
import { taxNo } from "./_stock";

const TAG = `ZZPROV${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const n = (v: unknown) => Number(v ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const eq = (a: number, b: number) => Math.abs(a - b) < 0.005;

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"]) await login(u);
  const today = todayBiz();
  const KEYS = ["inventory", "grni", "cogs", "ppv", "inventory_adjustment", "ap", "vat_input"] as const;
  const glKey = async (key: string) => { const [x] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${key}`; return n(x?.b); };
  type Snap = Record<string, number>;
  const snap = async (): Promise<Snap> => { const s: Snap = {}; for (const k of KEYS) s[k] = await glKey(k); return s; };
  const d = (a: Snap, b: Snap, k: string) => r2(b[k] - a[k]);
  const moved = (a: Snap, b: Snap, expect: Record<string, number>) => {
    const bad: string[] = [];
    for (const k of KEYS) { const want = expect[k] ?? 0; if (!eq(d(a, b, k), want)) bad.push(`${k}: ${d(a, b, k)} ≠ ${want}`); }
    return bad;
  };
  const approve = async (entityId: string) => { const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === entityId); return a ? call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version }) : null; };
  const productValue = async (pid: string) => { const [x] = await db.$queryRaw<{ q: Prisma.Decimal | null; v: Prisma.Decimal | null }[]>`SELECT sum("quantity") AS q, sum("value") AS v FROM "StockValuationLayer" WHERE "productId" = ${pid}`; return { qty: n(x?.q), value: r2(n(x?.v)) }; };
  const valRow = async (pid: string) => (await call("karim", "GET", "/api/inventory/reports/valuation")).body.rows.find((r: any) => r.productId === pid);
  const finRow = async (name: string) => (await call("karim", "GET", `/api/management/finance?from=${today}&to=${today}`)).body.report.sales.byProduct.find((x: any) => x.product.includes(name));
  const cogsOf = async (pid: string) => {
    const [x] = await db.$queryRaw<{ c: Prisma.Decimal | null }[]>`
      SELECT coalesce((SELECT -sum(v."value") FROM "StockValuationLayer" v JOIN "StockMovement" m ON m."id" = v."movementId" WHERE v."productId" = ${pid} AND m."kind" IN ('issue', 'customer_return')), 0)
           + coalesce((SELECT sum("cogsDelta") FROM "StockRevaluation" WHERE "productId" = ${pid}), 0) AS c`;
    return r2(n(x?.c));
  };
  const integrity = async () => (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  const tbBalanced = async () => { const [x] = await db.$queryRaw<{ dr: Prisma.Decimal; cr: Prisma.Decimal }[]>`SELECT sum("debit") AS dr, sum("credit") AS cr FROM "JournalLine"`; return eq(n(x.dr), n(x.cr)); };

  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} مزرعة بسعر مؤقت` })).body.supplier;
  // A buyer tax identity is needed to issue the invoice (MIG-01).
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} عميل`, tax_registration_no: taxNo() })).body.customer;
  const product = async (label: string) => (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} ${label}`, unit: "KG" })).body.product;
  check("supplier and customer", !!supplier?.id && !!customer?.id, [supplier, customer]);

  /** Order → prepare → load → dispatch → invoice for `qty` kg at `price`. */
  const sell = async (p: any, qty: number, price: string) => {
    const o = (await call("mona", "POST", "/api/orders", { customer_account_id: customer.id, customer_name: customer.name, delivery_date: today, items: [{ stock_product_id: p.id, product_name: p.name, quantity: qty }] })).body.order;
    await call("mona", "PATCH", `/api/orders/${o.id}/items/${o.items[0].id}/price`, { unit_price: price, reason: "قائمة" });
    await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "preparing" });
    await call("ahmed", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/prepare`, { quantity: qty, mark_done: true });
    await call("ahmed", "POST", `/api/orders/${o.id}/status`, { to: "ready_for_loading" });
    await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loading" });
    await call("mostafa", "POST", `/api/orders/${o.id}/items/${o.items[0].id}/load`, { quantity: qty, mark_done: true });
    await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "loaded" });
    const disp = await call("mostafa", "POST", `/api/orders/${o.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 });
    const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: o.id })).body.invoice;
    if (inv) await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
    return disp.status;
  };
  const receive = (p: any, body: Record<string, unknown>) => call("hossam", "POST", "/api/stock/intakes", { supplier_id: supplier.id, product_id: p.id, received_date: today, received_kg: 100, ...body });
  /** Books the bill and posts it (an unpriced bill is approved by someone other than the clerk). */
  const billAt = async (intakeId: string, price: string, no: string) => {
    const b = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: supplier.id, supplier_invoice_no: `${TAG}-${no}`, bill_date: today, lines: [{ intake_id: intakeId, unit_price: price }] })).body.bill;
    const posted = await call("karim", "POST", `/api/purchasing/bills/${b.id}/post`, {});
    if (posted.body?.bill?.status === "pending_approval") await approve(b.id);
    return (await call("karim", "GET", `/api/purchasing/bills/${b.id}`)).body.bill;
  };

  section("1. A RECEIPT NEVER ENTERS STOCK WITHOUT A COST");
  const tomato = await product("طماطم");
  let r = await receive(tomato, {});
  check("no PO, no unit cost, no supplier price, no provisional cost -> 400", r.status === 400 && /سعر مؤقت/.test(r.body?.error ?? JSON.stringify(r.body)), [r.status, r.body]);
  check("a provisional cost of 0 -> 400", (await receive(tomato, { provisional_unit_cost: "0" })).status === 400);
  check("an agreed unit cost AND a provisional cost -> 400", (await receive(tomato, { unit_cost: "10", provisional_unit_cost: "10" })).status === 400);
  check("nothing was recorded by the refused attempts", (await productValue(tomato.id)).qty === 0);

  section("2. RECEIVE 100 kg AT A PROVISIONAL 10");
  let s0 = await snap();
  const beforeReceipt = s0;
  r = await receive(tomato, { provisional_unit_cost: "10" });
  const intake = r.body.intake;
  check("201, the receipt says its cost is provisional", r.status === 201 && intake?.costProvisional === true, [r.status, intake?.costProvisional]);
  const layer = await db.stockValuationLayer.findFirst({ where: { productId: tomato.id, movement: { intakeId: intake.id } } });
  check("valuation layer: costSource 'provisional', 100 × 10 = 1000", layer?.costSource === "provisional" && n(layer?.value) === 1000, layer);
  let s1 = await snap();
  check("GL: Inventory +1000 / GRNI −1000", moved(s0, s1, { inventory: 1000, grni: -1000 }).length === 0, moved(s0, s1, { inventory: 1000, grni: -1000 }));
  let vr = await valRow(tomato.id);
  check("valuation report flags it: provisionalQty 100, provisionalValue 1000", n(vr?.provisionalQty) === 100 && n(vr?.provisionalValue) === 1000, vr);
  const list = (await call("karim", "GET", "/api/inventory/reports/provisional")).body.receipts;
  check("the provisional-receipts list carries it (no bill yet)", list.some((x: any) => x.intakeId === intake.id && n(x.onHandQty) === 100 && x.billNumber === null), list?.slice?.(0, 3));
  check("the receiver cannot read that list (stock.valuation.view) -> 403", (await call("mona", "GET", "/api/inventory/reports/provisional")).status === 403);

  section("3. SELL 40 kg BEFORE THE BILL");
  s0 = await snap();
  check("dispatched", (await sell(tomato, 40, "20")) === 200);
  s1 = await snap();
  check("COGS +400 (40 × provisional 10), Inventory −400", moved(s0, s1, { inventory: -400, cogs: 400 }).length === 0, moved(s0, s1, { inventory: -400, cogs: 400 }));
  let fr = await finRow(`${TAG} طماطم`);
  check("finance report flags the 40 kg sold at a provisional cost", !!fr && n(fr.costProvisionalQty) === 40, fr);
  const integ0 = await integrity();
  check("integrity lists the receipt as provisional (informational)", (integ0.checks.find((c: any) => c.key === "provisional_cost_pending")?.count ?? 0) >= 1, integ0.checks.find((c: any) => c.key === "provisional_cost_pending"));

  section("4. THE BILL ARRIVES AT 12 — REVALUE, DON'T CALL IT A PRICE VARIANCE");
  s0 = await snap();
  const bill = await billAt(intake.id, "12", "B1");
  s1 = await snap();
  check("bill posted (unpriced → approved by another user)", bill?.status === "posted" && bill?.matchStatus === "unpriced", [bill?.status, bill?.matchStatus]);
  const expectBill = { inventory: 120, cogs: 80, grni: 1000, ap: -1200 };
  check("GL: Inventory +120 (60 on hand × 2), COGS +80 (40 sold × 2), GRNI +1000 (the receipt's credit cleared), PPV 0, AP −1200", moved(s0, s1, expectBill).length === 0, moved(s0, s1, expectBill));
  const whole = { inventory: 720, cogs: 480, ap: -1200 };
  check("receipt → sale → bill, end to end: Inventory 720, COGS 480, GRNI 0, PPV 0, AP −1200", moved(beforeReceipt, s1, whole).length === 0, moved(beforeReceipt, s1, whole));
  check("COGS of the 40 sold = 480 in total", (await cogsOf(tomato.id)) === 480, await cogsOf(tomato.id));
  let pv = await productValue(tomato.id);
  check("the 60 kg left are valued 720 (12/kg)", pv.qty === 60 && pv.value === 720, pv);
  vr = await valRow(tomato.id);
  check("valuation report = 60 kg / 720, nothing provisional any more", n(vr?.quantity) === 60 && n(vr?.value) === 720 && n(vr?.provisionalQty) === 0, vr);
  const rows = bill.revaluations ?? [];
  check("one revaluation row: Δ 200 = inventory 120 + COGS 80, PPV 0, basis 100, on hand 60", rows.length === 1 && n(rows[0].delta) === 200 && n(rows[0].inventory) === 120 && n(rows[0].cogs) === 80 && n(rows[0].ppv) === 0 && n(rows[0].basisQty) === 100 && n(rows[0].onHandQty) === 60, rows);
  const pair = await db.stockMovement.findMany({ where: { intakeId: intake.id, kind: { in: ["revaluation_out", "revaluation_in"] } } });
  check("the stock ledger carries the revaluation as an out/in pair (net 0 kg) linked to the row", pair.length === 2 && pair.reduce((s, m) => s + n(m.quantity), 0) === 0 && pair.every((m) => m.revaluationId === rows[0]?.id), pair.map((m) => [m.kind, String(m.quantity), m.revaluationId]));
  const lot = await db.stockLot.findUnique({ where: { id: intake.lot?.id ?? intake.lotId } });
  check("the lot now costs what was billed (12)", n(lot?.unitCost) === 12, lot?.unitCost);
  const je = (await call("karim", "GET", "/api/accounting/journals?source_type=supplier_bill")).body.journals.filter((j: any) => j.description.includes(bill.number));
  const jd = je[0] ? (await call("karim", "GET", `/api/accounting/journals/${je[0].id}`)).body.journal : null;
  const lineOf = (code: string) => jd?.lines.filter((l: any) => l.account.code === code).reduce((s: number, l: any) => s + n(l.debit) - n(l.credit), 0) ?? 0;
  check("bill entry: Dr GRNI 1120 (1000 provisional + 120 revalued), Dr COGS 80, no PPV line, Cr AP 1200", je.length === 1 && eq(lineOf("2150"), 1120) && eq(lineOf("5100"), 80) && eq(lineOf("5300"), 0) && eq(lineOf("2100"), -1200), jd?.lines?.map((l: any) => [l.account.code, l.debit, l.credit]));
  fr = await finRow(`${TAG} طماطم`);
  check("finance report: cost of the 40 = 480, margin 800 − 480 = 320, nothing provisional", !!fr && n(fr.cost) === 480 && n(fr.margin) === 320 && n(fr.costProvisionalQty) === 0, fr);
  let integ = await integrity();
  check("integrity green: inventory account = valuation layers, GRNI, AP, TB, traceability", integ.ok === true, integ.checks.filter((c: any) => !c.ok));
  check("trial balance balanced", await tbBalanced());
  check("the bill cannot be posted twice -> 409", (await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {})).status === 409);

  section("5. SELLING AFTER THE BILL USES THE BILLED COST");
  s0 = await snap();
  check("dispatched 10 kg", (await sell(tomato, 10, "20")) === 200);
  s1 = await snap();
  check("COGS +120 (10 × 12)", moved(s0, s1, { inventory: -120, cogs: 120 }).length === 0, moved(s0, s1, { inventory: -120, cogs: 120 }));

  section("6. A BILL LOWER THAN THE PROVISIONAL COST (9)");
  const cucumber = await product("خيار");
  const i2 = (await receive(cucumber, { provisional_unit_cost: "10" })).body.intake;
  await sell(cucumber, 40, "15");
  s0 = await snap();
  const bill2 = await billAt(i2.id, "9", "B2");
  s1 = await snap();
  check("bill posted", bill2?.status === "posted", bill2?.status);
  check("GL: Inventory −60, COGS −40, GRNI +1000 (cleared), PPV 0, AP −900", moved(s0, s1, { inventory: -60, cogs: -40, grni: 1000, ap: -900 }).length === 0, moved(s0, s1, { inventory: -60, cogs: -40, grni: 1000, ap: -900 }));
  check("COGS of the 40 sold = 360", (await cogsOf(cucumber.id)) === 360, await cogsOf(cucumber.id));
  pv = await productValue(cucumber.id);
  check("the 60 kg left are valued 540 (9/kg)", pv.qty === 60 && pv.value === 540, pv);

  section("7. DEBIT NOTES: AN ALLOWANCE LOWERS THE COST; THE WHOLE LINE TAKES THE REVALUATION BACK");
  const pepper = await product("فلفل");
  const i3 = (await receive(pepper, { provisional_unit_cost: "10" })).body.intake;
  await sell(pepper, 40, "18");
  const bill3 = await billAt(i3.id, "12", "B3");
  const line3 = bill3.lines[0];
  check("bill at 12 posted: 40 sold at 480, 60 left at 720", bill3?.status === "posted" && (await cogsOf(pepper.id)) === 480 && (await productValue(pepper.id)).value === 720, [bill3?.status, await cogsOf(pepper.id), await productValue(pepper.id)]);
  s0 = await snap();
  r = await call("karim", "POST", `/api/purchasing/bills/${bill3.id}/debit-notes`, { reason: `${TAG} خصم نص الكمية`, lines: [{ bill_line_id: line3.id, quantity: 50 }] });
  s1 = await snap();
  check("allowance for 50 kg (600) issued", r.status === 201 || r.status === 200, [r.status, r.body]);
  check("GL: AP +600, Inventory −360 (60 × 6), COGS −240 (40 × 6), PPV 0", moved(s0, s1, { ap: 600, inventory: -360, cogs: -240 }).length === 0, moved(s0, s1, { ap: 600, inventory: -360, cogs: -240 }));
  check("the receipt now costs 6/kg: 40 sold at 240, 60 left at 360", (await cogsOf(pepper.id)) === 240 && (await productValue(pepper.id)).value === 360, [await cogsOf(pepper.id), await productValue(pepper.id)]);
  s0 = await snap();
  r = await call("karim", "POST", `/api/purchasing/bills/${bill3.id}/debit-notes`, { reason: `${TAG} إلغاء باقي الفاتورة`, full: true });
  s1 = await snap();
  check("the rest of the line debited (600)", r.status === 201 || r.status === 200, [r.status, r.body]);
  check("GL: AP +600, Inventory −360, COGS −240, PPV 0", moved(s0, s1, { ap: 600, inventory: -360, cogs: -240 }).length === 0, moved(s0, s1, { ap: 600, inventory: -360, cogs: -240 }));
  const revs = await db.stockRevaluation.findMany({ where: { billLineId: line3.id }, orderBy: { createdAt: "asc" } });
  const billRow = revs.find((x) => x.sourceType === "supplier_bill")!;
  const dnRows = revs.filter((x) => x.sourceType === "debit_note");
  const sum = (k: "delta" | "inventoryDelta" | "cogsDelta" | "ppvDelta") => r2(revs.reduce((s, x) => s + n(x[k]), 0));
  check("each debit-note row points at the bill's row it reverses", dnRows.length === 2 && dnRows.every((x) => x.reversalOfId === billRow.id), dnRows.map((x) => x.reversalOfId));
  check("bill + debit notes for the whole line = −provisional value (the bill's +200 taken back exactly, with the 1000 base)", sum("delta") === -1000 && sum("inventoryDelta") === -600 && sum("cogsDelta") === -400 && sum("ppvDelta") === 0, { delta: sum("delta"), inv: sum("inventoryDelta"), cogs: sum("cogsDelta"), ppv: sum("ppvDelta") });
  check("nothing billed net: the 60 kg left carry 0, the 40 sold cost 0, AP for the bill is 0", (await productValue(pepper.id)).value === 0 && (await cogsOf(pepper.id)) === 0, [await productValue(pepper.id), await cogsOf(pepper.id)]);
  const supSt = (await call("karim", "GET", `/api/purchasing/suppliers/${supplier.id}/statement?from=2000-01-01&to=2099-12-31`)).body;
  check("supplier statement still reconciles to the GL (integrity AP)", (await integrity()).checks.find((c: any) => c.key === "ap")?.ok === true, supSt?.payable);

  section("8. GOODS RETURNED AFTER THE BILL LEAVE AT THE BILLED COST");
  const onion = await product("بصل");
  const i4 = (await receive(onion, { provisional_unit_cost: "10" })).body.intake;
  const bill4 = await billAt(i4.id, "11", "B4");
  check("bill at 11 posted, nothing sold: Inventory 1100", bill4?.status === "posted" && (await productValue(onion.id)).value === 1100, await productValue(onion.id));
  s0 = await snap();
  r = await call("karim", "POST", `/api/purchasing/bills/${bill4.id}/debit-notes`, { reason: `${TAG} مرتجع تالف`, return_goods: true, lines: [{ bill_line_id: bill4.lines[0].id, quantity: 10 }] });
  s1 = await snap();
  check("return of 10 kg with its debit note", r.status === 201 || r.status === 200, [r.status, r.body]);
  check("GL: Inventory −110, AP +110, GRNI 0 net, PPV 0", moved(s0, s1, { inventory: -110, ap: 110 }).length === 0, moved(s0, s1, { inventory: -110, ap: 110 }));
  check("90 kg left at 990", (await productValue(onion.id)).qty === 90 && (await productValue(onion.id)).value === 990, await productValue(onion.id));

  section("9. LEGACY RECEIPTS AT AN UNKNOWN COST STILL BILL AS BEFORE (history not rewritten)");
  const legacy = await product("قديم");
  const any = await db.stockIntake.findFirstOrThrow({ where: { id: intake.id } });
  const lotL = await db.stockLot.create({ data: { productId: legacy.id, lotNumber: `${TAG}-L1`, receivedDate: today, supplierId: supplier.id, unitCost: null } });
  const iL = await db.stockIntake.create({ data: { receiptNumber: `${TAG}-RC-LEGACY`, receivedDate: today, supplierId: supplier.id, productId: legacy.id, receivedQty: 50, goodQty: 50, warehouseId: any.warehouseId, locationId: any.locationId, lotId: lotL.id, recordedBy: "legacy import" } });
  const mL = await db.stockMovement.create({ data: { productId: legacy.id, warehouseId: any.warehouseId, locationId: any.locationId, lotId: lotL.id, effectiveDate: today, kind: "intake", quantity: 50, intakeId: iL.id, unitCost: 0, actorName: "legacy import" } });
  await db.stockValuationLayer.create({ data: { movementId: mL.id, productId: legacy.id, quantity: 50, unitCost: 0, value: 0, remainingQty: 50, costSource: "unknown" } });
  await db.stockValuationPosting.create({ data: { movementId: mL.id, entryId: null } });
  vr = await valRow(legacy.id);
  check("valuation report still reports the unknown-cost quantity (50)", n(vr?.receivedWithoutCost) === 50, vr);
  s0 = await snap();
  const billL = await billAt(iL.id, "8", "BL");
  s1 = await snap();
  check("legacy bill posts as before: Dr PPV 400 / Cr AP 400, GRNI 0, no revaluation", billL?.status === "posted" && moved(s0, s1, { ppv: 400, ap: -400 }).length === 0 && (billL.revaluations ?? []).length === 0, [billL?.status, moved(s0, s1, { ppv: 400, ap: -400 }), billL?.revaluations]);
  check("the unknown layer is untouched", (await db.stockValuationLayer.findUnique({ where: { movementId: mL.id } }))?.costSource === "unknown");

  section("10. THE BOOKS");
  integ = await integrity();
  check("integrity green after all of the above (inventory = layers, GRNI, AP, TB, traceability)", integ.ok === true, integ.checks.filter((c: any) => !c.ok));
  check("trial balance balanced", await tbBalanced());
  const [gl] = await db.$queryRaw<{ gl: Prisma.Decimal; layers: Prisma.Decimal }[]>`
    SELECT (SELECT coalesce(sum(l."debit" - l."credit"), 0) FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = 'inventory') AS gl,
           (SELECT coalesce(sum("value"), 0) FROM "StockValuationLayer") AS layers`;
  const total = n((await call("karim", "GET", "/api/inventory/reports/valuation")).body.totalValue);
  check(`GL 1400 (inventory) = valuation report total (${total.toFixed(2)}) within piastre rounding`, Math.abs(n(gl.gl) - total) < 0.05 && Math.abs(n(gl.layers) - total) < 0.01, [n(gl.gl), n(gl.layers), total]);
  await db.$disconnect();
}

main().then(() => finish("PROVISIONAL-COST")).catch((e) => { console.error(e); process.exit(1); });
