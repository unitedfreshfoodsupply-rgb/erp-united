import { Prisma } from "@prisma/client";
import { asText } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { advisoryXactLock } from "@/lib/dbLock";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { notify } from "@/lib/core/notifications";
import { todayLocalISO } from "@/lib/localDate";
import type { Permission } from "@/lib/permissions";
import type { Tx } from "@/lib/tx";

/**
 * Approval engine — the part that knows nothing about any module.
 *
 * A module asks for approval with requestApproval() inside its own transaction; the
 * decision is taken through lib/core/approval-handlers.ts, which runs the module's
 * handler in the same transaction as the final approval. So an approval is never
 * recorded without its effect, and the effect never happens without the approval.
 *
 * Invariants:
 *  - At most ONE pending request per (type, entity) — a partial unique index, plus an
 *    advisory lock here so concurrent requesters coalesce instead of failing.
 *  - Requesting again while one is pending returns the pending one (idempotent).
 *  - Decisions are append-only rows, one per level; the request carries the counters.
 */

export type ApprovalTypeDef = {
  label: string;
  entityType: string;
  /** Who may decide. Approvers are notified through the same effective permission. */
  approvePermission: Permission;
  levels: number;
  /** Where an approver goes to see the thing being approved. */
  link: (entityId: string) => string;
};

export const APPROVAL_TYPES = {
  "orders.shortage": {
    label: "اعتماد فرق كمية في أوردر",
    entityType: "order",
    approvePermission: "orders.approve",
    levels: 1,
    link: (id) => `/orders/${id}`,
  },
  "inventory.adjustment": {
    label: "اعتماد تسوية مخزون",
    entityType: "inventory_document",
    approvePermission: "stock.approve_adjustments",
    levels: 1,
    link: (id) => `/stock/inventory?doc=${id}`,
  },
  "purchasing.order": {
    label: "اعتماد أمر شراء",
    entityType: "purchase_order",
    approvePermission: "purchasing.orders.approve",
    levels: 1,
    link: (id) => `/purchasing?po=${id}`,
  },
  "purchasing.bill": {
    label: "اعتماد فرق فاتورة مورد",
    entityType: "supplier_bill",
    approvePermission: "purchasing.bills.approve",
    levels: 1,
    link: (id) => `/purchasing?bill=${id}`,
  },
  "hr.expense": {
    label: "اعتماد مصروف",
    entityType: "expense",
    approvePermission: "hr.expenses.approve",
    levels: 1,
    link: () => "/hr",
  },
  "hr.attendance_correction": {
    label: "اعتماد تصحيح حضور",
    entityType: "attendance_correction",
    approvePermission: "hr.attendance.approve",
    levels: 1,
    link: () => "/hr/attendance?tab=corrections",
  },
  "hr.leave": {
    label: "اعتماد إجازة",
    entityType: "leave_request",
    approvePermission: "hr.leave.approve",
    levels: 1,
    link: () => "/hr/leave",
  },
  "hr.compensation_change": {
    label: "اعتماد مرتب موظف",
    entityType: "employee_compensation",
    approvePermission: "hr.payroll.approve",
    levels: 1,
    link: () => "/hr/payroll",
  },
  "hr.payroll_run": {
    label: "اعتماد مسير مرتبات",
    entityType: "payroll_run",
    approvePermission: "hr.payroll.approve",
    levels: 1,
    link: () => "/hr/payroll",
  },
  "sales.credit": {
    label: "موافقة ائتمان لأوردر",
    entityType: "order",
    approvePermission: "sales.credit.manage",
    levels: 1,
    link: (id) => `/orders/${id}`,
  },
} satisfies Record<string, ApprovalTypeDef>;

export type ApprovalType = keyof typeof APPROVAL_TYPES;

export function isApprovalType(v: unknown): v is ApprovalType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(APPROVAL_TYPES, v);
}

export type Requester = { id: string | null; name: string; role: string; deviceId?: string };

function lockKey(type: string, entityId: string) {
  return `approval:${type}:${entityId}`;
}

export async function findPending(db: Pick<Tx, "approvalRequest">, type: ApprovalType, entityId: string) {
  return db.approvalRequest.findFirst({ where: { type, entityId, status: "pending" } });
}

/** Opens a request (or returns the one already pending) and notifies the approvers. */
export async function requestApproval(
  tx: Tx,
  input: {
    type: ApprovalType;
    entityId: string;
    title: string;
    summary?: string;
    amount?: Prisma.Decimal | number | string | null;
    payload?: Prisma.InputJsonValue;
    reason?: string;
    requester: Requester;
    /** Skip notifying approvers — for a request opened only to be decided at once. */
    silent?: boolean;
  }
) {
  const def: ApprovalTypeDef = APPROVAL_TYPES[input.type];
  await advisoryXactLock(tx, lockKey(input.type, input.entityId));
  const existing = await findPending(tx, input.type, input.entityId);
  if (existing) return { request: existing, created: false };

  const number = await nextDocumentNumber(tx, "core.approval", todayLocalISO());
  const request = await tx.approvalRequest.create({
    data: {
      number,
      type: input.type,
      entityType: def.entityType,
      entityId: input.entityId,
      title: input.title,
      summary: input.summary ?? null,
      amount: input.amount == null ? null : new Prisma.Decimal(input.amount),
      payload: input.payload ?? Prisma.JsonNull,
      requiredLevels: def.levels,
      requestedById: input.requester.id,
      requestedBy: input.requester.name,
      requestReason: input.reason ?? null,
    },
  });

  await writeAudit(
    {
      userId: input.requester.id,
      userName: input.requester.name,
      role: input.requester.role,
      action: "approval_requested",
      entityType: "approval_request",
      entityId: request.id,
      orderId: def.entityType === "order" ? input.entityId : null,
      fieldChanged: input.type,
      newValue: `${number} · ${input.title}`,
      reason: input.reason,
      source: "system",
      deviceId: input.requester.deviceId,
    },
    tx
  );

  if (!input.silent) await notify(
    tx,
    { permission: def.approvePermission, exclude: [input.requester.id] },
    {
      type: "approval.requested",
      severity: "warning",
      title: `مطلوب موافقتك: ${input.title}`,
      body: input.summary ?? def.label,
      entityType: "approval_request",
      entityId: request.id,
      link: def.link(input.entityId),
      dedupeKey: `approval:${request.id}`,
    }
  );

  return { request, created: true };
}

/** Closes a pending request that no longer applies (the condition went away). */
export async function cancelPendingApproval(
  tx: Tx,
  input: { type: ApprovalType; entityId: string; reason: string; actor: Requester }
) {
  await advisoryXactLock(tx, lockKey(input.type, input.entityId));
  const pending = await findPending(tx, input.type, input.entityId);
  if (!pending) return null;
  const closed = await tx.approvalRequest.update({
    where: { id: pending.id, version: pending.version },
    data: { status: "cancelled", closedReason: input.reason, decidedAt: new Date(), version: { increment: 1 } },
  });
  await writeAudit(
    {
      userId: input.actor.id,
      userName: input.actor.name,
      role: input.actor.role,
      action: "approval_cancelled",
      entityType: "approval_request",
      entityId: pending.id,
      orderId: pending.entityType === "order" ? pending.entityId : null,
      fieldChanged: pending.type,
      oldValue: "pending",
      newValue: "cancelled",
      reason: input.reason,
      source: "system",
      deviceId: input.actor.deviceId,
    },
    tx
  );
  return closed;
}

/** Requests an actor may decide (pending, of types they hold the permission for) and
 * the ones they raised themselves. */
export async function listApprovals(
  actor: { id: string | null; permissions: readonly string[] },
  opts: { status?: string; limit?: number } = {}
) {
  const decidable = (Object.keys(APPROVAL_TYPES) as ApprovalType[]).filter((t) =>
    actor.permissions.includes(APPROVAL_TYPES[t].approvePermission)
  );
  const status = opts.status && ["pending", "approved", "rejected", "cancelled"].includes(opts.status) ? opts.status : undefined;
  const rows = await prisma.approvalRequest.findMany({
    where: {
      ...(status ? { status } : {}),
      OR: [{ type: { in: decidable } }, ...(actor.id ? [{ requestedById: actor.id }] : [])],
    },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    include: { decisions: { orderBy: { level: "asc" } } },
  });
  return rows.map((r) => ({
    ...r,
    label: isApprovalType(r.type) ? APPROVAL_TYPES[r.type].label : r.type,
    link: isApprovalType(r.type) ? APPROVAL_TYPES[r.type].link(r.entityId) : null,
    canDecide: r.status === "pending" && decidable.includes(r.type as ApprovalType),
  }));
}

export type Decider = Requester & { permissions: readonly string[] };

/**
 * Records one decision on a pending request and advances it. Does NOT run the
 * module's effect — the caller (a module service, or approval-handlers.ts) does that
 * in the same transaction when `final` is true.
 *
 * Refuses: a request that is no longer pending, a decider without the type's
 * permission, a second decision by the same person, and — when the
 * approvals.require_different_approver setting is on — the requester deciding
 * their own request.
 */
export async function recordDecision(
  tx: Tx,
  request: { id: string; type: string; status: string; version: number; requestedById: string | null; approvedLevels: number; requiredLevels: number; entityType: string; entityId: string; number: string; title: string },
  decision: "approve" | "reject",
  decider: Decider,
  opts: { comment?: string; requireDifferentApprover: boolean }
): Promise<{ status: "pending" | "approved" | "rejected"; final: boolean }> {
  if (!isApprovalType(request.type)) throw new ApiError(400, "نوع موافقة غير معروف");
  const def: ApprovalTypeDef = APPROVAL_TYPES[request.type];
  if (!decider.permissions.includes(def.approvePermission)) {
    throw new ApiError(403, "مالكش صلاحية تقرر في الطلب ده");
  }
  if (request.status !== "pending") throw new ApiError(409, "الطلب ده اتقفل بالفعل");
  if (opts.requireDifferentApprover && decider.id && decider.id === request.requestedById) {
    throw new ApiError(403, "مينفعش توافق على طلب انت اللي طالبه");
  }
  if (decider.id) {
    const already = await tx.approvalDecision.findFirst({ where: { requestId: request.id, deciderId: decider.id } });
    if (already) throw new ApiError(409, "انت قررت في الطلب ده قبل كده");
  }

  const level = request.approvedLevels + 1;
  const final = decision === "reject" || level >= request.requiredLevels;
  const status = decision === "reject" ? "rejected" : final ? "approved" : "pending";

  try {
    await tx.approvalRequest.update({
      where: { id: request.id, version: request.version, status: "pending" },
      data: {
        status,
        approvedLevels: decision === "approve" ? level : request.approvedLevels,
        decidedAt: final ? new Date() : null,
        version: { increment: 1 },
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "الطلب اتغيّر من واحد تاني، حدّث الشاشة");
    throw err;
  }
  await tx.approvalDecision.create({
    data: {
      requestId: request.id,
      level,
      decision,
      deciderId: decider.id,
      decider: decider.name,
      deciderRole: decider.role,
      comment: asText(opts.comment, "comment")?.trim() || null,
    },
  });

  await writeAudit(
    {
      userId: decider.id,
      userName: decider.name,
      role: decider.role,
      action: decision === "approve" ? (final ? "approval_approved" : "approval_level_approved") : "approval_rejected",
      entityType: "approval_request",
      entityId: request.id,
      orderId: request.entityType === "order" ? request.entityId : null,
      fieldChanged: request.type,
      oldValue: "pending",
      newValue: status,
      reason: opts.comment,
      source: "user",
      deviceId: decider.deviceId,
    },
    tx
  );

  if (final && request.requestedById) {
    await notify(
      tx,
      { userIds: [request.requestedById], exclude: [decider.id] },
      {
        type: "approval.decided",
        severity: decision === "approve" ? "info" : "warning",
        title: `${decision === "approve" ? "اتوافق على" : "اترفض"}: ${request.title}`,
        body: opts.comment?.trim() ? `${decider.name}: ${opts.comment.trim()}` : `بواسطة ${decider.name}`,
        entityType: "approval_request",
        entityId: request.id,
        link: def.link(request.entityId),
        dedupeKey: `approval-decided:${request.id}`,
      }
    );
  }
  return { status, final };
}
