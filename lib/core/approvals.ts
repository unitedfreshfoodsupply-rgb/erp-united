import { Prisma } from "@prisma/client";
import { asText } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { advisoryXactLock, advisoryXactLocks } from "@/lib/dbLock";
import { nextDocumentNumber, nextDocumentNumbers } from "@/lib/core/sequences";
import { notify, notifyMany, usersWithPermission } from "@/lib/core/notifications";
import { newId } from "@/lib/core/ids";
import { writeAuditMany, type AuditInput } from "@/lib/audit";
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
  "inventory.grading_loss": {
    label: "اعتماد خسارة فرز عند الاستلام",
    entityType: "stock_intake",
    approvePermission: "stock.approve_adjustments",
    levels: 1,
    link: (id) => `/stock?intake=${id}`,
  },
  "stock.issue_exception_close": {
    label: "قفل استثناء صرف بدون حركة مخزون",
    entityType: "stock_issue_exception",
    approvePermission: "stock.approve_adjustments",
    levels: 1,
    link: () => `/stock/inventory?tab=exceptions`,
  },
  "inventory.adjustment": {
    label: "اعتماد تسوية مخزون",
    entityType: "inventory_document",
    approvePermission: "stock.approve_adjustments",
    levels: 1,
    link: (id) => `/stock/inventory?doc=${id}`,
  },
  "sales.price_exception": {
    label: "اعتماد سعر أقل من التكلفة أو خصم فوق الحد",
    entityType: "order",
    approvePermission: "sales.pricing.approve",
    levels: 1,
    link: (id) => `/orders/${id}`,
  },
  "purchasing.request": {
    label: "اعتماد طلب شراء",
    entityType: "purchase_request",
    approvePermission: "purchasing.requests.approve",
    levels: 1,
    link: (id) => `/purchasing/requests?id=${id}`,
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
  // Purchasing custody (Nov 2026): money handed to a buyer leaves the treasury only once someone
  // other than the requester approves it — the same approver as a supplier payment.
  "hr.custody_advance": {
    label: "اعتماد عهدة شراء",
    entityType: "employee_custody_request",
    approvePermission: "accounting.manage",
    levels: 1,
    link: () => "/hr?tab=custody",
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
  "accounting.period_reopen": {
    label: "إعادة فتح شهر محاسبي مقفول",
    entityType: "accounting_period",
    approvePermission: "accounting.periods.reopen",
    levels: 1,
    link: () => "/accounting?tab=periods",
  },
  "accounting.year_reopen": {
    label: "إعادة فتح سنة مالية مقفولة",
    entityType: "fiscal_year",
    approvePermission: "accounting.periods.reopen",
    levels: 1,
    link: () => "/accounting?tab=periods",
  },
  "accounting.opening_batch": {
    label: "اعتماد الأرصدة الافتتاحية",
    entityType: "opening_batch",
    approvePermission: "accounting.opening.approve",
    levels: 1,
    link: () => "/accounting?tab=opening",
  },
  "accounting.opening_migration_close": {
    label: "قفل الترحيل الافتتاحي",
    entityType: "opening_migration",
    approvePermission: "accounting.opening.approve",
    levels: 1,
    link: () => "/accounting?tab=opening",
  },
  "accounting.manual_journal": {
    label: "اعتماد قيد يدوي",
    entityType: "journal_request",
    approvePermission: "accounting.journals.approve",
    levels: 1,
    link: () => "/accounting?tab=journals",
  },
  "accounting.supplier_payment": {
    label: "اعتماد سداد مورد",
    entityType: "supplier_payment_request",
    approvePermission: "accounting.manage",
    levels: 1,
    link: () => "/accounting?tab=payments",
  },
  "accounting.cash_transfer": {
    label: "اعتماد تحويل بين الخزائن والبنوك",
    entityType: "cash_transfer",
    approvePermission: "accounting.manage",
    levels: 1,
    link: () => "/accounting?tab=treasury",
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

/**
 * requestApproval for many requests at once (PW-2, Nov 2026: an order saved awaiting stock asks
 * one purchase-request approval per short line, ~9 round trips each). The same result as calling
 * requestApproval for each input in turn — an input whose (type, entity) already has a pending
 * request gets that one back, numbers follow the input order, one approval_requested audit row
 * and one notice per approver for each new request — in a fixed number of statements: every
 * lock in one (sorted, the global order), approvers resolved once per permission.
 */
export async function requestApprovals(tx: Tx, inputs: Parameters<typeof requestApproval>[1][]) {
  if (!inputs.length) return [];
  await advisoryXactLocks(tx, inputs.map((i) => lockKey(i.type, i.entityId)));
  const key = (type: string, entityId: string) => `${type}|${entityId}`;
  const pending = await tx.approvalRequest.findMany({ where: { status: "pending", OR: inputs.map((i) => ({ type: i.type, entityId: i.entityId })) } });
  const open = new Map(pending.map((r) => [key(r.type, r.entityId), r]));
  // The first input of a (type, entity) opens it; any later one gets it back, as it would in turn.
  const fresh = inputs.filter((i, at) => !open.has(key(i.type, i.entityId)) && inputs.findIndex((j) => key(j.type, j.entityId) === key(i.type, i.entityId)) === at);
  const numbers = fresh.length ? await nextDocumentNumbers(tx, "core.approval", todayLocalISO(), fresh.length) : [];
  const now = Date.now();
  const data = fresh.map((input, n) => {
    const def: ApprovalTypeDef = APPROVAL_TYPES[input.type];
    return {
      id: newId(),
      number: numbers[n],
      // One after another, as requestApproval in turn: the inbox keeps the order they were asked in.
      createdAt: new Date(now + n),
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
    };
  });
  const created = data.length ? await tx.approvalRequest.createManyAndReturn({ data }) : [];
  const byId = new Map(created.map((r) => [r.id, r]));
  const audits: AuditInput[] = [];
  const notices: { input: (typeof fresh)[number]; request: (typeof created)[number] }[] = [];
  for (const [n, input] of fresh.entries()) {
    const def: ApprovalTypeDef = APPROVAL_TYPES[input.type];
    const request = byId.get(data[n].id)!;
    open.set(key(input.type, input.entityId), request);
    audits.push({
      userId: input.requester.id,
      userName: input.requester.name,
      role: input.requester.role,
      action: "approval_requested",
      entityType: "approval_request",
      entityId: request.id,
      orderId: def.entityType === "order" ? input.entityId : null,
      fieldChanged: input.type,
      newValue: `${request.number} · ${input.title}`,
      reason: input.reason,
      source: "system",
      deviceId: input.requester.deviceId,
    });
    if (!input.silent) notices.push({ input, request });
  }
  await writeAuditMany(audits, tx);
  const approvers = new Map<Permission, string[]>();
  for (const { input } of notices) {
    const permission = APPROVAL_TYPES[input.type].approvePermission as Permission;
    if (!approvers.has(permission)) approvers.set(permission, await usersWithPermission(tx, permission));
  }
  await notifyMany(
    tx,
    notices.map(({ input, request }) => {
      const def: ApprovalTypeDef = APPROVAL_TYPES[input.type];
      return {
        userIds: approvers.get(def.approvePermission)!.filter((id) => id !== input.requester.id),
        n: {
          type: "approval.requested",
          severity: "warning",
          title: `مطلوب موافقتك: ${input.title}`,
          body: input.summary ?? def.label,
          entityType: "approval_request",
          entityId: request.id,
          link: def.link(input.entityId),
          dedupeKey: `approval:${request.id}`,
        },
      };
    })
  );
  const freshKeys = new Set(fresh.map((i) => key(i.type, i.entityId)));
  const seen = new Set<string>();
  return inputs.map((i) => {
    const k = key(i.type, i.entityId);
    const createdNow = freshKeys.has(k) && !seen.has(k);
    seen.add(k);
    return { request: open.get(k)!, created: createdNow };
  });
}

/** Takes these (type, entity) pairs' request locks in one statement, for a caller that must hold
 * them before it touches the entity itself (a consistent lock order with the paths that raise them). */
export async function lockApprovalRequests(tx: Tx, pairs: { type: ApprovalType; entityId: string }[]) {
  await advisoryXactLocks(tx, pairs.map((p) => lockKey(p.type, p.entityId)));
}

/**
 * cancelPendingApproval for many (type, entity) pairs at once (PW-2, Nov 2026): the same closed
 * rows and approval_cancelled audit rows in a fixed number of statements. A pair with nothing
 * pending is skipped; a request that changed meanwhile refuses the whole call (P2025 → 409), as
 * the one-row update did. Returns how many were closed.
 */
export async function cancelPendingApprovals(tx: Tx, inputs: Parameters<typeof cancelPendingApproval>[1][]) {
  if (!inputs.length) return 0;
  await advisoryXactLocks(tx, inputs.map((i) => lockKey(i.type, i.entityId)));
  const pending = await tx.approvalRequest.findMany({ where: { status: "pending", OR: inputs.map((i) => ({ type: i.type, entityId: i.entityId })) } });
  const byKey = new Map(pending.map((r) => [`${r.type}|${r.entityId}`, r]));
  const closing = new Map<string, { input: (typeof inputs)[number]; request: (typeof pending)[number] }>();
  for (const input of inputs) {
    const request = byKey.get(`${input.type}|${input.entityId}`);
    if (request && !closing.has(request.id)) closing.set(request.id, { input, request });
  }
  const byReason = new Map<string, (typeof pending)[number][]>();
  for (const { input, request } of closing.values()) byReason.set(input.reason, [...(byReason.get(input.reason) ?? []), request]);
  for (const [reason, rows] of byReason) {
    const res = await tx.approvalRequest.updateMany({
      where: { OR: rows.map((r) => ({ id: r.id, version: r.version })) },
      data: { status: "cancelled", closedReason: reason, decidedAt: new Date(), version: { increment: 1 } },
    });
    if (res.count !== rows.length) throw new Prisma.PrismaClientKnownRequestError("An approval request changed while it was being cancelled", { code: "P2025", clientVersion: Prisma.prismaVersion.client });
  }
  await writeAuditMany(
    [...closing.values()].map(({ input, request }) => ({
      userId: input.actor.id,
      userName: input.actor.name,
      role: input.actor.role,
      action: "approval_cancelled",
      entityType: "approval_request" as const,
      entityId: request.id,
      orderId: request.entityType === "order" ? request.entityId : null,
      fieldChanged: request.type,
      oldValue: "pending",
      newValue: "cancelled",
      reason: input.reason,
      source: "system" as const,
      deviceId: input.actor.deviceId,
    })),
    tx
  );
  return closing.size;
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
  // Segregation of duties (CTL-01): the requester never decides their own request —
  // except a SUPER_ADMIN when NO other active user can decide it (a one-person setup),
  // and only with a written reason; that emergency path is audited and broadcast.
  let emergencySelfApproval = false;
  if (opts.requireDifferentApprover && decider.id && decider.id === request.requestedById) {
    const others = (await usersWithPermission(tx, def.approvePermission)).filter((id) => id !== decider.id);
    const reason = asText(opts.comment, "comment")?.trim() ?? "";
    if (decision !== "approve" || decider.role !== "SUPER_ADMIN" || others.length > 0) {
      throw new ApiError(403, others.length > 0 ? "مينفعش توافق على طلب انت اللي طالبه — فيه زميل عنده الصلاحية يقرر" : "مينفعش توافق على طلب انت اللي طالبه");
    }
    if (reason.length < 10) throw new ApiError(400, "مفيش موافق تاني على النظام: الموافقة الذاتية الطارئة لازم يتكتب لها سبب واضح (10 حروف على الأقل)");
    emergencySelfApproval = true;
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
  if (emergencySelfApproval) {
    await writeAudit(
      {
        userId: decider.id,
        userName: decider.name,
        role: decider.role,
        action: "emergency_self_approval",
        entityType: "approval_request",
        entityId: request.id,
        orderId: request.entityType === "order" ? request.entityId : null,
        fieldChanged: request.type,
        newValue: `${request.number} · ${request.title}`,
        reason: asText(opts.comment, "comment")?.trim(),
        source: "user",
        deviceId: decider.deviceId,
      },
      tx
    );
    await notify(tx, { permission: "audit.view" }, {
      type: "approval.emergency_self",
      severity: "warning",
      title: `موافقة ذاتية طارئة: ${request.title}`,
      body: `${decider.name} وافق على طلب هو اللي طالبه (${request.number}) لعدم وجود موافق تاني`,
      entityType: "approval_request",
      entityId: request.id,
      link: "/approvals",
      dedupeKey: `emergency-self:${request.id}`,
    });
  }

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
