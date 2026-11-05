/* Bank statement matching (Nov 2026): every statement line scanned every book line, recomputing
   debit − credit and the date for each pair, while the transaction held the only connection. The
   book lines are now indexed by amount once. The result must be exactly the full scan's: the same
   matches, already-cleared claims, ambiguous rows and unmatched lines, in the same order. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import { todayLocalISO } from "@/lib/localDate";
import { createCashAccount } from "@/lib/accounting/treasury";
import { postJournal } from "@/lib/accounting/ledger";
import { matchStatement, startReconciliation } from "@/lib/accounting/cash";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const TAG = `ZZSTM${Date.now()}`;
const finance = actor("المدير المالي", ["accounting.manage", "accounting.view"], null, "ACCOUNTANT");
const today = todayLocalISO();
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
let recId = "";
let bankAccountId = "";

// A small deterministic generator: the same book and statement on every run.
let seed = 7;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

before(async () => {
  const bank = await createCashAccount({ type: "bank", name: `${TAG} Bank`, name_ar: `${TAG} بنك` }, finance);
  bankAccountId = bank.accountId;
  const capital = await prisma.account.findUniqueOrThrow({ where: { systemKey: "capital" } });
  const amounts = ["100", "250.5", "250.50", "-75", "1200", "-1200", "33.33", "100.00", "-75.00", "980"];
  await inTx(async (tx) => {
    for (let i = 0; i < 150; i++) {
      const amount = D(amounts[rnd(amounts.length)]);
      await postJournal(tx, {
        date: shift(today, -rnd(20)), description: `${TAG} حركة REF${rnd(12)}`, sourceType: "manual", sourceId: `${TAG}-${i}`,
        lines: [{ accountId: bankAccountId, amount }, { accountId: capital.id, amount: amount.negated() }],
      }, finance);
    }
  });
  recId = (await startReconciliation({ cash_account_id: bank.id, statement_date: today, statement_balance: "0" }, finance)).id;
});
after(async () => { await prisma.$disconnect(); });

/** The full scan as it was before Nov 2026, over the same pool: the reference. */
async function fullScan(lines: { date: string; amount: string; reference?: string | null }[], tol: number) {
  const book = await prisma.journalLine.findMany({
    where: { accountId: bankAccountId, entry: { date: { lte: today } }, OR: [{ reconciliationId: null }, { reconciliationId: recId }] },
    include: { entry: { select: { number: true, date: true, description: true } } },
  });
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const used = new Set<string>();
  const out = { matched: [] as unknown[], alreadyCleared: [] as unknown[], ambiguous: [] as unknown[], unmatchedStatement: [] as unknown[] };
  const order = lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.date.localeCompare(b.l.date));
  for (const { l, i } of order) {
    const amt = D(l.amount);
    const ref = (l.reference ?? "").toLowerCase();
    const cands = book
      .filter((b) => !used.has(b.id) && b.debit.minus(b.credit).equals(amt) && Math.abs(day(b.entry.date) - day(l.date)) <= tol)
      .map((b) => ({ b, gap: Math.abs(day(b.entry.date) - day(l.date)), refHit: !!ref && (`${b.entry.number} ${b.description ?? ""} ${b.entry.description}`).toLowerCase().includes(ref) ? 0 : 1, cleared: b.reconciliationId === recId ? 0 : 1 }))
      .sort((x, y) => x.refHit - y.refHit || x.gap - y.gap || x.cleared - y.cleared);
    if (!cands.length) { out.unmatchedStatement.push({ statementRow: i + 1, date: l.date, amount: amt.toFixed(2), reference: l.reference ?? null }); continue; }
    const best = cands[0];
    if (best.cleared === 0) { used.add(best.b.id); out.alreadyCleared.push({ statementRow: i + 1, lineId: best.b.id, number: best.b.entry.number }); continue; }
    if (cands.length > 1 && cands[1].refHit === best.refHit && cands[1].gap === best.gap) { out.ambiguous.push({ statementRow: i + 1, candidates: cands.filter((c) => c.refHit === best.refHit && c.gap === best.gap).map((c) => c.b.id) }); continue; }
    used.add(best.b.id);
    out.matched.push({ statementRow: i + 1, lineId: best.b.id, number: best.b.entry.number, date: best.b.entry.date, amount: amt.toFixed(2) });
  }
  const unmatchedBook = book.filter((b) => !used.has(b.id) && b.reconciliationId !== recId).map((b) => ({ id: b.id, date: b.entry.date, number: b.entry.number, amount: b.debit.minus(b.credit).toFixed(2) })).slice(0, 500);
  return { ...out, unmatchedBook };
}

const statement = (n: number) => Array.from({ length: n }, () => ({
  date: shift(today, -rnd(22)),
  amount: ["100", "250.5", "-75", "1200", "-1200", "33.33", "980", "5", "-1200.00"][rnd(9)],
  reference: rnd(3) === 0 ? `ref${rnd(12)}` : null,
}));

test("indexed matching gives exactly the full scan's result, before and after applying it", async () => {
  const seen = { matched: 0, alreadyCleared: 0, ambiguous: 0, unmatchedStatement: 0 };
  for (const [n, tol, apply] of [[120, 3, false], [200, 0, false], [90, 5, true], [160, 3, false], [160, 15, true], [60, 2, false]] as const) {
    const lines = statement(n);
    const expected = await fullScan(lines, tol);
    const got = await matchStatement(recId, { lines, tolerance_days: tol, apply }, finance);
    const { matched, alreadyCleared, ambiguous, unmatchedStatement, unmatchedBook } = got;
    assert.deepEqual({ matched, alreadyCleared, ambiguous, unmatchedStatement, unmatchedBook }, expected, `${n} lines, ±${tol} days`);
    if (apply) assert.equal(got.applied, expected.matched.length);
    for (const k of Object.keys(seen) as (keyof typeof seen)[]) seen[k] += expected[k].length;
  }
  assert.ok(Object.values(seen).every((x) => x > 0), `every kind of outcome was exercised: ${JSON.stringify(seen)}`);
  const cleared = await prisma.journalLine.count({ where: { reconciliationId: recId } });
  assert.ok(cleared > 0, "some lines were ticked, so later runs exercised the already-cleared claims");
});
