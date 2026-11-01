/* Independent ledger audit — recomputes the books straight from the tables with its own SQL
   and compares them with what the application reports. It reuses no application code: every
   figure on the "expected" side comes from a query written here.
     source document → journal → trial balance → P&L → balance sheet → cash flow,
     subledgers (AR/AP by party, inventory layers, asset register, VAT returns),
     period and year locks, reversals, cost centers, traceability.
   Run it last on a database the other suites have filled: it checks whatever is there. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const { check, section, finish } = makeChecker();
const n = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) < tol;

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  await login("karim");
  const today = todayBiz();
  const q = <T>(sql: Prisma.Sql) => db.$queryRaw<T[]>(sql);

  section("1. JOURNAL ENTRIES ARE WELL FORMED");
  const unbalanced = await q<{ id: string }>(Prisma.sql`
    SELECT e."id" FROM "JournalEntry" e JOIN "JournalLine" l ON l."entryId" = e."id"
    GROUP BY e."id", e."total" HAVING sum(l."debit") <> sum(l."credit") OR sum(l."debit") <> e."total"`);
  check("every entry: Σ debit = Σ credit = its stated total", unbalanced.length === 0, unbalanced.slice(0, 5));
  const badLines = await q<{ id: string }>(Prisma.sql`
    SELECT "id" FROM "JournalLine" WHERE "debit" < 0 OR "credit" < 0 OR ("debit" > 0 AND "credit" > 0) OR ("debit" = 0 AND "credit" = 0)`);
  check("every line is one-sided, positive and non-zero", badLines.length === 0, badLines.slice(0, 5));
  const empty = await q<{ id: string }>(Prisma.sql`SELECT e."id" FROM "JournalEntry" e WHERE NOT EXISTS (SELECT 1 FROM "JournalLine" l WHERE l."entryId" = e."id")`);
  check("no entry without lines", empty.length === 0, empty.slice(0, 5));
  const cents = await q<{ id: string }>(Prisma.sql`SELECT "id" FROM "JournalLine" WHERE "debit" <> round("debit", 2) OR "credit" <> round("credit", 2)`);
  check("no line carries more than two decimals", cents.length === 0, cents.slice(0, 5));
  const dupNumbers = await q<{ number: string }>(Prisma.sql`SELECT "number" FROM "JournalEntry" GROUP BY "number" HAVING count(*) > 1`);
  check("journal numbers are unique", dupNumbers.length === 0, dupNumbers);
  const dupSources = await q<{ sourceType: string; sourceId: string }>(Prisma.sql`
    SELECT "sourceType", "sourceId" FROM "JournalEntry" WHERE "sourceType" NOT IN ('manual') GROUP BY "sourceType", "sourceId" HAVING count(*) > 1`);
  check("no source document posted twice (sourceType, sourceId)", dupSources.length === 0, dupSources.slice(0, 5));
  const postableOnly = await q<{ id: string }>(Prisma.sql`SELECT l."id" FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE NOT a."postable"`);
  check("no line on a header (non-postable) account", postableOnly.length === 0, postableOnly.slice(0, 5));

  section("2. REVERSALS MIRROR WHAT THEY REVERSE");
  const badRev = await q<{ id: string }>(Prisma.sql`
    WITH r AS (
      SELECT e."id", e."reversalOfId" FROM "JournalEntry" e WHERE e."reversalOfId" IS NOT NULL
      UNION ALL SELECT t."reversalEntryId", t."entryId" FROM "CashTransfer" t WHERE t."reversalEntryId" IS NOT NULL
      UNION ALL SELECT v."voidEntryId", v."entryId" FROM "VatReturn" v WHERE v."voidEntryId" IS NOT NULL AND v."entryId" IS NOT NULL
      UNION ALL SELECT d."reversalEntryId", d."entryId" FROM "DepreciationRun" d WHERE d."reversalEntryId" IS NOT NULL
      UNION ALL SELECT ro."id", co."id" FROM "JournalEntry" ro JOIN "JournalEntry" co ON co."sourceType" = 'year_end_close' AND co."sourceId" = ro."sourceId" WHERE ro."sourceType" = 'year_end_reopen'),
    a AS (SELECT r."id", l."accountId", l."costCenterId" AS cc, l."partyId" AS party, sum(l."debit" - l."credit") AS v FROM r JOIN "JournalLine" l ON l."entryId" = r."id" GROUP BY 1, 2, 3, 4),
    b AS (SELECT r."id", l."accountId", l."costCenterId" AS cc, l."partyId" AS party, sum(l."credit" - l."debit") AS v FROM r JOIN "JournalLine" l ON l."entryId" = r."reversalOfId" GROUP BY 1, 2, 3, 4)
    SELECT coalesce(a."id", b."id") AS id FROM a FULL JOIN b ON a."id" = b."id" AND a."accountId" = b."accountId" AND a.cc IS NOT DISTINCT FROM b.cc AND a.party IS NOT DISTINCT FROM b.party
    WHERE coalesce(a.v, 0) <> coalesce(b.v, 0)`);
  check("each reversal is the exact negative of its original, by account, cost center and party", badRev.length === 0, badRev.slice(0, 5));
  const twice = await q<{ reversalOfId: string }>(Prisma.sql`SELECT "reversalOfId" FROM "JournalEntry" WHERE "reversalOfId" IS NOT NULL GROUP BY "reversalOfId" HAVING count(*) > 1`);
  check("no entry reversed twice", twice.length === 0, twice);

  section("3. TRIAL BALANCE, P&L, BALANCE SHEET — RAW vs REPORTED");
  const [tb] = await q<{ d: Prisma.Decimal; c: Prisma.Decimal }>(Prisma.sql`SELECT coalesce(sum("debit"), 0) AS d, coalesce(sum("credit"), 0) AS c FROM "JournalLine"`);
  check("whole ledger: Σ debit = Σ credit", n(tb.d) === n(tb.c), tb);
  const from = `${today.slice(0, 4)}-01-01`;
  const apiTb = (await call("karim", "GET", `/api/accounting/trial-balance?from=${from}&to=${today}`)).body.trialBalance;
  const [rawTbRange] = await q<{ d: Prisma.Decimal; c: Prisma.Decimal }>(Prisma.sql`
    SELECT coalesce(sum(l."debit"), 0) AS d, coalesce(sum(l."credit"), 0) AS c FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE e."date" BETWEEN ${from} AND ${today}`);
  check("trial balance (year to date): reported movements = raw movements and it balances", apiTb?.balanced === true && near(n(apiTb.totals.debit), n(rawTbRange.d)) && near(n(apiTb.totals.credit), n(rawTbRange.c)), [apiTb?.totals, rawTbRange]);

  const [rawPl] = await q<{ rev: Prisma.Decimal; exp: Prisma.Decimal }>(Prisma.sql`
    SELECT coalesce(sum(CASE WHEN a."type" = 'revenue' THEN l."credit" - l."debit" END), 0) AS rev,
           coalesce(sum(CASE WHEN a."type" = 'expense' THEN l."debit" - l."credit" END), 0) AS exp
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE e."date" BETWEEN ${from} AND ${today} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')`);
  const pl = (await call("karim", "GET", `/api/accounting/pnl?from=${from}&to=${today}`)).body;
  check("P&L (year to date): revenue, expenses and net = raw", near(n(pl.revenue), n(rawPl.rev)) && near(n(pl.expenses), n(rawPl.exp)) && near(n(pl.netIncome), n(rawPl.rev) - n(rawPl.exp)), [pl.revenue, pl.expenses, rawPl]);

  const sums = await q<{ type: string; s: Prisma.Decimal }>(Prisma.sql`
    SELECT a."type", coalesce(sum(l."debit" - l."credit"), 0) AS s FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE e."date" <= ${today} GROUP BY a."type"`);
  const by = (t: string) => n(sums.find((x) => x.type === t)?.s);
  const assets = by("asset"), liabilities = -by("liability"), equity = -by("equity"), result = -(by("revenue") + by("expense"));
  check("raw accounting equation: assets = liabilities + equity + unclosed result", near(assets, liabilities + equity + result), { assets, liabilities, equity, result });
  const bs = (await call("karim", "GET", `/api/accounting/balance-sheet?as_of=${today}`)).body;
  check("balance sheet: total assets = raw (signed)", near(n(bs.totalAssets), assets), [bs.totalAssets, assets]);
  check("…liabilities + equity = raw (signed), and it says it balances", near(n(bs.totalLiabilitiesAndEquity), liabilities + equity + result) && bs._balanced === true, [bs.totalLiabilitiesAndEquity, liabilities + equity + result, bs._balanced]);
  check("…liabilities are a net credit (the report shows them unsigned)", liabilities >= 0, liabilities);

  section("4. CASH FLOW RECONCILES TO THE CASH ACCOUNTS");
  const [cash] = await q<{ o: Prisma.Decimal; c: Prisma.Decimal }>(Prisma.sql`
    WITH ca AS (SELECT DISTINCT "accountId" FROM "CashAccount")
    SELECT coalesce(sum(CASE WHEN e."date" < ${from} THEN l."debit" - l."credit" END), 0) AS o, coalesce(sum(l."debit" - l."credit"), 0) AS c
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE l."accountId" IN (SELECT "accountId" FROM ca) AND e."date" <= ${today}`);
  const cf = (await call("karim", "GET", `/api/management/cash-flow?from=${from}&to=${today}`)).body.report;
  const [openingCash] = await q<{ v: Prisma.Decimal }>(Prisma.sql`
    SELECT coalesce(sum(l."debit" - l."credit"), 0) AS v FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE l."accountId" IN (SELECT "accountId" FROM "CashAccount") AND e."date" BETWEEN ${from} AND ${today}
      AND (e."sourceType" IN ('opening_balance', 'opening_batch') OR e."id" IN (SELECT ol."entryId" FROM "JournalLine" ol JOIN "Account" oa ON oa."id" = ol."accountId" WHERE oa."systemKey" = 'opening_equity'))`);
  check("closing cash = raw balance of every cash/bank account", near(n(cf.cashTotal.closing), n(cash.c)), [cf.cashTotal, cash]);
  check("opening cash = raw balance before the range + cash brought in by openings inside it", near(n(cf.cashTotal.opening), n(cash.o) + n(openingCash.v)), [cf.cashTotal.opening, n(cash.o), n(openingCash.v)]);
  check("operating + investing + financing = the change in cash", cf._balanced === true && near(n(cf.netCashFlow), n(cf.cashTotal.change)), [cf.netCashFlow, cf.cashTotal]);
  check("cash-flow net income = P&L net income for the range", near(n(cf.netIncome), n(pl.netIncome)), [cf.netIncome, pl.netIncome]);

  section("5. SUBLEDGERS");
  const noParty = await q<{ id: string }>(Prisma.sql`
    SELECT l."id" FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" IN ('ar', 'ap') AND (l."partyId" IS NULL OR l."partyType" IS NULL)`);
  check("every AR/AP line names its customer or supplier", noParty.length === 0, noParty.slice(0, 5));
  const wrongParty = await q<{ id: string }>(Prisma.sql`
    SELECT l."id" FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId"
    WHERE (a."systemKey" = 'ar' AND l."partyType" <> 'customer') OR (a."systemKey" = 'ap' AND l."partyType" <> 'supplier')`);
  check("…and the right kind of party (AR customers, AP suppliers)", wrongParty.length === 0, wrongParty.slice(0, 5));
  const parties = await q<{ partyId: string; b: Prisma.Decimal }>(Prisma.sql`
    SELECT l."partyId", sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."systemKey" = 'ar' GROUP BY l."partyId" HAVING sum(l."debit" - l."credit") <> 0 ORDER BY abs(sum(l."debit" - l."credit")) DESC LIMIT 5`);
  for (const p of parties) {
    const st = (await call("karim", "GET", `/api/sales/customers/${p.partyId}/statement?from=2000-01-01&to=2099-12-31`)).body;
    const closing = n(st.closing);
    check(`customer ${p.partyId.slice(-6)}: statement closing = Σ of its AR lines (${n(p.b).toFixed(2)})`, near(closing, n(p.b)), [closing, n(p.b), Object.keys(st ?? {})]);
  }
  const sup = await q<{ partyId: string; b: Prisma.Decimal }>(Prisma.sql`
    SELECT l."partyId", sum(l."credit" - l."debit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."systemKey" = 'ap' GROUP BY l."partyId" HAVING sum(l."credit" - l."debit") <> 0 ORDER BY abs(sum(l."credit" - l."debit")) DESC LIMIT 5`);
  for (const p of sup) {
    const st = (await call("karim", "GET", `/api/purchasing/suppliers/${p.partyId}/statement?from=2000-01-01&to=2099-12-31`)).body;
    const closing = n(st.payable ?? st.closing);
    check(`supplier ${p.partyId.slice(-6)}: statement balance = Σ of its AP lines (${n(p.b).toFixed(2)})`, near(closing, n(p.b)), [closing, n(p.b)]);
  }
  // Inventory: the GL equals the stock ledger's value of every posted movement, within the
  // cent each valuation entry may round per counter account.
  const [inv] = await q<{ gl: Prisma.Decimal; layers: Prisma.Decimal; entries: bigint }>(Prisma.sql`
    SELECT (SELECT coalesce(sum(l."debit" - l."credit"), 0) FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = 'inventory') AS gl,
           (SELECT coalesce(sum(v."value"), 0) FROM "StockValuationLayer" v JOIN "StockValuationPosting" p ON p."movementId" = v."movementId" WHERE p."entryId" IS NOT NULL) AS layers,
           (SELECT count(DISTINCT "entryId") FROM "StockValuationPosting" WHERE "entryId" IS NOT NULL) AS entries`);
  const invDiff = Math.abs(n(inv.gl) - n(inv.layers));
  check(`inventory GL ≈ Σ posted valuation layers (diff ${invDiff.toFixed(4)} over ${inv.entries} entries; ≤ rounding)`, invDiff <= Number(inv.entries) * 0.015 + 0.005, inv);
  const unposted = await q<{ c: bigint }>(Prisma.sql`SELECT count(*) AS c FROM "StockValuationLayer" v WHERE v."value" <> 0 AND NOT EXISTS (SELECT 1 FROM "StockValuationPosting" p WHERE p."movementId" = v."movementId")`);
  check("every valued stock movement reached the ledger", Number(unposted[0].c) === 0, unposted);

  section("6. FIXED ASSETS — REGISTER vs LEDGER, ASSET BY ASSET");
  const reg = await q<{ assetAccountId: string; cost: Prisma.Decimal; accumulatedAccountId: string | null; acc: Prisma.Decimal }>(Prisma.sql`
    SELECT c."assetAccountId", c."accumulatedAccountId", coalesce(sum(f."cost") FILTER (WHERE f."status" <> 'disposed'), 0) AS cost, coalesce(sum(f."accumulated") FILTER (WHERE f."status" <> 'disposed'), 0) AS acc
    FROM "AssetCategory" c LEFT JOIN "FixedAsset" f ON f."categoryId" = c."id" GROUP BY c."assetAccountId", c."accumulatedAccountId"`);
  const glOf = async (id: string | null) => { if (!id) return 0; const [r] = await q<{ b: Prisma.Decimal }>(Prisma.sql`SELECT coalesce(sum("debit" - "credit"), 0) AS b FROM "JournalLine" WHERE "accountId" = ${id}`); return n(r.b); };
  const costByAcc = new Map<string, number>(), accByAcc = new Map<string, number>();
  for (const r of reg) { costByAcc.set(r.assetAccountId, (costByAcc.get(r.assetAccountId) ?? 0) + n(r.cost)); if (r.accumulatedAccountId) accByAcc.set(r.accumulatedAccountId, (accByAcc.get(r.accumulatedAccountId) ?? 0) + n(r.acc)); }
  for (const [acc, cost] of costByAcc) check(`asset account ${acc}: GL = Σ cost of assets not disposed (${cost.toFixed(2)})`, near(await glOf(acc), cost), [await glOf(acc), cost]);
  for (const [acc, a] of accByAcc) check(`accumulated depreciation ${acc}: GL = −Σ accumulated (${a.toFixed(2)})`, near(await glOf(acc), -a), [await glOf(acc), -a]);
  const accDrift = await q<{ id: string }>(Prisma.sql`
    SELECT f."id" FROM "FixedAsset" f WHERE f."status" <> 'disposed'
      AND f."accumulated" <> f."openingAccumulated" + coalesce((SELECT sum(d."amount") FROM "AssetDepreciationLine" d WHERE d."assetId" = f."id" AND NOT d."reversed"), 0)`);
  check("each asset's accumulated = opening accumulated + its live (non-reversed) depreciation lines", accDrift.length === 0, accDrift.slice(0, 5));
  const overDep = await q<{ id: string }>(Prisma.sql`SELECT "id" FROM "FixedAsset" WHERE "accumulated" > "cost" - "residualValue" + 0.01 AND "status" <> 'disposed'`);
  check("no asset depreciated below its residual value", overDep.length === 0, overDep.slice(0, 5));
  const dupMonth = await q<{ assetId: string }>(Prisma.sql`SELECT "assetId" FROM "AssetDepreciationLine" WHERE NOT "reversed" GROUP BY "assetId", "period" HAVING count(*) > 1`);
  check("no asset depreciated twice for one month", dupMonth.length === 0, dupMonth);
  const runs = await q<{ id: string }>(Prisma.sql`
    SELECT r."id" FROM "DepreciationRun" r WHERE r."total" <> (SELECT coalesce(sum(d."amount"), 0) FROM "AssetDepreciationLine" d WHERE d."runId" = r."id")
       OR r."total" <> (SELECT coalesce(sum(l."debit"), 0) FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE l."entryId" = r."entryId" AND a."type" = 'expense')`);
  check("every depreciation run: total = its asset lines = the expense it posted", runs.length === 0, runs.slice(0, 5));
  const revRuns = await q<{ id: string }>(Prisma.sql`
    SELECT r."id" FROM "DepreciationRun" r WHERE r."reversalEntryId" IS NOT NULL AND (
      EXISTS (SELECT 1 FROM "AssetDepreciationLine" d WHERE d."runId" = r."id" AND NOT d."reversed")
      OR (SELECT coalesce(sum(l."credit"), 0) FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE l."entryId" = r."reversalEntryId" AND a."type" = 'expense') <> r."total")`);
  check("every reversed run: all its lines set aside, and its reversal took back exactly its expense", revRuns.length === 0, revRuns);

  section("7. VAT RETURNS — FIGURES vs THEIR SETTLEMENT ENTRIES");
  const rets = await db.vatReturn.findMany({ where: { status: { not: "voided" } }, include: { entry: { include: { lines: { include: { account: true } } } } } });
  let vatOk = true; const vatBad: unknown[] = [];
  for (const r of rets) {
    const net = (k: string) => (r.entry?.lines ?? []).filter((l) => l.account.systemKey === k).reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
    const ok = near(net("vat_output"), n(r.outputTax)) && near(net("vat_input"), -n(r.inputUsed)) && near(net("vat_payable"), -n(r.payable))
      && near(n(r.outputTax) - n(r.inputUsed), n(r.payable)) && n(r.inputUsed) <= n(r.inputTax) + 0.005 && near(n(r.inputTax) - n(r.inputUsed), n(r.carryForward));
    if (!ok) { vatOk = false; vatBad.push({ n: r.number, out: r.outputTax, inp: r.inputTax, used: r.inputUsed, pay: r.payable, cf: r.carryForward }); }
  }
  check(`every live return (${rets.length}): settlement lines = its figures; output − input used = payable; carry-forward = input − used`, vatOk, vatBad);
  const overlap = await q<{ a: string }>(Prisma.sql`
    SELECT x."number" AS a FROM "VatReturn" x JOIN "VatReturn" y ON x."id" < y."id" AND x."status" <> 'voided' AND y."status" <> 'voided' AND x."periodFrom" <= y."periodTo" AND y."periodFrom" <= x."periodTo"`);
  check("no two live returns overlap", overlap.length === 0, overlap);
  const vatInFiled = await q<{ id: string }>(Prisma.sql`
    SELECT l."id" FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    JOIN "VatReturn" r ON r."status" <> 'voided' AND e."date" BETWEEN r."periodFrom" AND r."periodTo"
    WHERE a."systemKey" IN ('vat_input', 'vat_output') AND e."sourceType" <> 'vat_settlement' AND e."createdAt" > r."filedAt"`);
  check("no VAT line entered a period after its return was filed", vatInFiled.length === 0, vatInFiled.slice(0, 5));

  section("8. PERIODS AND YEARS");
  const late = await q<{ number: string }>(Prisma.sql`
    SELECT e."number" FROM "JournalEntry" e JOIN "AccountingPeriod" p ON p."code" = substr(e."date", 1, 7)
    WHERE p."status" = 'closed' AND p."closedAt" IS NOT NULL AND e."createdAt" > p."closedAt"`);
  check("nothing was posted into a month after it was (last) closed", late.length === 0, late.slice(0, 5));
  const openInClosedYear = await q<{ code: string }>(Prisma.sql`
    SELECT p."code" FROM "AccountingPeriod" p JOIN "FiscalYear" y ON y."status" = 'closed' AND p."startDate" >= y."startDate" AND p."endDate" <= y."endDate" WHERE p."status" <> 'closed'`);
  check("a closed fiscal year has no open month", openInClosedYear.length === 0, openInClosedYear);
  const leftover = await q<{ code: string; b: Prisma.Decimal }>(Prisma.sql`
    SELECT y."code", sum(l."debit" - l."credit") AS b FROM "FiscalYear" y JOIN "JournalEntry" e ON e."date" BETWEEN y."startDate" AND y."endDate"
    JOIN "JournalLine" l ON l."entryId" = e."id" JOIN "Account" a ON a."id" = l."accountId"
    WHERE y."status" = 'closed' AND a."type" IN ('revenue', 'expense') GROUP BY y."code" HAVING sum(l."debit" - l."credit") <> 0`);
  check("every closed year's revenue and expense accounts net to zero (closing entry complete)", leftover.length === 0, leftover);
  const yrNet = await q<{ code: string }>(Prisma.sql`
    SELECT y."code" FROM "FiscalYear" y JOIN "JournalEntry" e ON e."id" = y."closingEntryId" JOIN "JournalLine" l ON l."entryId" = e."id" JOIN "Account" a ON a."id" = l."accountId"
    WHERE y."status" = 'closed' AND a."systemKey" = 'retained_earnings' GROUP BY y."code", y."netIncome" HAVING sum(l."credit" - l."debit") <> y."netIncome"`);
  check("each closing entry moved exactly the year's stated net result into retained earnings", yrNet.length === 0, yrNet);

  section("9. DIMENSIONS, CASH, TRACEABILITY");
  const ccBs = await q<{ id: string }>(Prisma.sql`SELECT l."id" FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE l."costCenterId" IS NOT NULL AND a."type" NOT IN ('revenue', 'expense')`);
  check("cost centers only on revenue/expense lines", ccBs.length === 0, ccBs.slice(0, 5));
  const negCash = await q<{ code: string; b: Prisma.Decimal }>(Prisma.sql`
    SELECT c."code", sum(l."debit" - l."credit") AS b FROM "CashAccount" c JOIN "JournalLine" l ON l."accountId" = c."accountId" WHERE c."type" = 'cash' GROUP BY c."code" HAVING sum(l."debit" - l."credit") < 0`);
  // Informational: only transfers, asset purchases and VAT payments check a cash box's balance.
  console.log(`  info: cash boxes with a negative balance now: ${negCash.length ? negCash.map((x) => `${x.code} ${n(x.b).toFixed(2)}`).join(", ") : "none"}`);
  const orphans = await q<{ sourceType: string; c: bigint }>(Prisma.sql`
    SELECT e."sourceType", count(*) AS c FROM "JournalEntry" e WHERE
      (e."sourceType" IN ('cash_transfer') AND NOT EXISTS (SELECT 1 FROM "CashTransfer" t WHERE t."id" = e."sourceId"))
      OR (e."sourceType" = 'vat_settlement' AND NOT EXISTS (SELECT 1 FROM "VatReturn" r WHERE r."id" = e."sourceId" OR 'void:' || r."id" = e."sourceId"))
      OR (e."sourceType" = 'vat_payment' AND NOT EXISTS (SELECT 1 FROM "VatReturn" r WHERE r."id" = e."sourceId"))
      OR (e."sourceType" = 'asset_depreciation' AND NOT EXISTS (SELECT 1 FROM "DepreciationRun" r WHERE r."id" = e."sourceId" OR r."id" || ':reversal' = e."sourceId"))
      OR (e."sourceType" = 'asset_disposal' AND NOT EXISTS (SELECT 1 FROM "AssetEvent" v WHERE v."id" = e."sourceId"))
      OR (e."sourceType" = 'asset_acquisition' AND NOT EXISTS (SELECT 1 FROM "FixedAsset" f WHERE f."id" = e."sourceId"))
      OR (e."sourceType" = 'opening_batch' AND NOT EXISTS (SELECT 1 FROM "OpeningBatch" b WHERE e."sourceId" LIKE b."id" || ':%'))
      OR (e."sourceType" IN ('year_end_close', 'year_end_reopen') AND NOT EXISTS (SELECT 1 FROM "FiscalYear" y WHERE e."sourceId" LIKE y."id" || ':%'))
    GROUP BY e."sourceType"`);
  check("every entry of the new sources points at an existing document", orphans.length === 0, orphans);
  const openingNet = await q<{ id: string; b: Prisma.Decimal }>(Prisma.sql`
    SELECT b."id", sum(l."debit" - l."credit") AS b FROM "OpeningBatch" b JOIN "JournalEntry" e ON e."id" IN (SELECT jsonb_array_elements_text(coalesce(b."entryIds", '[]'::jsonb))) JOIN "JournalLine" l ON l."entryId" = e."id"
    WHERE b."status" = 'posted' GROUP BY b."id" HAVING sum(l."debit" - l."credit") <> 0`);
  check("each posted opening batch's own entries balance", openingNet.length === 0, openingNet);

  await db.$disconnect();
  finish("LEDGER AUDIT");
}

main().catch((e) => { console.error(e); process.exit(1); });
