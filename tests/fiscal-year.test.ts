/* Fiscal year closing and controlled reopening, on a year no other suite touches (2015).
   - closing posts one entry on the last day bringing revenue/expense to zero against
     retained earnings, closes the last month, refuses a second close, needs earlier years
     closed and the other months closed;
   - reports still show the year's own result (the closing entry is left out of P&L and
     cash flow), the balance sheet and trial balance balance;
   - reopening a year or a month is a request: a reason is required, the requester cannot
     approve, a different person with accounting.periods.reopen approves; a year reopen
     reverses the closing entry. The suite leaves 2015 open so it can run again. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();
const Y = "2015";
const n = (v: any) => Number(v ?? 0);

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "karim", "mona"]) await login(u);
  const pending = async (entityId: string) => (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === entityId);
  const approve = async (entityId: string) => { const a = await pending(entityId); return call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version }); };
  const plOfYear = async () => {
    const [r] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."credit" - l."debit") AS b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId" WHERE a."type" IN ('revenue', 'expense') AND e."date" BETWEEN '2015-01-01' AND '2015-12-31'`;
    return n(r?.b);
  };
  const reBalance = async () => { const [r] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."credit" - l."debit") AS b FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = 'retained_earnings'`; return n(r?.b); };
  const period = async (code: string) => db.accountingPeriod.findUnique({ where: { code } });
  const REASON = "تصحيح قيد إيجار اتسجل في السنة الغلط";

  section("0. START FROM AN OPEN 2015");
  let fy = await db.fiscalYear.findUnique({ where: { code: Y } });
  if (fy?.status === "closed") { await call("karim", "POST", `/api/accounting/fiscal-years/${Y}/reopen`, { reason: REASON }); await approve(fy.id); }
  if ((await period("2015-12"))?.status === "closed") { const p = await period("2015-12"); await call("karim", "POST", "/api/accounting/periods/2015-12/reopen", { reason: REASON }); await approve(p!.id); }
  check("2015 is open to start", (await db.fiscalYear.findUnique({ where: { code: Y } }))?.status !== "closed" && (await period("2015-12"))?.status !== "closed");

  // Months are closed in order: other suites leave older test months open (2001-01 …), so
  // close every open month before 2015 first (isolated test database only).
  for (const p of await db.accountingPeriod.findMany({ where: { status: "open", code: { lt: "2015-01" } }, orderBy: { code: "asc" } })) {
    await call("karim", "POST", `/api/accounting/periods/${p.code}/close`, {});
  }

  section("1. A YEAR WITH A RESULT");
  let r = await call("karim", "POST", "/api/accounting/journals", { date: "2015-12-15", description: "مبيعات 2015", lines: [{ account_id: "acc_1100", debit: 1000 }, { account_id: "acc_4100", credit: 1000 }] });
  check("revenue 1000 in Dec 2015", r.status === 201, r.body);
  r = await call("karim", "POST", "/api/accounting/journals", { date: "2015-12-16", description: "مصروف 2015", lines: [{ account_id: "acc_6100", debit: 300 }, { account_id: "acc_1100", credit: 300 }] });
  check("expense 300 in Dec 2015", r.status === 201, r.body);
  const june = await period("2015-06");
  if (!june || june.status === "open") {
    await call("karim", "POST", "/api/accounting/journals", { date: "2015-06-10", description: "مصروف يونيو 2015", lines: [{ account_id: "acc_6200", debit: 50 }, { account_id: "acc_1100", credit: 50 }] });
    const pv = (await call("karim", "GET", `/api/accounting/fiscal-years/${Y}`)).body.year;
    check("an open month inside the year blocks the close", pv.problems.some((p: any) => p.code === "months_open" && p.params.months.includes("2015-06")), pv.problems);
    check("…and the close is refused (409)", (await call("karim", "POST", `/api/accounting/fiscal-years/${Y}/close`, {})).status === 409);
    check("close June 2015", (await call("karim", "POST", "/api/accounting/periods/2015-06/close", {})).status === 200);
  }
  const later = (await call("karim", "GET", "/api/accounting/fiscal-years/2016")).body.year;
  check("2016's preview warns that 2015's result is still open", later.warnings.some((p: any) => p.code === "earlier_year_open"), later.warnings);
  check("a year that has not ended cannot be closed (2099) -> 409", (await call("karim", "POST", "/api/accounting/fiscal-years/2099/close", {})).status === 409);
  const pl = await plOfYear();
  const pv = (await call("karim", "GET", `/api/accounting/fiscal-years/${Y}`)).body.year;
  check("preview: net result = the year's revenue − expenses from the ledger", Math.abs(n(pv.netIncome) - pl) < 0.005 && pv.problems.length === 0, [pv.netIncome, pl, pv.problems]);

  section("2. CLOSE THE YEAR");
  // Normal month-end routine: December is closed like any month before the year is.
  check("December 2015 closed as a month first", (await call("karim", "POST", "/api/accounting/periods/2015-12/close", {})).status === 200);
  const pvDec = (await call("karim", "GET", `/api/accounting/fiscal-years/${Y}`)).body.year;
  check("…the preview only notes it (the close reposts in it atomically), no blocker", pvDec.problems.length === 0 && pvDec.warnings.some((w: any) => w.code === "last_month_closed"), [pvDec.problems, pvDec.warnings]);
  check("sales cannot close a year -> 403", (await call("mona", "POST", `/api/accounting/fiscal-years/${Y}/close`, {})).status === 403);
  const reBefore = await reBalance();
  r = await call("karim", "POST", `/api/accounting/fiscal-years/${Y}/close`, {});
  check("closed -> 200", r.status === 200 && r.body.year.status === "closed", r.body);
  const closing = (await call("karim", "GET", `/api/accounting/journals/${r.body.year.closingEntryId}`)).body.journal;
  check("…one closing entry on 2015-12-31", closing?.date === "2015-12-31" && closing.sourceType === "year_end_close", closing);
  check("…and December is closed again after it", (await period("2015-12"))?.status === "closed");
  check("…revenue and expense accounts of 2015 are at zero", Math.abs(await plOfYear()) < 0.005);
  check("…retained earnings took the result", Math.abs((await reBalance()) - reBefore - pl) < 0.005, [reBefore, await reBalance(), pl]);
  check("…the last month is closed", (await period("2015-12"))?.status === "closed");
  const plReport = (await call("karim", "GET", "/api/accounting/pnl?from=2015-01-01&to=2015-12-31")).body;
  check("the P&L for 2015 still shows its result (closing entry left out)", Math.abs(n(plReport.pnl?.netIncome ?? plReport.netIncome) - pl) < 0.005, plReport);
  const bs = (await call("karim", "GET", "/api/accounting/balance-sheet?as_of=2015-12-31")).body;
  check("balance sheet at 2015-12-31 balances", (bs.balanceSheet ?? bs)._balanced === true, bs);
  const cf = (await call("karim", "GET", "/api/management/cash-flow?from=2015-01-01&to=2015-12-31")).body.report;
  check("cash flow for 2015 balances (net income counted once)", cf._balanced === true && Math.abs(n(cf.netIncome) - pl) < 0.005, [cf.netIncome, cf._balanced]);
  check("posting into the closed year -> 409", (await call("karim", "POST", "/api/accounting/journals", { date: "2015-12-20", description: "متأخر", lines: [{ account_id: "acc_6100", debit: 1 }, { account_id: "acc_1100", credit: 1 }] })).status === 409);
  check("closing again -> 409", (await call("karim", "POST", `/api/accounting/fiscal-years/${Y}/close`, {})).status === 409);
  check("a month of a closed year cannot be reopened (reopen the year) -> 409", (await call("karim", "POST", "/api/accounting/periods/2015-12/reopen", { reason: REASON })).status === 409);

  section("3. REOPEN THE YEAR — A REQUEST SOMEONE ELSE APPROVES");
  fy = await db.fiscalYear.findUnique({ where: { code: Y } });
  check("a reason is required -> 400", (await call("karim", "POST", `/api/accounting/fiscal-years/${Y}/reopen`, {})).status === 400);
  check("a one-word reason is refused -> 400", (await call("karim", "POST", `/api/accounting/fiscal-years/${Y}/reopen`, { reason: "غلط" })).status === 400);
  check("sales cannot ask -> 403", (await call("mona", "POST", `/api/accounting/fiscal-years/${Y}/reopen`, { reason: REASON })).status === 403);
  r = await call("karim", "POST", `/api/accounting/fiscal-years/${Y}/reopen`, { reason: REASON });
  check("the request is accepted (202) and nothing opens yet", r.status === 202 && (await db.fiscalYear.findUnique({ where: { code: Y } }))?.status === "closed", r.body);
  const req = await pending(fy!.id);
  check("…it waits in the approvals inbox", req?.type === "accounting.year_reopen", req);
  check("the accountant cannot approve a reopen (no permission / own request) -> 403", (await call("karim", "POST", `/api/approvals/${req.id}/decide`, { decision: "approve" })).status === 403);
  r = await approve(fy!.id);
  check("the owner approves -> the year is open", r.status === 200 && (await db.fiscalYear.findUnique({ where: { code: Y } }))?.status === "open", r.body);
  check("…the closing entry is reversed: 2015's result is back in its accounts", Math.abs((await plOfYear()) - pl) < 0.005);
  check("…retained earnings back where they were", Math.abs((await reBalance()) - reBefore) < 0.005);
  check("…and December 2015 is open again", (await period("2015-12"))?.status === "open");
  const fyNow = await db.fiscalYear.findUnique({ where: { code: Y } });
  check("…the reopening is recorded (who, why)", fyNow?.reopenedBy === "مدير النظام" || (!!fyNow?.reopenedBy && fyNow.reopenReason === REASON), fyNow);

  section("4. REOPEN A MONTH");
  check("close December 2015", (await call("karim", "POST", "/api/accounting/periods/2015-12/close", {})).status === 200);
  const dec = await period("2015-12");
  r = await call("karim", "POST", "/api/accounting/periods/2015-12/reopen", { reason: REASON });
  check("month reopen requested (202)", r.status === 202, r.body);
  check("asking twice returns the same pending request", (await call("karim", "POST", "/api/accounting/periods/2015-12/reopen", { reason: REASON })).body.approval?.id === r.body.approval?.id);
  r = await approve(dec!.id);
  const decNow = await period("2015-12");
  check("approved: open again, counted and attributed", r.status === 200 && decNow?.status === "open" && decNow.reopenCount > (dec?.reopenCount ?? 0) && decNow.reopenReason === REASON, decNow);
  const audit = await db.auditLog.findFirst({ where: { action: "period_reopened", entityId: dec!.id }, orderBy: { timestamp: "desc" } });
  check("…in the audit log with its reason", audit?.reason === REASON, audit);
  check("an open month cannot be 'reopened' -> 409", (await call("karim", "POST", "/api/accounting/periods/2015-12/reopen", { reason: REASON })).status === 409);
  const tb = (await call("karim", "GET", "/api/accounting/trial-balance?from=2015-01-01&to=2015-12-31")).body.trialBalance;
  check("trial balance balances", tb?.balanced === true);

  await db.$disconnect();
  finish("FISCAL YEAR");
}

main().catch((e) => { console.error(e); process.exit(1); });
