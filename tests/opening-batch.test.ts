/* Opening balances as one controlled batch.
   GL balances, customers, suppliers, stock and fixed assets (original cost + accumulated
   depreciation) are staged, validated as one opening trial balance (debits = credits,
   nothing left in opening equity), submitted (lines freeze), approved by someone else and
   posted once; afterwards the direct opening forms are closed and only approved
   correction batches change opening figures. Subledgers equal their GL accounts after it.
   Posting the initial batch is permanent, so the e2e chain resets the database after this
   suite; on a database already opened it runs the correction path only. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const TAG = `ZZOPN${Date.now() % 1_000_000_000}`;
const SUF = String(Date.now()).slice(-6);
const { check, section, finish } = makeChecker();
const n = (v: any) => Number(v ?? 0);
const today = todayBiz();
const addMonths = (d: string, k: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + k); return x.toISOString().slice(0, 10); };

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "karim", "mona", "omar", "hossam"]) await login(u);
  const glKey = async (key: string) => { const [r] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${key}`; return n(r?.b); };
  const approve = async (entityId: string, decision = "approve") => { const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === entityId); return call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision, ...(decision === "reject" ? { comment: "راجع الأرقام" } : {}), expected_version: a.version }); };
  const detail = async (id: string) => (await call("karim", "GET", `/api/accounting/opening-batches/${id}`)).body.batch;
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} سلسلة مطاعم` })).body.customer;
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} مزرعة` })).body.supplier;

  section("1. ACCESS");
  check("sales cannot see opening batches -> 403", (await call("mona", "GET", "/api/accounting/opening-batches")).status === 403);
  check("sales cannot create one -> 403", (await call("mona", "POST", "/api/accounting/opening-batches", { cutover_date: today })).status === 403);

  const already = (await call("karim", "GET", "/api/accounting/opening-batches")).body.batches.some((b: any) => b.kind === "initial" && b.status === "posted");
  if (!already) {
    section("2. PREPARE THE INITIAL BATCH");
    const product = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Potato`, unit: "KG" })).body.product;
    const cat = (await call("karim", "POST", "/api/assets/categories", { code: `OV${SUF}`, name: `${TAG} Vans`, name_ar: `${TAG} عربيات`, useful_life_months: 60, residual_percent: 0, depreciation_start: "next_month" })).body.category;
    const loan = (await call("karim", "POST", "/api/accounting/accounts", { code: `24${SUF.slice(-5)}`, name: `${TAG} Loan`, name_ar: `${TAG} قرض`, parent_id: "acc_2000", cash_flow_category: "financing" })).body.account;
    check("a correction before any opening batch -> 409", (await call("karim", "POST", "/api/accounting/opening-batches", { kind: "correction" })).status === 409);
    const key = `${TAG}-batch`;
    let r = await call("karim", "POST", "/api/accounting/opening-batches", { cutover_date: today, notes: "go-live", idempotency_key: key });
    const batch = r.body.batch;
    check("draft batch created (OPN number)", r.status === 201 && /^OPN-\d{4}$/.test(batch?.number), r.body);
    check("…the same submit again returns it", (await call("karim", "POST", "/api/accounting/opening-batches", { cutover_date: today, idempotency_key: key })).body.batch?.id === batch.id);
    check("a second open initial batch -> 409", (await call("karim", "POST", "/api/accounting/opening-batches", { cutover_date: today })).status === 409);
    const add = (lines: any[]) => call("karim", "POST", `/api/accounting/opening-batches/${batch.id}/lines`, { lines });
    check("a GL line on the customers control account -> 400", (await add([{ kind: "gl", account_id: "acc_1300", debit: 100 }])).status === 400);
    check("a GL line on opening equity -> 400 (it closes by itself)", (await add([{ kind: "gl", account_id: "acc_3300", credit: 100 }])).status === 400);
    check("an asset with accumulated depreciation above cost -> 400", (await add([{ kind: "asset", category_id: cat.id, name: "x", cost: 100, accumulated: 200, acquisition_date: addMonths(today, -24), in_service_date: addMonths(today, -24) }])).status === 400);
    check("an asset put in service after the cut-over -> 400", (await add([{ kind: "asset", category_id: cat.id, name: "x", cost: 100, accumulated: 0, acquisition_date: today, in_service_date: addMonths(today, 1) }])).status === 400);
    check("expired stock is not opening stock -> 400", (await add([{ kind: "stock", product_id: product.id, quantity: 1, unit_cost: 1, expiry_date: addMonths(today, -1) }])).status === 400);
    r = await add([
      { kind: "gl", account_id: "acc_1100", debit: "5000", description: "الخزينة" },
      { kind: "gl", account_id: "acc_1200", debit: "50000", description: "البنك" },
      { kind: "gl", account_id: loan.id, credit: "40000", description: "قرض" },
      { kind: "gl", account_id: "acc_3100", credit: "100000", description: "رأس المال" },
      { kind: "customer", party_id: customer.id, amount: "12000", due_date: addMonths(today, 1), reference: "INV-OLD-77" },
      { kind: "supplier", party_id: supplier.id, amount: "8000", reference: "BILL-OLD-5" },
      { kind: "stock", product_id: product.id, quantity: "100", unit_cost: "12.5" },
      // Fractional lines: each is 0.4443 at the stock ledger's 4 places; three of them are
      // 1.3329 → 1.33 posted once. Rounding each line to cents first would say 1.32 and
      // leave a cent in opening equity.
      { kind: "stock", product_id: product.id, quantity: "1.333", unit_cost: "0.3333" },
      { kind: "stock", product_id: product.id, quantity: "1.333", unit_cost: "0.3333" },
      { kind: "stock", product_id: product.id, quantity: "1.333", unit_cost: "0.3333" },
      { kind: "asset", category_id: cat.id, name: `${TAG} عربية مبردة`, cost: "120000", accumulated: "30000", acquisition_date: addMonths(today, -18), in_service_date: addMonths(today, -18), plate_number: "ق ط ع 9" },
    ]);
    check("11 lines added", r.status === 201 && r.body.added === 11, r.body);
    let d = await detail(batch.id);
    check("validation: debit 188251.33, credit 178000, difference 10251.33 (retained earnings missing)", d.validation.totals.debit === "188251.33" && d.validation.totals.credit === "178000.00" && d.validation.totals.residual === "10251.33", d.validation.totals);
    check("…unbalanced, so it cannot be sent", d.validation.problems.some((p: any) => p.code === "unbalanced") && (await call("karim", "POST", `/api/accounting/opening-batches/${batch.id}/submit`, {})).status === 409);
    await add([{ kind: "gl", account_id: "acc_3200", credit: "10251.33", description: "أرباح محتجزة" }]);
    d = await detail(batch.id);
    check("with retained earnings stated it balances (difference 0)", d.validation.totals.residual === "0.00" && d.validation.problems.length === 0, d.validation);
    check("…the three identical fractional stock lines are allowed (two lots alike can be real) and shown for review", d.validation.warnings.some((w: any) => w.code === "identical_lines" && w.params.lines === "8=9, 8=10"), d.validation.warnings);
    check("…subledgers shown: customers 12000, suppliers 8000, stock 1251.33, assets 120000 / 30000", d.validation.subledgers.customers === "12000.00" && d.validation.subledgers.suppliers === "8000.00" && d.validation.subledgers.stock === "1251.33" && d.validation.subledgers.assetsCost === "120000.00" && d.validation.subledgers.assetsAccumulated === "30000.00", d.validation.subledgers);

    // How UNITED brings balances in: one total per customer and per supplier, named by its code.
    // A credit balance (a customer's advance, our advance to a supplier) is a negative total.
    const customer2 = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} فندق` })).body.customer;
    const supplier2 = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${TAG} تاجر جملة` })).body.supplier;
    check("an unknown customer code -> 404, nothing added", (await add([{ kind: "customer", party_code: `NOPE${SUF}`, amount: "1" }])).status === 404 && (await detail(batch.id)).lines.length === 12);
    const totals = [
      { kind: "customer", party_code: customer2.code, amount: "-1500", reference: "رصيد دائن" },
      { kind: "supplier", party_code: supplier2.code, amount: "-700", reference: "دفعة مقدمة" },
      { kind: "gl", account_code: "1100", debit: "800", description: "الخزينة" },
    ];
    r = await add(totals);
    check("one total per party, by code: customer credit −1500, supplier advance −700, cash 800 -> 3 lines", r.status === 201 && r.body.added === 3, r.body);
    d = await detail(batch.id);
    const lineOf = (pid: string) => d.lines.find((l: any) => l.data.party_id === pid);
    check("…each code resolved to its record and kept on the line", lineOf(customer2.id)?.data.party_code === customer2.code && lineOf(supplier2.id)?.data.party_code === supplier2.code && d.lines.some((l: any) => l.data.account_id === "acc_1100" && l.data.account_code === "1100"), d.lines.slice(-3));
    const tbRow = (code: string) => d.validation.trialBalance.find((x: any) => x.account.code === code);
    check("…balanced; customers 10500 and suppliers 7300 net; AR 10500 debit, AP 7300 credit", d.validation.problems.length === 0 && d.validation.subledgers.customers === "10500.00" && d.validation.subledgers.suppliers === "7300.00" && tbRow("1300")?.debit === "10500.00" && tbRow("2100")?.credit === "7300.00", [d.validation.problems, d.validation.subledgers, tbRow("1300"), tbRow("2100")]);
    r = await add([totals[0]]);
    d = await detail(batch.id);
    check("the same total pasted twice is refused: the duplicate blocks the batch", r.status === 201 && d.validation.problems.some((p: any) => p.code === "duplicate_lines" && p.params.lines === "13=16"), d.validation.problems);
    check("…it cannot be sent while the duplicate is there -> 409", (await call("karim", "POST", `/api/accounting/opening-batches/${batch.id}/submit`, {})).status === 409);
    const dupLine = d.lines.find((l: any) => l.lineNo === 16);
    check("…removed, the batch is clean again", (await call("karim", "DELETE", `/api/accounting/opening-batches/${batch.id}/lines/${dupLine.id}`)).status === 200 && (await detail(batch.id)).validation.problems.length === 0);
    r = await add([{ kind: "customer", party_code: customer2.code, amount: "250" }, { kind: "gl", account_code: "1100", credit: "250", description: "x" }]);
    d = await detail(batch.id);
    check("a party on a second line (different figures) is allowed but flagged for review", r.status === 201 && d.validation.problems.length === 0 && d.validation.warnings.some((w: any) => w.code === "party_repeated" && w.params.n === "1"), d.validation);
    for (const l of d.lines.filter((x: any) => x.lineNo > 15)) await call("karim", "DELETE", `/api/accounting/opening-batches/${batch.id}/lines/${l.id}`);
    check("…removed again: 15 lines, no warning about repeats", (await detail(batch.id)).lines.length === 15 && !(await detail(batch.id)).validation.warnings.some((w: any) => w.code === "party_repeated"));
    const bsLine = (bs: any, section: string, code: string) => n(bs.sections[section].lines.find((x: any) => x.code === code)?.amount);
    const bsBefore = (await call("karim", "GET", `/api/accounting/balance-sheet?as_of=${today}`)).body;

    section("3. SUBMIT, FREEZE, APPROVE BY SOMEONE ELSE");
    r = await call("karim", "POST", `/api/accounting/opening-batches/${batch.id}/submit`, {});
    check("sent for approval -> 202", r.status === 202 && r.body.batch.status === "pending_approval", r.body);
    check("lines are frozen once sent (API) -> 409", (await add([{ kind: "gl", account_id: "acc_1100", debit: 1 }])).status === 409);
    let refused = false;
    try { await db.$executeRawUnsafe(`UPDATE "OpeningBatchLine" SET "debit" = 1 WHERE "batchId" = '${batch.id}'`); } catch { refused = true; }
    check("…and in the database", refused);
    const eqBefore = await glKey("opening_equity"), arBefore = await glKey("ar"), apBefore = await glKey("ap"), invBefore = await glKey("inventory");
    const pending = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === batch.id);
    check("in the approvals inbox", pending?.type === "accounting.opening_batch");
    check("the preparer cannot approve it -> 403", (await call("karim", "POST", `/api/approvals/${pending.id}/decide`, { decision: "approve" })).status === 403);
    // OPN-D13: the cut-over report before and after the batch posts.
    const ready = async () => Object.fromEntries(((await call("karim", "GET", "/api/accounting/cutover-readiness")).body.items ?? []).map((i: any) => [i.key, i]));
    const r0 = await ready();
    r = await approve(batch.id);
    d = await detail(batch.id);
    check("the owner approves -> posted", r.status === 200 && d.status === "posted", [r.status, r.body, d.status]);
    const r1 = await ready();
    const batchDoc = await db.inventoryDocument.findFirst({ where: { sourceId: `${batch.id}:stock` }, select: { number: true } });
    check("cut-over report: the batch's stock document is tagged with the batch", !!batchDoc);
    check("cut-over report: the batch's own stock document is not counted as a direct entry", r1.direct_opening_stock?.count === r0.direct_opening_stock?.count && !(r1.direct_opening_stock?.detail ?? []).some((x: any) => x.number === batchDoc?.number), [r0.direct_opening_stock?.count, r1.direct_opening_stock?.count]);
    check("cut-over report: the batch's customer and supplier lines are not counted as direct entries", r1.direct_party_opening?.count === r0.direct_party_opening?.count, [r0.direct_party_opening, r1.direct_party_opening]);
    check("cut-over report: opening equity is the ledger's 3300 balance, unchanged by a balanced batch", r1.opening_equity_zero?.value === r0.opening_equity_zero?.value && Math.abs(Number(r1.opening_equity_zero?.value) - (await glKey("opening_equity"))) < 0.005, [r0.opening_equity_zero?.value, r1.opening_equity_zero?.value]);
    const [atCut] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE a."systemKey" = 'opening_equity' AND e."date" <= ${today}`;
    check("cut-over report: 3300 as at the cut-over date is shown once a batch is posted", !!r1.opening_equity_at_cutover && Math.abs(Number(r1.opening_equity_at_cutover.value) - n(atCut?.b)) < 0.005, r1.opening_equity_at_cutover);
    check("cut-over report: sales cannot read it -> 403", (await call("mona", "GET", "/api/accounting/cutover-readiness")).status === 403);

    section("4. EVERYTHING LANDED, AND RECONCILES");
    check("opening equity nets to zero across the batch", Math.abs((await glKey("opening_equity")) - eqBefore) < 0.005, [eqBefore, await glKey("opening_equity")]);
    check("AR +10500 (12000 − 1500), AP −7300 (8000 − 700), inventory +1251.33 (the rounded total the stock ledger posts)", Math.abs((await glKey("ar")) - arBefore - 10500) < 0.005 && Math.abs((await glKey("ap")) - apBefore + 7300) < 0.005 && Math.abs((await glKey("inventory")) - invBefore - 1251.33) < 0.005, [await glKey("ar") - arBefore, await glKey("ap") - apBefore, await glKey("inventory") - invBefore]);
    const stmtClose = async (path: string) => (await call("karim", "GET", `${path}/statement?from=2000-01-01&to=2099-12-31`)).body;
    const c2 = await stmtClose(`/api/sales/customers/${customer2.id}`), s2 = await stmtClose(`/api/purchasing/suppliers/${supplier2.id}`);
    check("the customer's credit balance: one opening row, closing −1500 (we owe them)", c2.closing === "-1500.00" && c2.rows.length === 1 && c2.rows[0].kind === "opening_balance" && c2.rows[0].credit === "1500.00", c2);
    check("the supplier's advance: one opening row, closing −700 (they owe us)", s2.statement.closing === "-700.00" && s2.statement.rows.length === 1 && s2.statement.rows[0].debit === "700.00", s2.statement);
    const bsAfter = (await call("karim", "GET", `/api/accounting/balance-sheet?as_of=${today}`)).body;
    check("balance sheet: receivables +10500, payables +7300, and it still balances", Math.abs(bsLine(bsAfter, "assets", "1300") - bsLine(bsBefore, "assets", "1300") - 10500) < 0.005 && Math.abs(bsLine(bsAfter, "liabilities", "2100") - bsLine(bsBefore, "liabilities", "2100") - 7300) < 0.005 && bsAfter._balanced === true, [bsLine(bsBefore, "assets", "1300"), bsLine(bsAfter, "assets", "1300"), bsLine(bsBefore, "liabilities", "2100"), bsLine(bsAfter, "liabilities", "2100"), bsAfter._balanced]);
    const open = (await call("karim", "GET", `/api/accounting/customers/${customer.id}/open-invoices`)).body.invoices ?? [];
    check("the customer's opening item is open for collection (12000, its due date)", open.some((i: any) => n(i.open) === 12000), open);
    const st = (await call("karim", "GET", `/api/purchasing/suppliers/${supplier.id}/statement?from=2000-01-01&to=2099-12-31`)).body;
    check("the supplier's statement shows 8000 owed", n(st.payable ?? st.closing) === 8000, st);
    const assets = (await call("karim", "GET", `/api/assets?category_id=${cat.id}`)).body.assets;
    const van = assets[0];
    check("the van is in the register: cost 120000, accumulated 30000, book value 90000, in service", van?.cost === "120000.00" && van.accumulated === "30000.00" && van.bookValue === "90000.00" && van.status === "in_service", van);
    const vd = (await call("karim", "GET", `/api/assets/${van.id}`)).body.asset;
    check("…its depreciation carries on over what is left of its life (90000 / remaining months)", vd.schedule.length > 0 && Math.abs(n(vd.schedule[0].amount) * (60 - vd.openingMonthsUsed) - 90000) < 1, [vd.openingMonthsUsed, vd.schedule[0]]);
    const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
    check("integrity check green: AR, AP, inventory, fixed assets, trial balance, traceability", health.ok === true, health.checks.filter((c: any) => !c.ok));
    check("the direct opening-balance form is now closed -> 409", (await call("karim", "POST", "/api/accounting/opening-balances", { party_type: "customer", party_id: customer.id, date: today, amount: 1 })).status === 409);
    check("…and the direct opening-stock form -> 409", (await call("karim", "POST", "/api/accounting/opening-stock", { business_date: today, lines: [{ product_id: product.id, quantity: 1, unit_cost: 1 }] })).status === 409);
    check("a second initial batch -> 409", (await call("karim", "POST", "/api/accounting/opening-batches", { cutover_date: today })).status === 409);
    refused = false;
    try { await db.$executeRawUnsafe(`UPDATE "OpeningBatch" SET "status" = 'draft' WHERE "id" = '${batch.id}'`); } catch { refused = true; }
    check("DB: a posted batch stays posted", refused);
  }

  section("5. CORRECTIONS — APPROVED THE SAME WAY");
  let r = await call("karim", "POST", "/api/accounting/opening-batches", { kind: "correction" });
  const corr = r.body.batch;
  check("correction batch created on the original cut-over date", r.status === 201 && corr.kind === "correction", r.body);
  const addC = (lines: any[]) => call("karim", "POST", `/api/accounting/opening-batches/${corr.id}/lines`, { lines });
  check("a correction cannot carry stock -> 400", (await addC([{ kind: "stock", product_id: "x", quantity: 1, unit_cost: 1 }])).status === 400);
  r = await addC([{ kind: "customer", party_id: customer.id, amount: "-2000", reference: "تصحيح" }, { kind: "gl", account_id: "acc_3200", debit: "2000", description: "تصحيح أرباح محتجزة" }]);
  check("customer −2000 against retained earnings", r.status === 201, r.body);
  r = await call("karim", "POST", `/api/accounting/opening-batches/${corr.id}/submit`, {});
  check("sent", r.status === 202, r.body);
  r = await approve(corr.id, "reject");
  check("rejected -> back to draft, nothing posted", (await detail(corr.id)).status === "draft", r.body);
  await call("karim", "POST", `/api/accounting/opening-batches/${corr.id}/submit`, {});
  const arBefore = await glKey("ar");
  r = await approve(corr.id);
  check("approved -> posted; AR down 2000", (await detail(corr.id)).status === "posted" && Math.abs((await glKey("ar")) - arBefore + 2000) < 0.005, r.body);
  r = await call("karim", "POST", "/api/accounting/opening-batches", { kind: "correction" });
  const drop = r.body.batch;
  r = await call("karim", "POST", `/api/accounting/opening-batches/${drop.id}/cancel`, { reason: "مش محتاجينها" });
  check("a draft correction can be cancelled", r.status === 200 && r.body.batch.status === "cancelled", r.body);
  check("…and stays cancelled (cannot be submitted)", (await call("karim", "POST", `/api/accounting/opening-batches/${drop.id}/submit`, {})).status === 409);
  const tb = (await call("karim", "GET", "/api/accounting/trial-balance?from=2000-01-01&to=2099-12-31")).body.trialBalance;
  check("trial balance balances", tb.balanced === true);
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("integrity check green after the corrections", health.ok === true, health.checks.filter((c: any) => !c.ok));

  await db.$disconnect();
  finish("OPENING BATCH");
}

main().catch((e) => { console.error(e); process.exit(1); });
