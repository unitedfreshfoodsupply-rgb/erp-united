/* The phased opening migration over HTTP (Nov 2026): who may see and do what, the supplier
   sheet import (by ERP code only, a vegetable sheet never matching a fruit supplier), maker-checker,
   the clearing account traced to its batch, the reports flagged provisional, the export, and a
   closure refused while the position is incomplete. A migration is permanent and closes the direct
   opening forms, so the e2e chain runs this suite last and resets the database after it. */
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const TAG = `ZZOPM${Date.now() % 1_000_000_000}`;
const FILE = `${TAG} مراجعه موردين.xlsx`;
const { check, section, finish } = makeChecker();
const today = todayBiz();

async function main() {
  assertTestDatabase();
  for (const u of ["admin", "karim", "mona", "omar", "hossam"]) await login(u);
  const overview = async () => (await call("karim", "GET", "/api/accounting/opening-migration")).body.overview;

  section("1. ACCESS");
  for (const u of ["mona", "hossam", "omar"]) check(`${u} cannot see the control center -> 403`, (await call(u, "GET", "/api/accounting/opening-migration")).status === 403);
  check("sales cannot start the migration -> 403", (await call("mona", "POST", "/api/accounting/opening-migration", { cutover_date: today })).status === 403);
  check("sales cannot import a sheet -> 403", (await call("mona", "POST", "/api/accounting/opening-migration/import", { segment: "suppliers", mode: "preview", source_file: "x", rows: [{ source_row: "1", source_name: "x", amount: "1" }] })).status === 403);
  check("stock cannot read the exception register -> 403", (await call("hossam", "GET", "/api/accounting/opening-migration/exceptions")).status === 403);

  const before = await overview();
  if (before.migration) {
    check("a database already opened: phase batches stay closed once the migration is", before.status !== "closed" || (await call("karim", "POST", "/api/accounting/opening-batches", { kind: "phase", segment: "suppliers" })).status === 409);
    console.log("  (the migration already exists on this database: run after a reset for the full suite)");
    return finish("opening-migration");
  }
  check("not started yet", before.status === "not_started");

  section("2. START");
  let r = await call("karim", "POST", "/api/accounting/opening-migration", { cutover_date: today, notes: "go-live in phases" });
  check("the accountant starts the migration at the cut-off -> 201", r.status === 201 && r.body.migration?.cutoverDate === today, r.body);
  check("…once: another date -> 409", (await call("karim", "POST", "/api/accounting/opening-migration", { cutover_date: "2020-01-31" })).status === 409);
  check("the one-batch opening is closed -> 409", (await call("karim", "POST", "/api/accounting/opening-batches", { kind: "initial", cutover_date: today })).status === 409);
  check("the direct opening form is closed -> 409", (await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "supplier", party_id: "x", date: today, amount: "10" })).status === 409);

  section("3. SUPPLIERS FIRST");
  const veg = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} سيف علوش` })).body.supplier;
  const fruit = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "fruit", name: `${TAG} مزرعة فاكهة` })).body.supplier;
  r = await call("karim", "POST", "/api/accounting/opening-batches", { kind: "phase", segment: "suppliers", source_file: FILE });
  const batch = r.body.batch;
  check("a supplier phase batch -> 201", r.status === 201 && batch?.kind === "phase" && batch?.segment === "suppliers", r.body);
  const rows = [
    { source_row: "28", source_name: "سيف علوش", party_code: veg.code, amount: "1283160" },
    { source_row: "21", source_name: "سيد ليمون", party_code: veg.code, amount: "0" },
    { source_row: "50", source_name: "اسم بدون كود", amount: "123" },
    { source_row: "51", source_name: "مورد فاكهة", party_code: fruit.code, amount: "77" },
  ];
  r = await call("karim", "POST", "/api/accounting/opening-migration/import", { segment: "suppliers", mode: "preview", batch_id: batch.id, source_file: FILE, category: "vegetable", rows });
  check("preview -> 200: 1 matched, 1 zero, 2 exceptions", r.status === 200 && r.body.result.summary.matched === 1 && r.body.result.summary.zero === 1 && r.body.result.summary.exceptions === 2, r.body);
  check("…the fruit supplier is not matched from a vegetable sheet", r.body.result.rows.find((x: any) => x.source_row === "51")?.reason === "category_mismatch");
  r = await call("karim", "POST", "/api/accounting/opening-migration/import", { segment: "suppliers", mode: "commit", batch_id: batch.id, source_file: FILE, category: "vegetable", rows });
  check("commit -> 201: the matched row in the batch, the others in the register", r.status === 201 && r.body.result.summary.matched === 1 && r.body.result.summary.newExceptions === 2, r.body);
  r = await call("karim", "POST", "/api/accounting/opening-migration/import", { segment: "suppliers", mode: "commit", batch_id: batch.id, source_file: FILE, category: "vegetable", rows });
  check("the same sheet again adds nothing", r.status === 201 && r.body.result.summary.matched === 0 && r.body.result.summary.newExceptions === 0, r.body);
  const detail = (await call("karim", "GET", `/api/accounting/opening-batches/${batch.id}`)).body.batch;
  check("the batch balances against the provisional clearing account", detail.validation.problems.length === 0 && detail.validation.clearing === "1283160.00" && detail.validation.totals.debit === detail.validation.totals.credit, detail.validation);
  check("submitted -> 202", (await call("karim", "POST", `/api/accounting/opening-batches/${batch.id}/submit`, {})).status === 202);
  const pending = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === batch.id);
  check("in the approvals inbox", pending?.type === "accounting.opening_batch");
  check("the preparer cannot approve it", (await call("karim", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve", expected_version: pending.version })).status === 403);
  r = await call("admin", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve", expected_version: pending.version });
  check("a second person approves -> posted", r.status === 200 && (await call("karim", "GET", `/api/accounting/opening-batches/${batch.id}`)).body.batch.status === "posted", r.body);

  section("4. VISIBLE AT ONCE, AND PROVISIONAL");
  const statement = await call("omar", "GET", `/api/purchasing/suppliers/${veg.id}/statement?from=${today}&to=${today}`);
  check("the supplier's statement shows the opening balance", statement.status === 200 && JSON.stringify(statement.body).includes("1283160"), statement.body);
  const o = await overview();
  check("status: reconciliation required (supplier-only, clearing not zero)", o.status === "reconciliation_required", o.status);
  check("the clearing account is traced to the batch", o.clearing.balance === "1283160.00" && o.clearing.untraced === "0.00" && o.clearing.byBatch[0]?.number === batch.number, o.clearing);
  check("the register holds the two unmatched rows", o.exceptions.open === 2 && o.exceptions.bySegment.suppliers?.unmatched === 1, o.exceptions);
  const tb = (await call("karim", "GET", `/api/accounting/trial-balance?from=${today}&to=${today}`)).body;
  check("the trial balance says its opening is provisional", tb.opening?.final === false && tb.opening?.clearing === "1283160.00", tb.opening);
  const bs = (await call("karim", "GET", `/api/accounting/balance-sheet?as_of=${today}`)).body;
  check("the balance sheet too, and lists the clearing account", bs.opening?.final === false && bs.sections.equity.lines.some((l: any) => l.code === "3900"), bs.opening);
  check("the P&L too", (await call("karim", "GET", `/api/accounting/pnl?from=${today}&to=${today}`)).body.opening?.final === false);
  const csv = await call("karim", "GET", "/api/accounting/opening-migration/export?part=parties");
  check("the opening position exports (parties, with the batch)", csv.status === 200 && String(csv.body).includes(veg.code) && String(csv.body).includes(batch.number));
  check("a manual journal on the clearing account -> 400", (await call("karim", "POST", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: "acc_3900", debit: "1", credit: "0" }, { account_id: "acc_1100", debit: "0", credit: "1" }] })).status === 400);

  section("5. CLOSURE WAITS FOR THE COMPLETE POSITION");
  r = await call("karim", "POST", "/api/accounting/opening-migration/close", { expected_version: o.migration.version });
  check("closure refused while incomplete -> 409", r.status === 409, r.body);
  r = await call("karim", "POST", "/api/accounting/opening-migration/attest", { key: "suppliers_complete", confirmed: true, note: "اختبار", expected_version: o.migration.version });
  check("a confirmation is recorded with its author", r.status === 200 && r.body.migration.attestations?.suppliers_complete?.by, r.body);
  check("sales cannot confirm -> 403", (await call("mona", "POST", "/api/accounting/opening-migration/attest", { key: "suppliers_complete", confirmed: true, note: "x", expected_version: r.body.migration.version })).status === 403);
  const exceptions = (await call("karim", "GET", "/api/accounting/opening-migration/exceptions?status=open")).body.exceptions;
  r = await call("karim", "POST", `/api/accounting/opening-migration/exceptions/${exceptions[0].id}`, { status: "excluded", resolution: "اختبار", expected_version: exceptions[0].version });
  check("an exception is decided with its reason", r.status === 200 && r.body.exception.status === "excluded");
  return finish("opening-migration");
}

main().catch((e) => { console.error(e); process.exit(1); });
