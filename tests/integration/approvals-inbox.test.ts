/**
 * The approvals inbox says who may decide before anyone clicks (Nov 2026: UXB-1, ARC-2, ARC-4).
 *
 * listApprovalInbox mirrors what a decision will judge — the engine's rule (the requester never
 * decides their own request, except a SUPER_ADMIN nobody can replace, approve-only, with a
 * reason) and each module's own (whoever prepared or submitted the record) — and names who can
 * decide instead. Who may decide is NOT changed; only the screen stops offering a button that
 * is certain to be refused. It also pages and filters, at a statement count that does not grow
 * with the number of requests.
 *
 * Every case runs in a transaction that is rolled back: nothing is left behind.
 */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./_db";
import { listApprovalInbox } from "@/lib/core/approval-handlers";
import { APPROVAL_TYPES, type ApprovalType } from "@/lib/core/approvals";
import { usersWithPermission } from "@/lib/core/notifications";
import { applyPeriodReopen } from "@/lib/accounting/fiscal-years";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/permissions";

class Rollback extends Error {}
type U = { id: string; name: string };
let admin: U;
let accountant: U;
let supervisor: U;
const TAG = `inbox-test-${Date.now()}`;
let seq = 0;

before(async () => {
  admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" }, select: { id: true, name: true } });
  accountant = await prisma.user.findUniqueOrThrow({ where: { username: "karim" }, select: { id: true, name: true } });
  supervisor = await prisma.user.findUniqueOrThrow({ where: { username: "sara" }, select: { id: true, name: true } });
  // Warm the settings cache, so the counts below are the listing's own statements.
  await listApprovalInbox({ id: admin.id, role: "SUPER_ADMIN", permissions: ALL_PERMISSIONS }, { limit: 1 });
});
after(() => prisma.$disconnect());

async function rolledBack<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      value = await fn(tx);
      throw new Rollback();
    }, { timeout: 20_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return value as T;
}

const viewer = {
  admin: () => ({ id: admin.id, role: "SUPER_ADMIN", permissions: ALL_PERMISSIONS }),
  accountant: () => ({ id: accountant.id, role: "ACCOUNTANT", permissions: [...ROLE_PERMISSIONS.ACCOUNTANT] }),
  supervisor: () => ({ id: supervisor.id, role: "SUPERVISOR", permissions: [...ROLE_PERMISSIONS.SUPERVISOR] }),
};

/** A pending request as requestApproval writes it (without its notifications). */
function open(tx: any, type: ApprovalType, by: U, entityId = `${TAG}-${++seq}`, at?: Date) {
  return tx.approvalRequest.create({
    data: { number: `${TAG}-${++seq}`, type, entityType: APPROVAL_TYPES[type].entityType, entityId, title: `اختبار ${type}`, requestedById: by.id, requestedBy: by.name, ...(at ? { createdAt: at } : {}) },
  });
}
const mine = (rows: any[], id: string) => rows.find((r) => r.id === id);

test("precondition: who holds the permissions these cases rely on", async () => {
  assert.deepEqual(await usersWithPermission(prisma, "accounting.periods.reopen"), [admin.id], "only the SUPER_ADMIN reopens periods");
  assert.deepEqual(await usersWithPermission(prisma, "purchasing.bills.approve"), [admin.id], "only the SUPER_ADMIN approves bill variances");
  assert.deepEqual(await usersWithPermission(prisma, "accounting.opening.approve"), [admin.id], "only the SUPER_ADMIN approves opening batches");
  assert.ok((await usersWithPermission(prisma, "accounting.manage")).includes(accountant.id), "the accountant holds accounting.manage");
});

test("a requester who holds the permission is not offered the decision, and is told who can decide", async () => {
  const { asRequester, asApprover, withNames } = await rolledBack(async (tx) => {
    const r = await open(tx, "accounting.cash_transfer", accountant);
    const asRequester = mine((await listApprovalInbox(viewer.accountant(), { status: "pending", limit: 200 }, tx)).approvals, r.id);
    const asApprover = mine((await listApprovalInbox(viewer.admin(), { status: "pending", limit: 200 }, tx)).approvals, r.id);
    const withNames = mine((await listApprovalInbox(viewer.admin(), { entityId: r.entityId, withApprovers: true }, tx)).approvals, r.id);
    return { asRequester, asApprover, withNames };
  });
  assert.equal(asRequester.ownRequest, true);
  assert.equal(asRequester.canDecide, false, "the engine and the transfer handler both refuse the recorder");
  assert.equal(asRequester.blocked, "own_request");
  assert.ok(asRequester.approvers.includes(admin.name), "names who can decide");
  assert.ok(!asRequester.approvers.includes(accountant.name), "never the requester");
  assert.equal(asRequester.approvePermission, "accounting.manage");
  // Unchanged for anyone else who holds the permission.
  assert.equal(asApprover.canDecide, true);
  assert.equal(asApprover.blocked, null);
  assert.equal(asApprover.approvers, undefined, "names only when the caller cannot decide, or asks");
  assert.ok(Array.isArray(withNames.approvers) && withNames.approvers.includes(accountant.name) === false);
});

test("the one-admin emergency path is offered exactly where the engine allows it (approve only, no module rule)", async () => {
  const row = await rolledBack(async (tx) => {
    const r = await open(tx, "purchasing.bill", admin);
    return mine((await listApprovalInbox(viewer.admin(), { status: "pending", limit: 200 }, tx)).approvals, r.id);
  });
  assert.equal(row.canDecide, true);
  assert.equal(row.emergency, true, "the screen asks for the written reason and offers no reject");
  assert.deepEqual(row.approvers, [], "nobody else can decide it");
});

test("ARC-4: where the module refuses the requester, the sole admin is not offered the emergency path (policy unchanged)", async () => {
  const { row, refusal } = await rolledBack(async (tx) => {
    const r = await open(tx, "accounting.period_reopen", admin);
    const row = mine((await listApprovalInbox(viewer.admin(), { status: "pending", limit: 200 }, tx)).approvals, r.id);
    // What the decision itself would do: the module handler refuses the requester first.
    const refusal = await applyPeriodReopen(tx, r.entityId, {}, { id: admin.id, name: admin.name, role: "SUPER_ADMIN", permissions: ALL_PERMISSIONS }, admin.id).then(() => 0, (e: { status?: number }) => e.status);
    return { row, refusal };
  });
  assert.equal(refusal, 403, "the handler refuses whoever asked for the reopening");
  assert.equal(row.canDecide, false, "so the inbox does not offer it");
  assert.equal(row.emergency, false);
  assert.equal(row.blocked, "own_request");
  assert.deepEqual(row.approvers, [], "and says nobody else can — the permission must be given to someone");
});

test("opening batch: whoever prepared it is refused even when someone else submitted it", async () => {
  const { asPreparer, asSubmitter } = await rolledBack(async (tx) => {
    const b = await tx.openingBatch.create({ data: { number: `${TAG}-OPN`, kind: "initial", cutoverDate: "2026-01-01", status: "pending_approval", createdById: admin.id, createdBy: admin.name, submittedById: accountant.id, submittedBy: accountant.name } });
    const r = await open(tx, "accounting.opening_batch", accountant, b.id);
    const asPreparer = mine((await listApprovalInbox(viewer.admin(), { status: "pending", limit: 200 }, tx)).approvals, r.id);
    const asSubmitter = mine((await listApprovalInbox(viewer.accountant(), { status: "pending", limit: 200 }, tx)).approvals, r.id);
    return { asPreparer, asSubmitter };
  });
  assert.equal(asPreparer.canDecide, false, "applyOpeningBatchDecision refuses the preparer");
  assert.equal(asPreparer.blocked, "prepared_or_submitted");
  assert.equal(asPreparer.ownRequest, false);
  assert.equal(asSubmitter.blocked, "no_permission", "the submitter does not hold accounting.opening.approve");
  assert.deepEqual(asSubmitter.approvers, [], "the only holder prepared it: nobody can approve it as it stands");
});

test("paging, the type filter and one request by id", async () => {
  const out = await rolledBack(async (tx) => {
    const base = Date.now() + 86_400_000; // newer than anything already there
    const made: string[] = [];
    for (let i = 0; i < 12; i++) made.push((await open(tx, "accounting.supplier_payment", accountant, undefined, new Date(base + i * 1000))).id);
    const p1 = await listApprovalInbox(viewer.admin(), { type: "accounting.supplier_payment", limit: 5 }, tx);
    const p2 = await listApprovalInbox(viewer.admin(), { type: "accounting.supplier_payment", limit: 5, offset: 5 }, tx);
    const count = await tx.approvalRequest.count({ where: { type: "accounting.supplier_payment" } });
    const one = await listApprovalInbox(viewer.admin(), { id: made[3] }, tx);
    const hidden = await listApprovalInbox(viewer.supervisor(), { id: made[3] }, tx);
    const bad = await listApprovalInbox(viewer.admin(), { type: "no.such_type" }, tx).then(() => 0, (e: { status?: number }) => e.status);
    return { made, p1, p2, count, one, hidden, bad };
  });
  assert.deepEqual(out.p1.approvals.map((a: any) => a.id), [...out.made].reverse().slice(0, 5), "newest first");
  assert.deepEqual(out.p2.approvals.map((a: any) => a.id), [...out.made].reverse().slice(5, 10), "the next window, no repeats");
  assert.equal(out.p1.total, out.count, "the total counts every match");
  assert.ok(out.p1.approvals.every((a: any) => a.type === "accounting.supplier_payment"));
  assert.deepEqual(out.one.approvals.map((a: any) => a.id), [out.made[3]]);
  assert.equal(out.hidden.approvals.length, 0, "?id= shows only what the caller may see");
  assert.equal(out.bad, 400);
});

test("statements do not grow with the number of pending requests (5 vs 50)", async () => {
  const types: ApprovalType[] = ["orders.shortage", "accounting.cash_transfer", "accounting.opening_batch", "hr.payroll_run", "sales.credit"];
  const measure = (n: number) => rolledBack(async (tx) => {
    for (let i = 0; i < n; i++) await open(tx, types[i % types.length], accountant);
    const approver = await countQueries(() => listApprovalInbox(viewer.admin(), { status: "pending", limit: 200 }, tx));
    const requester = await countQueries(() => listApprovalInbox(viewer.accountant(), { status: "pending", limit: 200 }, tx));
    return { approver: approver.queries, requester: requester.queries, rows: approver.result.approvals.length };
  });
  const five = await measure(5);
  const fifty = await measure(50);
  assert.ok(fifty.rows >= 50 && fifty.rows < 200, `the window holds them all (${fifty.rows})`);
  assert.equal(fifty.approver, five.approver, `approver: ${five.approver} vs ${fifty.approver} statements`);
  assert.equal(fifty.requester, five.requester, `requester: ${five.requester} vs ${fifty.requester} statements`);
  // The page with its decisions (2) + one per module rule that reads its record (opening batch,
  // payroll) + the active users once when names are needed.
  assert.ok(five.approver <= 5, `approver view: ${five.approver} statements`);
  assert.ok(five.requester <= 6, `requester view: ${five.requester} statements`);
  console.log(`listApprovalInbox statements — approver ${five.approver}/${fifty.approver}, requester ${five.requester}/${fifty.requester} (5/50 pending)`);
});
