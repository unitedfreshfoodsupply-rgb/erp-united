/* Cost centers: a reporting dimension on revenue and expense lines.
   Expenses, service-bill expense lines, manual journals and the depreciation of an asset
   assigned to a center carry it into the journal; it never sits on a balance-sheet line
   (DB-enforced) and cannot change once posted; the report's totals equal the P&L; the
   "required" setting makes people name one; inactive centers are refused. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const TAG = `ZZCC${Date.now() % 1_000_000_000}`;
const SUF = String(Date.now()).slice(-6);
const { check, section, finish } = makeChecker();
const n = (v: any) => Number(v ?? 0);
const today = todayBiz();
const setSetting = (key: string, value: unknown) => call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: `${TAG} اختبار` });

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "karim", "mona", "omar"]) await login(u);
  await setSetting("accounting.cost_center_required", null);
  const linesOf = async (sourceType: string, sourceId: string) => db.journalLine.findMany({ where: { entry: { sourceType, sourceId } }, include: { account: true } });

  section("1. CENTERS");
  check("sales cannot create a cost center -> 403", (await call("mona", "POST", "/api/accounting/cost-centers", { code: "X1", name: "x", name_ar: "x", kind: "other" })).status === 403);
  const mk = async (code: string, kind: string, parent?: string) => (await call("karim", "POST", "/api/accounting/cost-centers", { code: `${code}${SUF}`, name: `${TAG} ${code}`, name_ar: `${TAG} ${code}`, kind, parent_id: parent ?? null })).body.costCenter;
  const wh = await mk("WH", "warehouse"), fleet = await mk("FLT", "transport");
  const van = await mk("VAN", "vehicle", fleet.id);
  check("warehouse, fleet and a van under the fleet", !!wh?.id && !!fleet?.id && van?.parentId === fleet.id, [wh, fleet, van]);
  check("a duplicate code -> 409", (await call("karim", "POST", "/api/accounting/cost-centers", { code: `WH${SUF}`, name: "x", name_ar: "x", kind: "warehouse" })).status === 409);
  check("a cycle (fleet under its own van) -> 400", (await call("karim", "PATCH", `/api/accounting/cost-centers/${fleet.id}`, { parent_id: van.id })).status === 400);
  check("the expense form lists them (expense submitters)", (await call("karim", "GET", "/api/accounting/cost-centers")).body.costCenters.some((c: any) => c.id === van.id));

  section("2. EXPENSE, SERVICE BILL AND MANUAL JOURNAL CARRY IT");
  let r = await call("karim", "POST", "/api/hr/expenses", { date: today, account_id: "acc_6200", amount: "300", description: `${TAG} سولار`, payment_mode: "cash", cash_account_id: "cash_main", cost_center_id: van.id });
  const exp = r.body.expense;
  check("an expense with a cost center -> 201", r.status === 201, r.body);
  if (exp.status === "pending_approval") { const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === exp.id); await call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version }); }
  let lines = await linesOf("expense", exp.id);
  check("…its expense line carries the van, the cash line none", lines.find((l) => l.account.code === "6200")?.costCenterId === van.id && lines.find((l) => l.account.code === "1100")?.costCenterId === null, lines.map((l) => [l.account.code, l.costCenterId]));
  check("a cost center on a balance-sheet line of a journal -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} x`, lines: [{ account_id: "acc_6100", debit: 1 }, { account_id: "acc_1100", credit: 1, cost_center_id: wh.id }] })).status === 400);
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} إعادة توزيع`, lines: [{ account_id: "acc_6200", debit: 100, cost_center_id: wh.id }, { account_id: "acc_6200", credit: 100, cost_center_id: van.id }] });
  check("reallocation between centers on the same account (manual journal) -> 201", r.status === 201, r.body);
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} صيانة` })).body.supplier;
  r = await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier.id, supplier_invoice_no: `${TAG}-1`, bill_date: today, lines: [{ account_id: "acc_6200", description: "صيانة", amount: "200", tax_code: "VAT14", cost_center_id: van.id }, { account_id: "acc_6100", description: "كهربا المخزن", amount: "150", tax_code: "VAT14", cost_center_id: wh.id }] });
  const bill = r.body.bill;
  check("a service bill with a center per line -> 201", r.status === 201, r.body);
  r = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  if (r.body.bill?.status === "pending_approval") { const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === bill.id); await call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version }); }
  lines = await linesOf("supplier_bill", bill.id);
  check("…posted lines: 6200 on the van, 6100 on the warehouse, AP and VAT on none", lines.find((l) => l.account.code === "6200")?.costCenterId === van.id && lines.find((l) => l.account.code === "6100")?.costCenterId === wh.id && lines.filter((l) => l.costCenterId).length === 2, lines.map((l) => [l.account.code, l.costCenterId]));
  const billFull = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
  r = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/debit-notes`, { reason: "خصم", lines: [{ service_line_id: billFull.serviceLines[0].id, amount: "50" }] });
  const dnLines = await db.journalLine.findMany({ where: { entry: { sourceType: "debit_note", sourceId: r.body.debitNote?.id } }, include: { account: true } });
  check("a supplier allowance credits the same center", dnLines.find((l) => l.account.code === "6200")?.costCenterId === van.id, dnLines.map((l) => [l.account.code, l.costCenterId]));

  section("3. DEPRECIATION OF AN ASSET ASSIGNED TO A CENTER");
  const cat = (await call("karim", "POST", "/api/assets/categories", { code: `CC${SUF}`, name: `${TAG} Vans`, name_ar: `${TAG} عربيات`, useful_life_months: 12, residual_percent: 0, depreciation_start: "same_month" })).body.category;
  const prev = (() => { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  r = await call("karim", "POST", "/api/assets", { category_id: cat.id, name: `${TAG} فان`, cost: "12000", acquisition_date: `${prev}-01`, in_service_date: `${prev}-01`, cash_account_id: "bank_main", cost_center_id: van.id });
  check("asset bought, assigned to the van", r.status === 201 && r.body.asset.costCenterId === van.id, r.body);
  r = await call("karim", "POST", "/api/assets/depreciation", { period: prev });
  const depLines = await db.journalLine.findMany({ where: { entryId: r.body.run?.entryId, costCenterId: van.id }, include: { account: true } });
  check("the month's depreciation expense of that asset (1000) carries the van", r.status === 201 && depLines.some((l) => l.account.systemKey === "fa_depreciation" && n(l.debit) === 1000), [r.status, r.body, depLines.map((l) => [l.account.code, l.debit])]);

  section("4. REPORT RECONCILES TO THE P&L");
  const rep = (await call("karim", "GET", `/api/accounting/cost-centers/report?from=${prev}-01&to=${today}`)).body.report;
  const pl = (await call("karim", "GET", `/api/accounting/pnl?from=${prev}-01&to=${today}`)).body;
  check("report totals = P&L revenue and expenses for the same range", rep.totals.revenue === pl.revenue && rep.totals.expenses === pl.expenses, [rep.totals, pl.revenue, pl.expenses]);
  const vanRow = rep.centers.find((g: any) => g.costCenter?.id === van.id);
  check("the van: 300 fuel − 100 reallocated + 200 repair − 50 allowance + 1000 depreciation = 1350", n(vanRow?.expenses) === 1350, vanRow);
  check("…the warehouse: 100 reallocated + 150 electricity = 250", n(rep.centers.find((g: any) => g.costCenter?.id === wh.id)?.expenses) === 250);
  check("…and what carries no center is shown as unallocated", rep.centers.some((g: any) => g.costCenter === null) || n(rep.totals.unallocatedExpenses) === 0);

  section("5. REQUIRED SETTING, INACTIVE CENTERS, DB GUARDS");
  await setSetting("accounting.cost_center_required", true);
  check("with the setting on, an expense without a center -> 400", (await call("karim", "POST", "/api/hr/expenses", { date: today, account_id: "acc_6100", amount: "10", description: `${TAG} x`, payment_mode: "cash", cash_account_id: "cash_main" })).status === 400);
  check("…and a manual journal expense line without one -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} x`, lines: [{ account_id: "acc_6100", debit: 1 }, { account_id: "acc_1100", credit: 1 }] })).status === 400);
  check("…with a center it goes through", (await call("karim", "POST", "/api/hr/expenses", { date: today, account_id: "acc_6100", amount: "10", description: `${TAG} y`, payment_mode: "cash", cash_account_id: "cash_main", cost_center_id: wh.id })).status === 201);
  await setSetting("accounting.cost_center_required", null);
  const fleetNow = (await call("karim", "GET", "/api/accounting/cost-centers?all=1")).body.costCenters.find((c: any) => c.id === fleet.id);
  check("a center with active children cannot be retired -> 409", (await call("karim", "PATCH", `/api/accounting/cost-centers/${fleet.id}`, { active: false, version: fleetNow.version })).status === 409);
  const vanNow = (await call("karim", "GET", "/api/accounting/cost-centers?all=1")).body.costCenters.find((c: any) => c.id === van.id);
  check("the van retired", (await call("karim", "PATCH", `/api/accounting/cost-centers/${van.id}`, { active: false, version: vanNow.version })).status === 200);
  check("…an expense on a retired center -> 400", (await call("karim", "POST", "/api/hr/expenses", { date: today, account_id: "acc_6200", amount: "10", description: `${TAG} z`, payment_mode: "cash", cash_account_id: "cash_main", cost_center_id: van.id })).status === 400);
  let refused = false;
  const one = await db.journalLine.findFirst({ where: { costCenterId: wh.id } });
  try { await db.$executeRawUnsafe(`UPDATE "JournalLine" SET "costCenterId" = NULL WHERE "id" = '${one!.id}'`); } catch { refused = true; }
  check("DB: a posted line's cost center cannot change", refused);
  refused = false;
  try {
    await db.$transaction(async (tx) => {
      const e = await tx.journalEntry.findFirstOrThrow({ where: { sourceType: "manual" } });
      await tx.$executeRawUnsafe(`INSERT INTO "JournalLine" ("id","entryId","accountId","debit","credit","costCenterId") VALUES ('x-${SUF}', '${e.id}', 'acc_1100', 0, 0, '${wh.id}')`);
    });
  } catch { refused = true; }
  check("DB: a cost center on a balance-sheet line is refused", refused);
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("integrity check green", health.ok === true, health.checks.filter((c: any) => !c.ok));

  await db.$disconnect();
  finish("COST CENTERS");
}

main().catch((e) => { console.error(e); process.exit(1); });
