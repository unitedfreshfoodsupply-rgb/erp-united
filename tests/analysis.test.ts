/* Comparative statements, financial ratios and bank-statement matching.
   Comparatives: every figure is checked against raw SQL over the same range and its
   comparison range (prior period / prior year, leap day included); ratios against their
   stated basis. Matching: same amount, nearest date within the tolerance, the reference
   breaks ties, two equally good candidates are left alone, nothing is ticked on preview,
   the reconciliation completes only at zero difference, and an open reconciliation can be
   found again after a reload. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";
import { comparisonRange } from "@/lib/accounting/comparatives";

const TAG = `ZZAN${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const n = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["karim", "mona", "mostafa"]) await login(u);
  const today = todayBiz();

  section("1. COMPARISON RANGES");
  const pp = comparisonRange("2026-03-01", "2026-03-31", "prior_period");
  check("prior period of March (31 days) = the 31 days before it", pp.from === "2026-01-29" && pp.to === "2026-02-28", pp);
  const py = comparisonRange("2024-02-29", "2024-12-31", "prior_year");
  check("prior year of a range starting on a leap day starts on 28 February", py.from === "2023-02-28" && py.to === "2023-12-31", py);

  section("2. COMPARATIVE STATEMENTS = RAW LEDGER");
  const from = `${today.slice(0, 4)}-01-01`;
  for (const compare of ["prior_year", "prior_period"]) {
    const r = await call("karim", "GET", `/api/accounting/comparatives?from=${from}&to=${today}&compare=${compare}`);
    const rep = r.body.report;
    check(`${compare}: 200 with both ranges`, r.status === 200 && rep.current.from === from && !!rep.comparison.from, r.body);
    for (const [label, range, tot] of [["current", rep.current, rep.profitAndLoss.current], ["comparison", rep.comparison, rep.profitAndLoss.comparison]] as const) {
      const [raw] = await db.$queryRaw<{ rev: Prisma.Decimal; exp: Prisma.Decimal; cogs: Prisma.Decimal }[]>`
        SELECT coalesce(sum(CASE WHEN a."type" = 'revenue' THEN l."credit" - l."debit" END), 0) AS rev, coalesce(sum(CASE WHEN a."type" = 'expense' THEN l."debit" - l."credit" END), 0) AS exp,
               coalesce(sum(CASE WHEN a."systemKey" = 'cogs' THEN l."debit" - l."credit" END), 0) AS cogs
        FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
        WHERE e."date" BETWEEN ${range.from} AND ${range.to} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')`;
      check(`${compare} ${label}: revenue, cost of sales, expenses, net = raw`, near(n(tot.revenue), n(raw.rev)) && near(n(tot.costOfSales), n(raw.cogs)) && near(n(tot.expenses), n(raw.exp)) && near(n(tot.netIncome), n(raw.rev) - n(raw.exp)), [tot, raw]);
    }
    const sumLines = (k: "current" | "comparison") => rep.profitAndLoss.lines.reduce((s: number, l: any) => s + (l.type === "revenue" ? n(l[k]) : -n(l[k])), 0);
    check(`${compare}: the account lines add up to the net result on both sides`, near(sumLines("current"), n(rep.profitAndLoss.current.netIncome)) && near(sumLines("comparison"), n(rep.profitAndLoss.comparison.netIncome)));
    check(`${compare}: each variance = current − comparison`, rep.profitAndLoss.lines.every((l: any) => near(n(l.variance), n(l.current) - n(l.comparison))));
    const [bs] = await db.$queryRaw<{ a: Prisma.Decimal; li: Prisma.Decimal; fixed: Prisma.Decimal }[]>`
      SELECT coalesce(sum(CASE WHEN a."type" = 'asset' THEN l."debit" - l."credit" END), 0) AS a, coalesce(sum(CASE WHEN a."type" = 'liability' THEN l."credit" - l."debit" END), 0) AS li,
             coalesce(sum(CASE WHEN a."type" = 'asset' AND (a."controlledBy" = 'fixed_assets' OR a."parentId" = 'acc_1700' OR a."id" = 'acc_1700') THEN l."debit" - l."credit" END), 0) AS fixed
      FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId" WHERE e."date" <= ${today}`;
    check(`${compare}: balance sheet at the end — assets and liabilities = raw, and it balances`, near(n(rep.balanceSheet.current.assets), n(bs.a)) && near(n(rep.balanceSheet.current.liabilities), n(bs.li)) && rep.balanceSheet.current.balanced === true && rep.balanceSheet.comparison.balanced === true, [rep.balanceSheet.current, bs]);
    const cr = n(bs.li) === 0 ? null : ((n(bs.a) - n(bs.fixed)) / n(bs.li)).toFixed(2);
    check(`${compare}: current ratio on its stated basis ((assets − fixed) ÷ liabilities = ${cr})`, rep.ratios.current.currentRatio === cr, [rep.ratios.current.currentRatio, cr]);
  }
  check("an inverted range -> 400", (await call("karim", "GET", `/api/accounting/comparatives?from=${today}&to=${from}`)).status === 400 || from === today);
  check("sales cannot read the comparatives -> 403", (await call("mona", "GET", `/api/accounting/comparatives?from=${from}&to=${today}`)).status === 403);

  section("3. BANK STATEMENT MATCHING");
  const bank = (await call("karim", "POST", "/api/accounting/cash-accounts", { type: "bank", name: `${TAG} Bank`, name_ar: `${TAG} بنك`, bank_name: "T" })).body.cashAccount;
  check("a fresh bank account", !!bank?.id, bank);
  bank.accountId = (await db.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).accountId;
  const je = (date: string, amount: number, description: string) => call("karim", "POST", "/api/accounting/journals", { date, description, lines: amount > 0 ? [{ account_id: bank.accountId, debit: amount }, { account_id: "acc_3100", credit: amount }] : [{ account_id: "acc_6100", debit: -amount }, { account_id: bank.accountId, credit: -amount }] });
  const d = (k: number) => addDays(today, -k);
  for (const [k, amt, desc] of [[5, 1000, `${TAG} إيداع أ`], [5, 1000, `${TAG} إيداع ب`], [3, -250, `${TAG} مصروف بنكي`], [2, 777, `${TAG} تحويل`], [1, 500, `${TAG} INV-77 تحصيل`], [1, 500, `${TAG} تحصيل آخر`]] as const) {
    const r = await je(d(k), amt, desc);
    if (r.status !== 201) check(`posting ${desc}`, false, r.body);
  }
  const statementBalance = 1000 + 1000 - 250 + 777 + 500 + 500;
  let r = await call("karim", "POST", "/api/accounting/reconciliations", { cash_account_id: bank.id, statement_date: today, statement_balance: String(statementBalance) });
  const rec = r.body.reconciliation;
  check("reconciliation started", r.status === 201 && !!rec?.id, r.body);
  check("a garbage statement balance -> 400 (not a 500)", (await call("karim", "POST", "/api/accounting/reconciliations", { cash_account_id: "bank_main", statement_date: today, statement_balance: "abc" })).status === 400);
  const list = (await call("karim", "GET", "/api/accounting/reconciliations")).body.reconciliations;
  check("the open reconciliation can be found again (resume after a reload)", list.some((x: any) => x.id === rec.id && x.status === "open"), list);
  const csv = [`date,amount,reference`, `${d(4)},1000.00,`, `${d(3)},-250,`, `${d(1)},777,`, `${d(1)},500,INV-77`, `${today},55.10,FEE`, `not-a-date,12,x`].join("\n");
  r = await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/match`, { csv });
  const pv = r.body.result;
  check("preview: 5 lines read, 1 unreadable", r.status === 200 && pv.statementLines === 5 && pv.parseErrors.length === 1, r.body);
  check("…−250, 777 and the INV-77 500 matched (the reference picks one of two equal 500s)", pv.matched.length === 3 && pv.matched.some((m: any) => m.amount === "500.00"), pv.matched);
  check("…the 1000 has two equally good candidates: left to the accountant (ambiguous)", pv.ambiguous.length === 1 && pv.ambiguous[0].candidates.length === 2, pv.ambiguous);
  check("…55.10 is on the statement but not in the books", pv.unmatchedStatement.length === 1 && pv.unmatchedStatement[0].amount === "55.10", pv.unmatchedStatement);
  const inv77 = await db.journalLine.findFirst({ where: { accountId: bank.accountId, entry: { description: `${TAG} INV-77 تحصيل` } } });
  check("…the 500 chosen is the INV-77 one", pv.matched.some((m: any) => m.lineId === inv77?.id), [pv.matched, inv77?.id]);
  let view = (await call("karim", "GET", `/api/accounting/reconciliations/${rec.id}`)).body.reconciliation;
  check("…a preview ticks nothing", n(view.clearedBalance) === 0, view.clearedBalance);
  r = await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/match`, { csv, apply: true });
  view = (await call("karim", "GET", `/api/accounting/reconciliations/${rec.id}`)).body.reconciliation;
  check("apply: 3 lines ticked, cleared = −250 + 777 + 500 = 1027", r.body.result?.applied === 3 && near(n(view.clearedBalance), 1027), [r.body.result?.applied, view.clearedBalance]);
  const re = (await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/match`, { csv, apply: true })).body.result;
  check("importing the same statement again ticks nothing more: its 3 lines are recognised as already cleared", re?.applied === 0 && re.alreadyCleared.length === 3 && re.matched.length === 0, re);
  check("completing with a difference -> 409", (await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/complete`, {})).status === 409);
  const rest = view.lines.filter((l: any) => !l.cleared).map((l: any) => l.id);
  await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/mark`, { line_ids: rest, cleared: true });
  // Racing the completion against unticking a line: never completes with a difference.
  const one = rest[0];
  const race = await Promise.all([call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/complete`, {}), call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/mark`, { line_ids: [one], cleared: false })]);
  const after = await db.bankReconciliation.findUniqueOrThrow({ where: { id: rec.id } });
  const cleared = await db.journalLine.aggregate({ where: { reconciliationId: rec.id }, _sum: { debit: true, credit: true } });
  const clearedNow = n(cleared._sum.debit) - n(cleared._sum.credit);
  check("complete vs untick at once: no 500, and a completed reconciliation always balances", race.every((x) => x.status < 500) && (after.status !== "completed" || near(clearedNow, statementBalance)), [race.map((x) => x.status), after.status, clearedNow]);
  if (after.status !== "completed") {
    await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/mark`, { line_ids: [one], cleared: true });
    check("…completed once balanced", (await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/complete`, {})).status === 200);
  }
  check("matching on a completed reconciliation -> 409", (await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/match`, { csv })).status === 409);
  check("the floor cannot match statements -> 403", (await call("mostafa", "POST", `/api/accounting/reconciliations/${rec.id}/match`, { csv })).status === 403);
  check("an empty statement -> 400", (await call("karim", "POST", `/api/accounting/reconciliations/${rec.id}/match`, { csv: "date,amount\n" })).status === 400);

  section("4. PHYSICAL ASSET COUNT");
  const SUF = String(Date.now()).slice(-6);
  const cat = (await call("karim", "POST", "/api/assets/categories", { code: `AN${SUF}`, name: `${TAG} Scales`, name_ar: `${TAG} موازين`, useful_life_months: 24, residual_percent: 0, depreciation_start: "same_month" })).body.category;
  const mkAsset = async (name: string) => (await call("karim", "POST", "/api/assets", { category_id: cat.id, name: `${TAG} ${name}`, cost: "1200", acquisition_date: today, in_service_date: today, cash_account_id: "bank_main", location: "مخزن 1" })).body.asset;
  const s1 = await mkAsset("ميزان 1"), s2 = await mkAsset("ميزان 2"), s3 = await mkAsset("ميزان 3");
  check("three assets to count", !!s1?.id && !!s2?.id && !!s3?.id, [s1, s2, s3]);
  const jeBefore = await db.journalEntry.count();
  const key = `${TAG}-count-1`;
  const body = { date: today, idempotency_key: key, lines: [{ asset_id: s1.id, found: true, condition: "good", location: "مخزن 1" }, { asset_id: s2.id, found: true, condition: "damaged", location: "مخزن 2" }, { asset_id: s3.id, found: false }] };
  r = await call("karim", "POST", "/api/assets/counts", body);
  check("count recorded for 3 assets", r.status === 201 && r.body.count.recorded === 3, r.body);
  check("…posting nothing to the ledger", (await db.journalEntry.count()) === jeBefore);
  const again = await Promise.all([1, 2].map(() => call("karim", "POST", "/api/assets/counts", body)));
  check("the same count sent again (twice at once) is not recorded twice", again.every((x) => x.status < 300 && x.body.count.replayed === true) && (await db.assetEvent.count({ where: { type: "count", assetId: { in: [s1.id, s2.id, s3.id] } } })) === 3, again.map((x) => [x.status, x.body]));
  const cr = (await call("karim", "GET", "/api/assets/counts")).body.report;
  const flag = (id: string) => cr.rows.find((x: any) => x.assetId === id)?.flag;
  check("report: ok / damaged / missing", flag(s1.id) === "ok" && flag(s2.id) === "damaged" && flag(s3.id) === "missing", [flag(s1.id), flag(s2.id), flag(s3.id)]);
  check("…the missing asset is still on the books (nothing written off by a count)", (await db.fixedAsset.findUnique({ where: { id: s3.id } }))?.status === "in_service");
  r = await call("karim", "POST", "/api/assets/counts", { date: today, lines: [{ asset_id: s3.id, found: true, location: "مخزن 3" }] });
  check("a later count finds it elsewhere -> flag 'elsewhere'", r.status === 201 && (await call("karim", "GET", "/api/assets/counts")).body.report.rows.find((x: any) => x.assetId === s3.id)?.flag === "elsewhere");
  check("a count in the future -> 400", (await call("karim", "POST", "/api/assets/counts", { date: addDays(today, 3), lines: [{ asset_id: s1.id, found: true }] })).status === 400);
  check("the same asset twice in one count -> 400", (await call("karim", "POST", "/api/assets/counts", { date: today, lines: [{ asset_id: s1.id, found: true }, { asset_id: s1.id, found: false }] })).status === 400);
  check("an unknown asset -> 404", (await call("karim", "POST", "/api/assets/counts", { date: today, lines: [{ asset_id: "nope", found: true }] })).status === 404);
  check("sales cannot record a count -> 403", (await call("mona", "POST", "/api/assets/counts", body)).status === 403);
  await call("karim", "POST", `/api/assets/${s1.id}/dispose`, { kind: "scrap", date: today, reason: `${TAG} تخريد` });
  check("a disposed asset is not counted -> 409", (await call("karim", "POST", "/api/assets/counts", { date: today, lines: [{ asset_id: s1.id, found: true }] })).status === 409);

  await db.$disconnect();
  finish("ANALYSIS & BANK MATCHING");
}

main().catch((e) => { console.error(e); process.exit(1); });
