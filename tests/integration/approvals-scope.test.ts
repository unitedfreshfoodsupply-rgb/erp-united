/**
 * The inbox's "awaiting your decision" tab counts and lists only what the caller can decide
 * (browser QA D4, Nov 2026: a requester saw "55 awaiting decision" and could decide 1, which
 * was on page 2); their own pending requests have a tab of their own. And the compact notices
 * of a table ask for exactly the records it shows (entity_ids), not the newest 200 of a type.
 *
 * Who may decide is unchanged: scope "decide" applies the same judgement as every card.
 * Every case runs in a transaction that is rolled back: nothing is left behind.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./_db";
import { listApprovalInbox } from "@/lib/core/approval-handlers";
import { APPROVAL_TYPES, type ApprovalType } from "@/lib/core/approvals";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/permissions";

class Rollback extends Error {}
type U = { id: string; name: string };
let admin: U;
let accountant: U;
const TAG = `scope-test-${Date.now()}`;
let seq = 0;

before(async () => {
  admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" }, select: { id: true, name: true } });
  accountant = await prisma.user.findUniqueOrThrow({ where: { username: "karim" }, select: { id: true, name: true } });
});
after(() => prisma.$disconnect());

async function rolledBack<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      value = await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return value as T;
}

const viewer = {
  admin: () => ({ id: admin.id, role: "SUPER_ADMIN", permissions: ALL_PERMISSIONS }),
  accountant: () => ({ id: accountant.id, role: "ACCOUNTANT", permissions: [...ROLE_PERMISSIONS.ACCOUNTANT] }),
};
type Viewer = ReturnType<typeof viewer.admin>;

function open(tx: any, type: ApprovalType, by: U, extra: Record<string, unknown> = {}) {
  return tx.approvalRequest.create({
    data: { number: `${TAG}-${++seq}`, type, entityType: APPROVAL_TYPES[type].entityType, entityId: `${TAG}-e${++seq}`, title: `اختبار ${type}`, requestedById: by.id, requestedBy: by.name, ...extra },
  });
}

/** Every pending request the default listing shows the viewer, page by page. */
async function allPending(tx: any, v: Viewer) {
  const out: any[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listApprovalInbox(v, { status: "pending", limit: 200, offset }, tx);
    out.push(...page.approvals);
    if (out.length >= page.total || page.approvals.length === 0) return out;
  }
}

test("a requester's own requests are not 'awaiting your decision'; they are under 'raised'", async () => {
  const r = await rolledBack(async (tx) => {
    const t = await open(tx, "accounting.cash_transfer", accountant);
    const decideAcc = await listApprovalInbox(viewer.accountant(), { scope: "decide", limit: 200, type: "accounting.cash_transfer" }, tx);
    const raisedAcc = await listApprovalInbox(viewer.accountant(), { scope: "raised", status: "pending", limit: 200, type: "accounting.cash_transfer" }, tx);
    const decideAdmin = await listApprovalInbox(viewer.admin(), { scope: "decide", limit: 200, type: "accounting.cash_transfer" }, tx);
    const plain = await listApprovalInbox(viewer.accountant(), { status: "pending", limit: 200, type: "accounting.cash_transfer" }, tx);
    return { id: t.id, decideAcc, raisedAcc, decideAdmin, plain };
  });
  assert.ok(!r.decideAcc.approvals.some((a: any) => a.id === r.id), "not offered to the requester");
  assert.ok(r.raisedAcc.approvals.some((a: any) => a.id === r.id && a.ownRequest && !a.canDecide), "listed as raised by them, with the reason");
  assert.ok(r.raisedAcc.approvals.every((a: any) => a.ownRequest), "raised: only their own");
  assert.ok(r.decideAdmin.approvals.some((a: any) => a.id === r.id && a.canDecide), "offered to the approver");
  assert.ok(r.plain.approvals.some((a: any) => a.id === r.id), "unchanged: the unscoped listing still has both (deep links, notices)");
});

test("'decide': the count and every row are exactly the requests the caller can decide — the same verdict as the cards", async () => {
  for (const who of ["admin", "accountant"] as const) {
    const r = await rolledBack(async (tx) => {
      // A spread of cases: someone else's, the caller's own, a sole-admin emergency case, and
      // one the caller already decided at level 1 of 2.
      await open(tx, "accounting.cash_transfer", accountant);
      await open(tx, "accounting.cash_transfer", admin);
      await open(tx, "purchasing.bill", admin);
      const twoLevel = await open(tx, "accounting.manual_journal", admin, { requiredLevels: 2, approvedLevels: 1 });
      const me = who === "admin" ? admin : accountant;
      if (who === "accountant") await tx.approvalDecision.create({ data: { requestId: twoLevel.id, level: 1, decision: "approve", deciderId: me.id, decider: me.name, deciderRole: "ACCOUNTANT" } });
      const v = viewer[who]();
      const every = await allPending(tx, v);
      const decidable = every.filter((a) => a.canDecide).map((a) => a.id);
      const first = await listApprovalInbox(v, { scope: "decide", limit: 50 }, tx);
      const pages: any[] = [...first.approvals];
      for (let offset = 50; offset < first.total; offset += 50) pages.push(...(await listApprovalInbox(v, { scope: "decide", limit: 50, offset }, tx)).approvals);
      return { decidable, first, pages, twoLevel: twoLevel.id };
    });
    assert.equal(r.first.total, r.decidable.length, `${who}: the count is of decidable requests`);
    assert.ok(r.pages.every((a) => a.canDecide), `${who}: no row without the decision`);
    assert.deepEqual(r.pages.map((a) => a.id).sort(), [...r.decidable].sort(), `${who}: the same set, over every page`);
    assert.equal(new Set(r.pages.map((a) => a.id)).size, r.pages.length, `${who}: paging repeats nothing`);
    if (who === "accountant") assert.ok(!r.pages.some((a) => a.id === r.twoLevel), "already decided by the caller: not awaiting them");
  }
});

test("'decide' keeps the sole admin's emergency case (approve only) and drops their own where someone else can decide", async () => {
  const r = await rolledBack(async (tx) => {
    const bill = await open(tx, "purchasing.bill", admin);
    const transfer = await open(tx, "accounting.cash_transfer", admin);
    const page = await listApprovalInbox(viewer.admin(), { scope: "decide", limit: 200, type: "purchasing.bill" }, tx);
    const transfers = await listApprovalInbox(viewer.admin(), { scope: "decide", limit: 200, type: "accounting.cash_transfer" }, tx);
    return { bill: bill.id, transfer: transfer.id, page, transfers };
  });
  const row = r.page.approvals.find((a: any) => a.id === r.bill);
  assert.ok(row, "the emergency case is the admin's to decide");
  assert.equal(row.emergency, true);
  assert.ok(!r.transfers.approvals.some((a: any) => a.id === r.transfer), "the accountant can decide the admin's transfer: not the admin's");
});

test("entity_ids: the requests about exactly the records given, however many newer ones exist", async () => {
  const r = await rolledBack(async (tx) => {
    const old = await open(tx, "accounting.manual_journal", accountant, { createdAt: new Date(Date.UTC(2001, 0, 1)) });
    for (let i = 0; i < 3; i++) await open(tx, "accounting.manual_journal", accountant);
    const other = await open(tx, "accounting.manual_journal", accountant);
    const page = await listApprovalInbox(viewer.admin(), { status: "pending", type: "accounting.manual_journal", entityIds: [old.entityId, other.entityId], limit: 200, withApprovers: true }, tx);
    return { old, other, page };
  });
  assert.deepEqual(r.page.approvals.map((a: any) => a.entityId).sort(), [r.old.entityId, r.other.entityId].sort());
  assert.equal(r.page.total, 2);
});
