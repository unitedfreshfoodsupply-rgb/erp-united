/* The accounts-health screen (Nov 2026, UXB-8): a receivables or payables mismatch names the
   party — its code and names come back with the row, joined in the same statement, so the check
   still costs one round trip however many parties differ — and a party id that matches no record
   comes back with empty names instead of failing. Every scenario posts inside a transaction that
   is rolled back at the end (after the deferred balance constraint ran), so it leaves nothing. */
import { countQueries } from "./_query-count";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { postJournal } from "@/lib/accounting/ledger";
import { partyMismatches } from "@/lib/accounting/integrity";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const acc = actor("محاسب", ["accounting.manage"], null, "ACCOUNTANT");
const GHOST = "zz-health-no-such-party";
const TAG = `ZZHEALTH${Date.now()}`;

after(async () => {
  await prisma.$disconnect();
});

class Rollback extends Error {}
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  await assert.rejects(inTx(async (tx) => { await fn(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; throw new Rollback(); }), (e) => { if (e instanceof Rollback) return true; throw e; });
}

test("AR/AP mismatches carry the party's code and names, in one statement, and an unknown id comes back unnamed", async () => {
  await rolledBack(async (tx) => {
    // The mismatches already there (other suites' data), so each one below is exactly what this entry adds.
    const [arBefore, apBefore] = [await partyMismatches("customer", tx), await partyMismatches("supplier", tx)];
    const skipC = new Set(arBefore.map((r) => r.id));
    const skipS = new Set(apBefore.map((r) => r.id));
    // Parties of its own (rolled back with the rest), so the test does not depend on the fixtures.
    const sel = { id: true, code: true, name: true, nameAr: true } as const;
    const a = await tx.customer.create({ data: { code: `${TAG}-C`, name: `${TAG} customer`, nameAr: `${TAG} عميل`, createdBy: "integration-test" }, select: sel });
    const s1 = await tx.supplier.create({ data: { code: `${TAG}-S1`, name: `${TAG} supplier 1`, nameAr: `${TAG} مورد 1` }, select: sel });
    const s2 = await tx.supplier.create({ data: { code: `${TAG}-S2`, name: `${TAG} supplier 2` }, select: sel });
    assert.ok(!skipC.has(a.id) && !skipS.has(s1.id) && !skipS.has(s2.id));
    // Receivables move from a customer to an id that is no party at all, and payables between two
    // suppliers: the totals still agree, only the per-party check can see it.
    await postJournal(tx, {
      date: todayLocalISO(), description: "health detail test", sourceType: "manual", sourceId: `manual-health-${Date.now()}`,
      lines: [
        { key: "ar", amount: D(100), party: { type: "customer", id: a.id } },
        { key: "ar", amount: D(-100), party: { type: "customer", id: GHOST } },
        { key: "ap", amount: D(40), party: { type: "supplier", id: s1.id } },
        { key: "ap", amount: D(-40), party: { type: "supplier", id: s2.id } },
      ],
    }, acc);

    const ar = await countQueries(() => partyMismatches("customer", tx));
    assert.equal(ar.queries, 1, "names are joined into the mismatch query, not looked up per party");
    const rowA = ar.result.find((r) => r.id === a.id);
    const ghost = ar.result.find((r) => r.id === GHOST);
    assert.deepEqual([rowA?.code, rowA?.name, rowA?.nameAr], [a.code, a.name, a.nameAr]);
    // Amounts are unchanged by the join: the documents side and the ledger side, 100 apart.
    assert.equal(D(rowA!.ledger).minus(rowA!.subledger).toFixed(2), "100.00");
    assert.deepEqual([ghost?.code, ghost?.name, ghost?.nameAr, ghost?.subledger, ghost?.ledger], [null, null, null, "0.00", "-100.00"]);
    assert.equal(ar.result.length, arBefore.length + 2, "only the two moved parties are added");

    const ap = await countQueries(() => partyMismatches("supplier", tx));
    assert.equal(ap.queries, 1);
    const row1 = ap.result.find((r) => r.id === s1.id);
    const row2 = ap.result.find((r) => r.id === s2.id);
    assert.deepEqual([row1?.code, row1?.name, row1?.nameAr], [s1.code, s1.name, s1.nameAr]);
    assert.deepEqual([row2?.code, row2?.name, row2?.nameAr], [s2.code, s2.name, s2.nameAr]);
    // Payables are credit-positive: a 40 debit lowers what the ledger says we owe, a 40 credit raises it.
    assert.equal(D(row1!.ledger).minus(row1!.subledger).toFixed(2), "-40.00");
    assert.equal(D(row2!.ledger).minus(row2!.subledger).toFixed(2), "40.00");
    assert.equal(ap.result.length, apBefore.length + 2);
  });
});
