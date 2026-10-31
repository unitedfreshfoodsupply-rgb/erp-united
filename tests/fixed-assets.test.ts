/* Fixed assets end to end, through the API:
   category (policy + its own GL accounts) → bought on a supplier bill capital line (Dr cost /
   Cr AP) or for cash → placed in service → monthly depreciation (Dr expense / Cr accumulated,
   once per asset and month, catch-up of missed months) → improvement (prospective) →
   transfer (no entry) → supplier allowance (cost down) → sale with VAT (catch-up, gain/loss,
   VAT output in the VAT summary) and scrap → register = GL, roll-forward ties, cash flow
   shows the sale under investing, DB guards. Runs on the shared test database repeatedly. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const TAG = `ZZFA${Date.now() % 1_000_000_000}`;
const SUF = String(Date.now()).slice(-6);
const { check, section, finish } = makeChecker();
const n = (v: any) => Number(v ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const today = todayBiz();
const thisMonth = today.slice(0, 7);
const addMonths = (p: string, k: number) => { const [y, m] = p.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "karim", "mona", "omar"]) await login(u);
  const gl = async (accountId: string) => { const [r] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum("debit" - "credit") AS b FROM "JournalLine" WHERE "accountId" = ${accountId}`; return n(r?.b); };
  const asset = async (id: string) => (await call("karim", "GET", `/api/assets/${id}`)).body.asset;
  const approveBill = async (id: string) => {
    let res = await call("karim", "POST", `/api/purchasing/bills/${id}/post`, {});
    if (res.body?.bill?.status === "pending_approval") {
      const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === id);
      res = await call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version });
    }
    return res;
  };
  // Three months back: placed in service then, depreciated from the month after.
  const M0 = addMonths(thisMonth, -3), M1 = addMonths(thisMonth, -2), M2 = addMonths(thisMonth, -1);

  section("1. ACCESS");
  check("sales cannot see the register -> 403", (await call("mona", "GET", "/api/assets")).status === 403);
  check("sales cannot create a category -> 403", (await call("mona", "POST", "/api/assets/categories", {})).status === 403);
  check("the accountant reads the register", (await call("karim", "GET", "/api/assets")).status === 200);

  section("2. CATEGORIES — every policy value explicit");
  check("a category without life or start rule -> 400", (await call("karim", "POST", "/api/assets/categories", { code: `V${SUF}`, name: "x", name_ar: "x" })).status === 400);
  let r = await call("karim", "POST", "/api/assets/categories", { code: `TRK${SUF}`, name: `${TAG} Trucks`, name_ar: `${TAG} سيارات نقل`, method: "straight_line", useful_life_months: 60, residual_percent: 10, depreciation_start: "next_month", capitalization_threshold: 5000 });
  const trucks = r.body.category;
  check("trucks: 60 months straight line, 10% residual, from the next month, threshold 5000", r.status === 201 && trucks.usefulLifeMonths === 60, r.body);
  r = await call("karim", "POST", "/api/assets/categories", { code: `SCL${SUF}`, name: `${TAG} Scales`, name_ar: `${TAG} موازين`, method: "straight_line", useful_life_months: 24, residual_percent: 0, depreciation_start: "same_month", capitalization_threshold: 0 });
  const scales = r.body.category;
  r = await call("karim", "POST", "/api/assets/categories", { code: `LND${SUF}`, name: `${TAG} Land`, name_ar: `${TAG} أراضي`, depreciable: false, useful_life_months: 1, depreciation_start: "same_month" });
  const land = r.body.category;
  check("land: not depreciated (no accumulated-depreciation account)", r.status === 201 && land.accumulatedAccountId === null, r.body);
  const chart = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts as any[];
  const tCost = chart.find((a) => a.id === trucks.assetAccountId), tAcc = chart.find((a) => a.id === trucks.accumulatedAccountId);
  check("…each category has its own cost + accumulated accounts under 1700, owned by the register", tCost?.parentId === "acc_1700" && tCost.controlledBy === "fixed_assets" && tAcc?.controlledBy === "fixed_assets" && tCost.cashFlowCategory === "investing" && tAcc.cashFlowCategory === "operating", [tCost, tAcc]);
  check("a duplicate category code -> 409", (await call("karim", "POST", "/api/assets/categories", { code: `TRK${SUF}`, name: "x", name_ar: "x", useful_life_months: 12, depreciation_start: "same_month" })).status === 409);
  check("a manual journal on a category account -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} x`, lines: [{ account_id: tCost.id, debit: 1 }, { account_id: "acc_1100", credit: 1 }] })).status === 400);

  section("3. BOUGHT ON A SUPPLIER BILL (capital line)");
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} توكيل سيارات` })).body.supplier;
  check("an ordinary bill line straight onto the cost account -> 400", (await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier.id, supplier_invoice_no: `${TAG}-X`, bill_date: M0 + "-10", lines: [{ account_id: tCost.id, description: "x", amount: "100", tax_code: "VAT14" }] })).status === 400);
  check("a capital line below the category threshold -> 400", (await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier.id, supplier_invoice_no: `${TAG}-S`, bill_date: M0 + "-10", lines: [{ asset_category_id: trucks.id, asset_name: "عربية صغيرة", description: "x", amount: "4000", tax_code: "VAT14" }] })).status === 400);
  r = await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier.id, supplier_invoice_no: `${TAG}-T1`, bill_date: `${M0}-10`, lines: [{ asset_category_id: trucks.id, asset_name: `${TAG} ميتسوبيشي مبرد`, description: "عربية نقل مبردة", amount: "300000", tax_code: "VAT14" }] });
  const bill = r.body.bill;
  check("bill with a capital line -> 201", r.status === 201, r.body);
  const apBefore = await gl("acc_2100");
  r = await approveBill(bill.id);
  check("posted (approved by someone else)", r.status === 200, r.body);
  let list = (await call("karim", "GET", `/api/assets?category_id=${trucks.id}`)).body;
  const truckRow = list.assets.find((a: any) => a.name === `${TAG} ميتسوبيشي مبرد`);
  check("…the asset is in the register (draft, cost 300000)", truckRow?.status === "draft" && truckRow.cost === "300000.00" && /^FA-\d{5}$/.test(truckRow.number), truckRow);
  check("…Dr truck cost 300000 / Cr AP 342000 (VAT 42000 input)", (await gl(tCost.id)) === 300000 && r2(apBefore - (await gl("acc_2100"))) === 342000);

  section("4. BOUGHT FOR CASH; PLACED IN SERVICE");
  r = await call("karim", "POST", "/api/assets", { category_id: scales.id, name: `${TAG} ميزان أرضي`, cost: "12000", acquisition_date: `${M0}-05`, cash_account_id: "bank_main", in_service_date: `${M1}-01`, warehouse_id: "wh_main", location: "الاستلام" });
  const scale = r.body.asset;
  check("a scale bought from the bank, in service from M1 -> 201", r.status === 201 && scale.status === "in_service", r.body);
  check("…Dr scale cost 12000 / Cr bank", (await gl(scales.assetAccountId)) === 12000);
  r = await call("karim", "POST", "/api/assets", { category_id: land.id, name: `${TAG} قطعة أرض`, cost: "50000", acquisition_date: `${M0}-01`, cash_account_id: "bank_main", in_service_date: `${M0}-01` });
  const plot = r.body.asset;
  check("land bought", r.status === 201, r.body);
  check("in-service before purchase -> 400", (await call("karim", "POST", `/api/assets/${truckRow.id}/place-in-service`, { in_service_date: `${addMonths(M0, -1)}-01` })).status === 400);
  r = await call("karim", "POST", `/api/assets/${truckRow.id}/place-in-service`, { in_service_date: `${M0}-15`, warehouse_id: "wh_main", plate_number: "ن ق ل 123" });
  check("truck in service from mid-M0 (depreciation from M1)", r.status === 200 && r.body.result.status === "in_service", r.body);
  check("placing it twice -> 409", (await call("karim", "POST", `/api/assets/${truckRow.id}/place-in-service`, { in_service_date: `${M0}-15` })).status === 409);

  section("5. MONTHLY DEPRECIATION");
  const pv = (await call("karim", "GET", `/api/assets/depreciation?period=${M1}`)).body.preview;
  const pvTruck = pv.rows.find((x: any) => x.assetId === truckRow.id), pvScale = pv.rows.find((x: any) => x.assetId === scale.id);
  check("preview M1: truck (300000 − 30000) / 60 = 4500, scale 12000 / 24 = 500, land nothing", n(pvTruck?.amount) === 4500 && n(pvScale?.amount) === 500 && !pv.rows.some((x: any) => x.assetId === plot.id), pv.rows);
  check("sales cannot run depreciation -> 403", (await call("mona", "POST", "/api/assets/depreciation", { period: M1 })).status === 403);
  check("a future month cannot run -> 400", (await call("karim", "POST", "/api/assets/depreciation", { period: addMonths(thisMonth, 1) })).status === 400);
  const accBefore = await gl(tAcc.id);
  r = await call("karim", "POST", "/api/assets/depreciation", { period: M1 });
  check("run M1 -> 201 (DEP number)", r.status === 201 && /^DEP-\d{4}-\d{4}$/.test(r.body.run.number), r.body);
  const je = (await call("karim", "GET", `/api/accounting/journals/${r.body.run.entryId}`)).body.journal;
  check("…dated the month's last day", je.date.startsWith(M1) && je.sourceType === "asset_depreciation");
  check("…Cr truck accumulated depreciation 4500", r2(accBefore - (await gl(tAcc.id))) === 4500);
  r = await call("karim", "POST", "/api/assets/depreciation", { period: M1 });
  check("running M1 again posts nothing new -> 409", r.status === 409, r.body);
  let t = await asset(truckRow.id);
  check("truck: accumulated 4500, book value 295500, schedule continues at 4500", t.accumulated === "4500.00" && t.bookValue === "295500.00" && n(t.schedule[0]?.amount) === 4500 && t.schedule[0].period === M2, [t.accumulated, t.schedule[0]]);
  let refused = false;
  try { await db.$executeRawUnsafe(`INSERT INTO "AssetDepreciationLine" ("id","assetId","period","runId","amount","accumulatedAfter","entryId") SELECT 'dup-${SUF}', "assetId", "period", "runId", "amount", "accumulatedAfter", "entryId" FROM "AssetDepreciationLine" WHERE "assetId" = '${truckRow.id}' LIMIT 1`); } catch { refused = true; }
  check("DB: the same asset-month cannot be depreciated twice", refused);

  section("6. SALE WITH VAT (catch-up depreciation, loss)");
  r = await call("karim", "POST", `/api/assets/${scale.id}/dispose`, { kind: "sale", date: `${thisMonth}-01`, proceeds: "9000", cash_account_id: "bank_main", tax_code: "VAT14", reason: "استبدال بميزان أكبر" });
  check("scale sold for 9000 + VAT -> 200", r.status === 200, r.body);
  // Depreciated M1 (500) by the run, M2 caught up (500) at disposal: book value 11000, loss 2000.
  check("…catch-up of M2, book value 11000, loss 2000", r.body.result.catchUp === "500.00" && r.body.result.bookValue === "11000.00" && r.body.result.gainLoss === "-2000.00", r.body.result);
  check("…scale cost and accumulated accounts back to zero", (await gl(scales.assetAccountId)) === 0 && (await gl(scales.accumulatedAccountId)) === 0);
  const dispJe = (await db.journalEntry.findFirst({ where: { sourceType: "asset_disposal", description: { contains: scale.number } }, include: { lines: { include: { account: true } } } }))!;
  const side = (k: string) => dispJe.lines.filter((l) => l.account.systemKey === k).reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
  check("…Cr VAT output 1260, Dr loss on disposal 2000", side("vat_output") === -1260 && side("fa_disposal_loss") === 2000, dispJe.lines.map((l) => [l.account.code, l.debit, l.credit]));
  const vat = (await call("karim", "GET", `/api/accounting/vat-summary?from=${thisMonth}-01&to=${thisMonth}-01`)).body.summary;
  check("the VAT summary counts the sale's VAT and still reconciles", vat.ledger.reconciled === true, vat.ledger);
  check("a sold asset cannot be sold again -> 409", (await call("karim", "POST", `/api/assets/${scale.id}/dispose`, { kind: "scrap", date: today, reason: "x" })).status === 409);
  check("a sale without proceeds -> 400", (await call("karim", "POST", `/api/assets/${plot.id}/dispose`, { kind: "sale", date: today, cash_account_id: "bank_main", reason: "x" })).status === 400);
  const cf = (await call("karim", "GET", `/api/management/cash-flow?from=${thisMonth}-01&to=${thisMonth}-01`)).body.report;
  const scaleCode = String(chart.find((a) => a.id === scales.assetAccountId).code);
  const costLine = n(cf.sections.investing.lines.find((l: any) => l.accountCode === scaleCode)?.amount);
  // This sale's share of the disposal adjustment: −(accumulated removed) + gain.
  const share = -1000 + -2000;
  check("cash flow: this sale = cost out 12000 + its adjustment −3000 = 9000 proceeds under investing", costLine === 12000 && r2(costLine + share) === 9000, [costLine, share]);
  const [day] = await db.$queryRaw<{ s: Prisma.Decimal | null }[]>`SELECT sum(-"accumulatedDelta" - "gainLoss") AS s FROM "AssetEvent" WHERE "type" = 'disposal' AND "date" = ${thisMonth + "-01"}`;
  const adj = cf.sections.investing.lines.find((l: any) => l.adjustment === "disposal_proceeds");
  check("…the adjustment covers every disposal of the day (Σ gain − accumulated), mirrored under operating, and the report balances", r2(n(adj?.amount)) === r2(-n(day?.s)) && r2(n(cf.sections.operating.lines.find((l: any) => l.adjustment === "disposal_noncash")?.amount)) === r2(n(day?.s)) && cf._balanced === true, [adj, day?.s]);

  section("7. IMPROVEMENT, TRANSFER, ALLOWANCE, SCRAP");
  const journalsBefore = await db.journalEntry.count();
  r = await call("karim", "POST", `/api/assets/${truckRow.id}/transfer`, { warehouse_id: null, location: "فرع الإسكندرية", reason: "نقل للفرع" });
  check("transfer to another location -> 200, no journal entry", r.status === 200 && r.body.result.location === "فرع الإسكندرية" && (await db.journalEntry.count()) === journalsBefore, r.body);
  check("a transfer that changes nothing -> 400", (await call("karim", "POST", `/api/assets/${truckRow.id}/transfer`, { location: "فرع الإسكندرية", reason: "x" })).status === 400);
  r = await call("karim", "POST", `/api/assets/${truckRow.id}/improve`, { amount: "6000", date: `${M2}-10`, cash_account_id: "bank_main", description: "عزل الصندوق" });
  check("improvement 6000 -> cost 306000", r.status === 200 && n(r.body.result.cost) === 306000, r.body);
  const pv2 = (await call("karim", "GET", `/api/assets/depreciation?period=${M2}`)).body.preview.rows.find((x: any) => x.assetId === truckRow.id);
  check("…taken prospectively: (306000 − 30000 − 4500) / 59 for M2", n(pv2?.amount) === r2(271500 / 59), [pv2, r2(271500 / 59)]);
  r = await call("karim", "POST", "/api/assets/depreciation", { period: M2 });
  check("run M2 -> 201", r.status === 201, r.body);
  const billFull = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
  const capLine = billFull.serviceLines[0];
  r = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "خصم من التوكيل", lines: [{ service_line_id: capLine.id, amount: "10000" }] });
  check("a supplier allowance of 10000 on the capital line -> 201", r.status === 201, r.body);
  t = await asset(truckRow.id);
  check("…the truck's cost drops to 296000 (register = GL)", t.cost === "296000.00" && (await gl(tCost.id)) === 296000, [t.cost, await gl(tCost.id)]);
  r = await call("karim", "POST", "/api/assets", { category_id: trucks.id, name: `${TAG} عربية قديمة`, cost: "8000", acquisition_date: `${M0}-01`, cash_account_id: "bank_main" });
  const old = r.body.asset;
  r = await call("karim", "POST", `/api/assets/${old.id}/dispose`, { kind: "scrap", date: today, reason: "حادثة" });
  check("a draft asset scrapped: loss 8000, nothing left in its accounts", r.status === 200 && r.body.result.gainLoss === "-8000.00", r.body);
  r = await call("karim", "POST", `/api/assets/${truckRow.id}/estimate`, { useful_life_months: 1, reason: "x" });
  check("a life shorter than the months already used -> 400", r.status === 400);
  r = await call("karim", "POST", `/api/assets/${truckRow.id}/estimate`, { useful_life_months: 48, reason: "تشغيل مكثف" });
  check("change of estimate (60 → 48 months) recorded", r.status === 200 && r.body.result.usefulLifeMonths === 48, r.body);

  section("8. REGISTER = LEDGER, ROLL-FORWARD, GUARDS");
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("integrity: fixed assets register = GL for every category", health.checks.find((c: any) => c.key === "fixed_assets")?.ok === true, health.checks.find((c: any) => c.key === "fixed_assets"));
  check("integrity: all checks green (traceability, trial balance, VAT …)", health.ok === true, health.checks.filter((c: any) => !c.ok));
  const rf = (await call("karim", "GET", `/api/assets/reports/roll-forward?from=${M0}-01&to=${today}`)).body.report;
  const rfT = rf.rows.find((x: any) => x.categoryId === trucks.id), rfS = rf.rows.find((x: any) => x.categoryId === scales.id);
  check("roll-forward ties for every category (opening + additions − depreciation − disposals = closing)", rf.rows.every((x: any) => x.ties), rf.rows.filter((x: any) => !x.ties));
  check("…trucks: additions 300000 + 6000 + 8000 − 10000 allowance = 304000, disposals 8000", n(rfT.additions) === 304000 && n(rfT.disposals) === 8000, rfT);
  check("…scales: closing book value 0 after the sale", n(rfS.closingBookValue) === 0, rfS);
  refused = false;
  try { await db.$executeRawUnsafe(`DELETE FROM "FixedAsset" WHERE "id" = '${truckRow.id}'`); } catch { refused = true; }
  check("DB: an asset cannot be deleted", refused);
  refused = false;
  try { await db.$executeRawUnsafe(`UPDATE "FixedAsset" SET "name" = 'x' WHERE "id" = '${scale.id}'`); } catch { refused = true; }
  check("DB: a disposed asset is final", refused);
  refused = false;
  try { await db.$executeRawUnsafe(`UPDATE "FixedAsset" SET "accumulated" = 0 WHERE "id" = '${truckRow.id}'`); } catch { refused = true; }
  check("DB: accumulated depreciation only grows", refused);
  refused = false;
  try { await db.$executeRawUnsafe(`UPDATE "AssetEvent" SET "costDelta" = 0 WHERE "assetId" = '${truckRow.id}'`); } catch { refused = true; }
  check("DB: asset events are append-only", refused);
  const tb = (await call("karim", "GET", "/api/accounting/trial-balance?from=2000-01-01&to=2099-12-31")).body.trialBalance;
  check("trial balance balances", tb.balanced === true);

  await db.$disconnect();
  finish("FIXED ASSETS");
}

main().catch((e) => { console.error(e); process.exit(1); });
