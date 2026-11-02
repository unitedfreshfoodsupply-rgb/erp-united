/**
 * Cash and bank accounts never go negative — enforced by PostgreSQL itself (L2, migrations
 * 20261102110000 / 111000), tested here with raw SQL that bypasses the application entirely.
 *
 *  1. A transaction that would take the cash box below zero is rejected when its deferred
 *     constraints are resolved (by inTx before COMMIT, or by COMMIT itself) and leaves
 *     nothing behind; no application code bypasses inTx.
 *  2. The same check fires at once when the constraint trigger is set IMMEDIATE.
 *  3. Money coming IN (a debit) is never blocked.
 *  4. An account explicitly flagged allowOverdraft=true may go below zero; one that is not
 *     flagged may not — checked side by side in the same transaction (rolled back).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "./_db";
import { inTx } from "@/lib/tx";

class Rollback extends Error {}
let cashGl = "", bankGl = "", expenseGl = "", capitalGl = "";
let seq = Date.now() % 100000;

before(async () => {
  cashGl = (await prisma.cashAccount.findFirstOrThrow({ where: { type: "cash", active: true } })).accountId;
  bankGl = (await prisma.cashAccount.findFirstOrThrow({ where: { type: "bank", active: true } })).accountId;
  expenseGl = (await prisma.account.findUniqueOrThrow({ where: { systemKey: "general_expenses" } })).id;
  capitalGl = (await prisma.account.findUniqueOrThrow({ where: { systemKey: "capital" } })).id;
});
after(() => prisma.$disconnect());

const today = () => new Date().toISOString().slice(0, 10);
const balance = async (db: any, accountId: string) => {
  const r = await db.$queryRaw`SELECT coalesce(sum("debit" - "credit"), 0)::numeric AS b FROM "JournalLine" WHERE "accountId" = ${accountId}`;
  return Number(r[0].b);
};

/** A balanced two-line journal, inserted with plain SQL: Dr `debitAcc` / Cr `creditAcc`. */
async function rawJournal(db: any, debitAcc: string, creditAcc: string, amount: number) {
  const id = `cashdb-${Date.now()}-${++seq}`;
  const number = `JE-9${String(new Date().getFullYear()).slice(1)}-${String(90000 + (seq % 9999)).padStart(5, "0")}${seq}`;
  await db.$executeRaw`INSERT INTO "JournalEntry" ("id", "number", "date", "description", "sourceType", "sourceId", "total", "createdBy")
    VALUES (${id}, ${number}, ${today()}, 'cash-db-trigger test', 'manual', ${id}, ${amount}, 'cash-db-test')`;
  await db.$executeRaw`INSERT INTO "JournalLine" ("id", "entryId", "accountId", "debit", "credit") VALUES (${id + "-d"}, ${id}, ${debitAcc}, ${amount}, 0)`;
  await db.$executeRaw`INSERT INTO "JournalLine" ("id", "entryId", "accountId", "debit", "credit") VALUES (${id + "-c"}, ${id}, ${creditAcc}, 0, ${amount})`;
  return id;
}

test("1a. deferred to commit: the raw inserts go in, the check fires when constraints are resolved (inTx), nothing persists", async () => {
  const before = await balance(prisma, cashGl);
  let entryId = "";
  let insertsAccepted = false;
  let err: any = null;
  try {
    // The application's own transaction wrapper: it resolves deferred constraints before
    // COMMIT (SET CONSTRAINTS ALL IMMEDIATE), exactly the check COMMIT itself would run.
    await inTx(async (tx) => {
      entryId = await rawJournal(tx, expenseGl, cashGl, before + 100);
      insertsAccepted = true; // deferred: no statement was refused
    });
  } catch (e) {
    err = e;
  }
  assert.equal(insertsAccepted, true, "the check is deferred: the INSERT statements themselves were accepted");
  assert.ok(err, "resolving the deferred constraint must fail");
  assert.match(String(err?.message), /cash_account_negative: \S+ would be -100\b/, "rejected by the database rule with the would-be balance");
  assert.equal(await prisma.journalEntry.count({ where: { id: entryId } }), 0, "the entry was rolled back");
  assert.equal(await balance(prisma, cashGl), before, "the cash balance is unchanged");
});

test("1b. a bare COMMIT (no wrapper) is still refused by PostgreSQL: nothing persists", async () => {
  // Prisma 5.22 resolves an interactive transaction whose COMMIT fails without throwing
  // (documented in lib/tx.ts, which is why inTx resolves constraints first). Whatever the
  // client reports, the database must not have kept the rows.
  const before = await balance(prisma, cashGl);
  let entryId = "";
  await prisma.$transaction(async (tx) => {
    entryId = await rawJournal(tx, expenseGl, cashGl, before + 100);
  }).catch(() => undefined);
  assert.ok(entryId, "the transaction body ran");
  assert.equal(await prisma.journalEntry.count({ where: { id: entryId } }), 0, "COMMIT was refused: the entry does not exist");
  assert.equal(await prisma.journalLine.count({ where: { entryId } }), 0, "nor do its lines");
  assert.equal(await balance(prisma, cashGl), before, "the cash balance is unchanged");
});

// Direct prisma.$transaction callers that bypass inTx, reviewed on 2 Nov 2026: none writes a
// table guarded by a DEFERRED constraint trigger (users, login throttle, order numbers,
// order header create, product master data, one read), so a swallowed COMMIT failure
// cannot happen there. A new direct caller fails this test until it is reviewed.
const DIRECT_TX_REVIEWED = [
  "app/api/sales/customers/[id]/exposure/route.ts",
  "lib/admin-service.ts",
  "lib/loginRateLimit.ts",
  "lib/orderNumber.ts",
  "lib/orders-service.ts",
  "lib/product-master-service.ts",
];
// Prisma accessors of every model with a DEFERRABLE INITIALLY DEFERRED constraint trigger.
const DEFERRED_MODELS = /\.(journalEntry|journalLine|receiptAllocation|paymentAllocation|receiptDeduction|paymentDeduction|payrollPayment|payrollPaymentLine|attendanceDay|employeeCompensation|employeeEmployment|leavePolicy|leaveRequest|statutoryRuleSet)\b/;

test("1c. every writer of a deferred-constraint table goes through inTx (which resolves constraints before COMMIT)", () => {
  const direct: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && p !== join("lib", "tx.ts") && /\$transaction\s*\(/.test(readFileSync(p, "utf8"))) direct.push(p);
    }
  };
  walk("lib");
  walk("app");
  assert.deepEqual(direct.sort(), DIRECT_TX_REVIEWED, "a new direct $transaction caller must be reviewed (use inTx)");
  for (const f of direct) assert.doesNotMatch(readFileSync(f, "utf8"), DEFERRED_MODELS, `${f} bypasses inTx and must not touch a deferred-constraint table`);
  assert.match(readFileSync(join("lib", "tx.ts"), "utf8"), /SET CONSTRAINTS ALL IMMEDIATE/, "inTx resolves deferred constraints before COMMIT");
});

test("2. with the constraint trigger IMMEDIATE, the same insert is refused at the statement", async () => {
  let refusedAt = "";
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET CONSTRAINTS "JournalLine_cash_never_negative" IMMEDIATE`);
      try {
        await rawJournal(tx, expenseGl, cashGl, (await balance(tx, cashGl)) + 1);
      } catch (e) {
        refusedAt = String((e as Error).message);
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback) && !refusedAt) throw e;
  }
  assert.match(refusedAt, /cash_account_negative/, "refused by the trigger itself");
});

test("3. money coming in (a debit to cash) is never blocked", async () => {
  let ok = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET CONSTRAINTS "JournalLine_cash_never_negative" IMMEDIATE`);
      await rawJournal(tx, cashGl, capitalGl, 250);
      ok = (await balance(tx, cashGl)) >= 250;
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  assert.ok(ok, "a receipt into the box posts");
});

test("4. allowOverdraft=true lets that account go below zero; an account without it still may not", async () => {
  const out: { bankAfter?: number; cashRefused?: string } = {};
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET CONSTRAINTS "JournalLine_cash_never_negative" IMMEDIATE`);
      await tx.$executeRaw`UPDATE "CashAccount" SET "allowOverdraft" = true WHERE "accountId" = ${bankGl}`;
      const bankBefore = await balance(tx, bankGl);
      await rawJournal(tx, expenseGl, bankGl, bankBefore + 500);
      out.bankAfter = await balance(tx, bankGl);
      try {
        await rawJournal(tx, expenseGl, cashGl, (await balance(tx, cashGl)) + 500);
      } catch (e) {
        out.cashRefused = String((e as Error).message);
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  assert.equal(out.bankAfter, -500, "the overdraft-allowed bank account is at −500");
  assert.match(out.cashRefused ?? "", /cash_account_negative/, "the cash box without the flag is still refused");
  const flags = await prisma.cashAccount.findMany({ where: { allowOverdraft: true } });
  assert.equal(flags.length, 0, "the flag was rolled back (default is no overdraft anywhere)");
});
