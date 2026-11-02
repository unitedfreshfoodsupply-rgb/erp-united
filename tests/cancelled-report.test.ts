/* Cancelled/reversed transaction report: must return source-document traceability,
   original↔reversal links for every reversal/cancellation/void in the system,
   and be gated by accounting.manage (senior finance). */
import { call, login, makeChecker } from "./_harness";
import { manualJournal } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `ZZCAN${Date.now() % 1_000_000_000}`;

async function main() {
  await login("admin");
  await login("karim");
  await login("mona");

  section("1. CANCELLED REPORT REQUIRES SENIOR FINANCE PERMISSION");
  const denied = await call("mona", "GET", "/api/accounting/cancelled-report?from=2000-01-01&to=2099-12-31");
  check("sales role cannot see cancelled report (403)", denied.status === 403, denied.status);

  const r = await call("karim", "GET", "/api/accounting/cancelled-report?from=2000-01-01&to=2099-12-31");
  check("senior finance can access the report", r.status === 200, r.status);
  check("response has entries + totals", Array.isArray(r.body?.entries) && r.body.totals !== undefined);

  section("2. FIXTURES: CREATE A REVERSIBLE TRANSACTION");
  // Create a simple reversal scenario: a manual journal entry and its reversal.
  const accounts = (await call("karim", "GET", "/api/accounting/accounts")).body.accounts;
  const cashMain = accounts.find((a: any) => a.code === "3100");
  const expense = accounts.find((a: any) => a.code === "6100");
  check("chart of accounts available", !!cashMain?.id && !!expense?.id);

  // CTL-01: a manual journal waits for a second person — submitted by the accountant
  // (202), approved by management, then posted.
  const journal = await manualJournal({
    date: "2099-06-01",
    description: `${TAG} test entry`,
    lines: [
      { account_id: cashMain.id, credit: 500 },
      { account_id: expense.id, debit: 500 },
    ],
  });
  check("manual journal created (202, approved by someone else, posted)", journal.submit.status === 202 && journal.decision?.status === 200 && !!journal.journal?.id, [journal.submit.status, journal.decision?.status]);

  const rev = await call("karim", "POST", `/api/accounting/journals/${journal.journal.id}/reverse`, { reason: `${TAG} test reversal` });
  check("journal reversal created", rev.status === 201 && !!rev.body.journal?.id, rev.status);

  section("3. REPORT CONTAINS THE REVERSAL");
  const r2 = await call("karim", "GET", "/api/accounting/cancelled-report?from=2000-01-01&to=2099-12-31");
  check("report 200", r2.status === 200, r2.status);

  const reversalEntries = r2.body.entries.filter((e: any) => e.kind === "journal_reversal");
  check("journal reversal appears in the report", reversalEntries.length >= 1, reversalEntries);

  const entry = reversalEntries.find((e: any) => e.reason?.includes(TAG));
  check("the tagged reversal is found", !!entry, entry);
  check("original document link (originalId) exists", !!entry.originalId);
  check("original number (originalNumber) is present", !!entry.originalNumber);

  section("4. REPORT STRUCTURE");
  check("from/to returned", r2.body.from === "2000-01-01" && r2.body.to === "2099-12-31");
  check("count is a number", typeof r2.body.count === "number");
  check("totals contains creditNotes", typeof r2.body.totals.creditNotes === "number");
  check("entries sorted by date", r2.body.entries.every((e: any, i: number) => i === 0 || e.date >= r2.body.entries[i - 1].date));

  finish("CANCELLED-REPORT");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });