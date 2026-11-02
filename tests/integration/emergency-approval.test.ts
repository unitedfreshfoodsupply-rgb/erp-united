/**
 * Emergency self-approval (CTL-01) — the decision engine itself, every branch.
 *
 * With approvals.require_different_approver on (the default), a requester never decides
 * their own request — EXCEPT a SUPER_ADMIN when no other active user holds the type's
 * approving permission, with a written reason of at least 10 characters; that path is
 * audited (emergency_self_approval) and broadcast to the audit viewers.
 *
 * Each case runs inside a transaction that is rolled back, so nothing is left behind.
 * The type used is purchasing.bill: its permission (purchasing.bills.approve) belongs to
 * SUPER_ADMIN only, and the test asserts that precondition instead of assuming it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./_db";
import { requestApproval, recordDecision } from "@/lib/core/approvals";
import { usersWithPermission } from "@/lib/core/notifications";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/permissions";

class Rollback extends Error {}
let admin: { id: string; name: string };
let accountant: { id: string; name: string };
let supervisor: { id: string; name: string };
const VALID = "لا يوجد موافق آخر على النظام — موافقة طارئة موثقة";

before(async () => {
  admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" }, select: { id: true, name: true } });
  accountant = await prisma.user.findUniqueOrThrow({ where: { username: "karim" }, select: { id: true, name: true } });
  supervisor = await prisma.user.findUniqueOrThrow({ where: { username: "sara" }, select: { id: true, name: true } });
});
after(() => prisma.$disconnect());

/** Runs `fn` in a transaction and always rolls it back; returns fn's result or its error. */
async function inRolledBackTx<T>(fn: (tx: any) => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let value: T | undefined;
  let error: unknown;
  try {
    await prisma.$transaction(async (tx) => {
      try {
        value = await fn(tx);
      } catch (e) {
        error = e;
      }
      throw new Rollback();
    }, { timeout: 20_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return { value, error };
}

const asDecider = (u: { id: string; name: string }, role: string, permissions: readonly string[]) => ({ id: u.id, name: u.name, role, permissions });
// orders.shortage requests are audited against their order (FK), so they point at a real
// seeded order; everything still happens inside a rolled-back transaction.
const open = async (tx: any, type: "purchasing.bill" | "orders.shortage", requester: { id: string; name: string }, role: string) => {
  const entityId = type === "orders.shortage" ? (await tx.order.findFirstOrThrow({ select: { id: true } })).id : `emergency-test-${type}-${Date.now()}-${Math.random()}`;
  return requestApproval(tx, { type, entityId, title: "اختبار موافقة طارئة", requester: { id: requester.id, name: requester.name, role } });
};

test("precondition: only SUPER_ADMIN holds purchasing.bills.approve; another role holds orders.approve", async () => {
  const holders = await usersWithPermission(prisma, "purchasing.bills.approve");
  assert.deepEqual(holders, [admin.id], "the sole holder of purchasing.bills.approve must be admin for these cases to mean anything");
  assert.ok(!ROLE_PERMISSIONS.ACCOUNTANT.includes("purchasing.bills.approve"), "ACCOUNTANT does not hold it by role");
  assert.ok((await usersWithPermission(prisma, "orders.approve")).includes(supervisor.id), "a supervisor holds orders.approve");
});

test("SUPER_ADMIN sole holder + reason of 10+ characters → approved, audited, broadcast", async () => {
  const { value, error } = await inRolledBackTx(async (tx) => {
    const { request } = await open(tx, "purchasing.bill", admin, "SUPER_ADMIN");
    const outcome = await recordDecision(tx, request, "approve", asDecider(admin, "SUPER_ADMIN", ALL_PERMISSIONS), { comment: VALID, requireDifferentApprover: true });
    const req = await tx.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    const auditRows = await tx.auditLog.findMany({ where: { action: "emergency_self_approval", entityId: request.id } });
    const broadcast = await tx.notification.findMany({ where: { type: "approval.emergency_self", entityId: request.id } });
    const auditViewers = await usersWithPermission(tx, "audit.view");
    return { outcome, status: req.status, auditRows, broadcast, auditViewers };
  });
  assert.equal(error, undefined, `unexpected refusal: ${(error as Error)?.message}`);
  assert.equal(value!.outcome.status, "approved");
  assert.equal(value!.status, "approved", "the request row is approved");
  assert.equal(value!.auditRows.length, 1, "exactly one emergency_self_approval audit row");
  assert.equal(value!.auditRows[0].userId, admin.id);
  assert.equal(value!.auditRows[0].reason, VALID, "the written reason is on the audit row");
  assert.ok(value!.broadcast.length >= 1, "the emergency approval is broadcast");
  const notified = new Set(value!.broadcast.map((n: { recipientId: string }) => n.recipientId));
  for (const id of value!.auditViewers) assert.ok(notified.has(id), `audit viewer ${id} is notified`);
});

test("SUPER_ADMIN sole holder with a reason shorter than 10 characters → 400, nothing decided", async () => {
  const { value, error } = await inRolledBackTx(async (tx) => {
    const { request } = await open(tx, "purchasing.bill", admin, "SUPER_ADMIN");
    try {
      await recordDecision(tx, request, "approve", asDecider(admin, "SUPER_ADMIN", ALL_PERMISSIONS), { comment: "طارئ جدا", requireDifferentApprover: true });
    } catch (e) {
      const req = await tx.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
      return { e, status: req.status, audit: await tx.auditLog.count({ where: { action: "emergency_self_approval", entityId: request.id } }) };
    }
    return { e: null, status: "decided", audit: 0 };
  });
  assert.equal(error, undefined);
  assert.equal((value!.e as { status?: number })?.status, 400);
  assert.match((value!.e as Error).message, /10/);
  assert.equal(value!.status, "pending", "still pending");
  assert.equal(value!.audit, 0, "no emergency audit row");
});

test("SUPER_ADMIN sole holder with no reason at all → 400", async () => {
  const { value } = await inRolledBackTx(async (tx) => {
    const { request } = await open(tx, "purchasing.bill", admin, "SUPER_ADMIN");
    try {
      await recordDecision(tx, request, "approve", asDecider(admin, "SUPER_ADMIN", ALL_PERMISSIONS), { requireDifferentApprover: true });
      return { status: 0 };
    } catch (e) {
      return { status: (e as { status?: number }).status };
    }
  });
  assert.equal(value!.status, 400);
});

test("the emergency path is for approving only: a SUPER_ADMIN rejecting their own request → 403", async () => {
  const { value } = await inRolledBackTx(async (tx) => {
    const { request } = await open(tx, "purchasing.bill", admin, "SUPER_ADMIN");
    try {
      await recordDecision(tx, request, "reject", asDecider(admin, "SUPER_ADMIN", ALL_PERMISSIONS), { comment: VALID, requireDifferentApprover: true });
      return { status: 0 };
    } catch (e) {
      return { status: (e as { status?: number }).status };
    }
  });
  assert.equal(value!.status, 403);
});

test("a SUPER_ADMIN cannot self-approve when another active user holds the permission → 403, even with a reason", async () => {
  const { value, error } = await inRolledBackTx(async (tx) => {
    const { request } = await open(tx, "orders.shortage", admin, "SUPER_ADMIN");
    try {
      await recordDecision(tx, request, "approve", asDecider(admin, "SUPER_ADMIN", ALL_PERMISSIONS), { comment: VALID, requireDifferentApprover: true });
      return { status: 0, message: "" };
    } catch (e) {
      return { status: (e as { status?: number }).status, message: (e as Error).message };
    }
  });
  assert.equal(error, undefined, `setup failed: ${(error as Error)?.message}`);
  assert.equal(value!.status, 403);
  assert.match(value!.message, /زميل/, "the refusal names the colleague who can decide");
});

test("a non-SUPER_ADMIN who is the ONLY holder cannot use the emergency path → 403", async () => {
  // Inside the rolled-back transaction: admin is made inactive and the accountant is given
  // the permission (as an override would), so the accountant is the sole holder.
  const { value } = await inRolledBackTx(async (tx) => {
    await tx.user.update({ where: { id: admin.id }, data: { active: false } });
    const holdersOtherThanAccountant = (await usersWithPermission(tx, "purchasing.bills.approve")).filter((id: string) => id !== accountant.id);
    const { request } = await open(tx, "purchasing.bill", accountant, "ACCOUNTANT");
    try {
      await recordDecision(tx, request, "approve", asDecider(accountant, "ACCOUNTANT", [...ROLE_PERMISSIONS.ACCOUNTANT, "purchasing.bills.approve"]), { comment: VALID, requireDifferentApprover: true });
      return { holdersOtherThanAccountant, status: 0 };
    } catch (e) {
      return { holdersOtherThanAccountant, status: (e as { status?: number }).status };
    }
  });
  assert.deepEqual(value!.holdersOtherThanAccountant, [], "precondition: nobody else can decide");
  assert.equal(value!.status, 403, "the emergency exception is for SUPER_ADMIN only");
});

test("cleanup check: nothing from these cases persisted", async () => {
  assert.equal(await prisma.approvalRequest.count({ where: { OR: [{ entityId: { startsWith: "emergency-test-" } }, { title: "اختبار موافقة طارئة" }] } }), 0);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).active, true);
});
