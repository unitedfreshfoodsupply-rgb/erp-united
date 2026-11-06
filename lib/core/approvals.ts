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
import { applyOverrides } from "@/lib/authz-core";
import { todayLocalISO } from "@/lib/localDate";
import type { Permission } from "@/lib/permissions";
import type { Role } from "@/lib/types";
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
  /** The linked page has no decide control (or names no record): approvers are notified with
   * a link to the request in the approvals inbox instead. */
  decidedInInbox?: true;
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
    decidedInInbox: true,
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
    decidedInInbox: true,
  },
  "accounting.year_reopen": {
    label: "إعادة فتح سنة مالية مقفولة",
    entityType: "fiscal_year",
    approvePermission: "accounting.periods.reopen",
    levels: 1,
    link: () => "/accounting?tab=periods",
    decidedInInbox: true,
  },
  "accounting.opening_batch": {
    label: "اعتماد الأرصدة الافتتاحية",
    entityType: "opening_batch",
    approvePermission: "accounting.opening.approve",
    levels: 1,
    link: () => "/accounting?tab=opening",
    decidedInInbox: true,
  },
  "accounting.opening_migration_close": {
    label: "قفل الترحيل الافتتاحي",
    entityType: "opening_migration",
    approvePermission: "accounting.opening.approve",
    levels: 1,
    link: () => "/accounting?tab=opening",
    decidedInInbox: true,
  },
  "accounting.manual_journal": {
    label: "اعتماد قيد يدوي",
    entityType: "journal_request",
    approvePermission: "accounting.journals.approve",
    levels: 1,
    link: () => "/accounting?tab=journals",
    decidedInInbox: true,
  },
  "accounting.supplier_payment": {
    label: "اعتماد سداد مورد",
    entityType: "supplier_payment_request",
    approvePermission: "accounting.manage",
    levels: 1,
    link: () => "/accounting?tab=payments",
    decidedInInbox: true,
  },
  "accounting.cash_transfer": {
    label: "اعتماد تحويل بين الخزائن والبنوك",
    entityType: "cash_transfer",
    approvePermission: "accounting.manage",
    levels: 1,
    link: () => "/accounting?tab=treasury",
    decidedInInbox: true,
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
      link: def.decidedInInbox ? `/approvals?id=${request.id}` : def.link(input.entityId),
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
  const asked = new Set<string>();
  const fresh = inputs.filter((i) => {
    const k = key(i.type, i.entityId);
    if (open.has(k) || asked.has(k)) return false;
    asked.add(k);
    return true;
  });
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
  for (const { input, request } of closing.values()) {
    let rows = byReason.get(input.reason);
    if (!rows) byReason.set(input.reason, (rows = []));
    rows.push(request);
  }
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

export type ApprovalViewer = { id: string | null; permissions: readonly string[]; role?: string };

export type ApprovalListOptions = {
  status?: string;
  limit?: number;
  offset?: number;
  /** One approval type (validated). */
  type?: string;
  /** One request (the inbox's ?id= deep link). */
  id?: string;
  /** The requests about one record (an entity screen's "who approves this"). */
  entityId?: string;
  /** The requests about any of these records (a table of them sharing one request; at most 200). */
  entityIds?: string[];
  /** Name who can decide each pending request even when the caller can decide it too. */
  withApprovers?: boolean;
  /**
   * "decide": only the pending requests the caller can decide now — exactly the ones a card
   * would offer the decision on (the count is of those). "raised": only the ones they raised.
   * Unset: both together (a deep link, a record's own notice, the history).
   */
  scope?: "decide" | "raised";
};

/**
 * Who may decide, as the decision itself will judge it (recordDecision here, then the
 * module's handler) — so the inbox never offers a button that is certain to be refused.
 */
export type DecisionRules = {
  /** The approvals.require_different_approver setting. */
  requireDifferentApprover: boolean;
  /** The users a module refuses as the decider of each entity, beyond the engine's own rule
   * (lib/core/approval-handlers.ts `ineligible`); null for an entity nobody can decide as it
   * stands. Returns null for a type with no such rule. */
  ineligible?: (type: ApprovalType, rows: { entityId: string; requestedById: string | null }[], db: Tx) => Promise<Map<string, string[] | null> | null>;
  /** Types whose module rule refuses those users on approve only: a rejection goes through
   * the engine alone (no onRejected), so they may still reject when the engine allows it. */
  approveOnly?: (type: ApprovalType) => boolean;
};

/** Why the caller cannot decide a pending request (the screen says so instead of offering a button). */
export type DecisionBlock = "no_permission" | "already_decided" | "own_request" | "prepared_or_submitted" | "no_decider";

/** Active users with their effective permissions — ONE query, then every type's holders in memory. */
async function activeHolders(db: Tx): Promise<{ id: string; name: string; perms: Set<Permission> }[]> {
  const users = await db.user.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true, permissionOverrides: { select: { effect: true, permission: { select: { key: true } } } } },
  });
  return users.map((u) => ({ id: u.id, name: u.name, perms: applyOverrides(u.role as Role, u.permissionOverrides) }));
}

/**
 * Requests an actor may decide (pending, of types they hold the permission for) and the ones
 * they raised themselves, newest first: the window of rows plus the number that match. Each pending row
 * says whether the caller may decide it, and if not why (`blocked`), and — when the caller
 * cannot decide it, or asks — who can (`approvers`: names of active holders of the type's
 * permission, minus whoever the rules exclude). Statements: the page (2), its count only when
 * the page may not be all, one users query only when a pending row needs names, and one per
 * module rule that reads its record (opening batches, payroll) — never one per row.
 * scope "decide" reads every candidate's few columns instead of a counted page (plus one users
 * query for a SUPER_ADMIN, for the emergency path), then the page's rows: still not one per row.
 */
export async function listApprovalPage(
  actor: ApprovalViewer,
  opts: ApprovalListOptions = {},
  rules: DecisionRules = { requireDifferentApprover: true },
  db: Tx = prisma
) {
  const decidable = (Object.keys(APPROVAL_TYPES) as ApprovalType[]).filter((t) =>
    actor.permissions.includes(APPROVAL_TYPES[t].approvePermission)
  );
  const status = opts.status && ["pending", "approved", "rejected", "cancelled"].includes(opts.status) ? opts.status : undefined;
  if (opts.type !== undefined && !isApprovalType(opts.type)) throw new ApiError(400, "نوع موافقة غير معروف");
  const scope = opts.scope === "decide" || opts.scope === "raised" ? opts.scope : undefined;
  if (scope === "raised" && !actor.id) return { approvals: [], total: 0 };
  const entityIds = opts.entityIds ? [...new Set(opts.entityIds.filter((x) => typeof x === "string" && x))].slice(0, 200) : undefined;
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const skip = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const orderBy: Prisma.ApprovalRequestOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
  let holders: { id: string; name: string; perms: Set<Permission> }[] | null = null;
  const where: Prisma.ApprovalRequestWhereInput = {
    ...(scope === "decide" ? { status: "pending" } : status ? { status } : {}),
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.entityId ? { entityId: opts.entityId } : entityIds ? { entityId: { in: entityIds } } : {}),
    ...(scope === "raised" ? { requestedById: actor.id } : scope === "decide" ? {} : { OR: [{ type: { in: decidable } }, ...(actor.id ? [{ requestedById: actor.id }] : [])] }),
  };
  if (scope === "decide") {
    // Narrowed in SQL to what can be decidable — a type the caller holds, not decided by them
    // already, and not their own request (unless the one-admin emergency path may apply) — and
    // then judged below by the same rules as every card, so the count is of decidable ones.
    const and: Prisma.ApprovalRequestWhereInput[] = [{ type: { in: decidable } }];
    if (actor.id) {
      and.push({ NOT: { decisions: { some: { deciderId: actor.id } } } });
      if (rules.requireDifferentApprover) {
        let emergencyTypes: ApprovalType[] = [];
        if (actor.role === "SUPER_ADMIN") {
          holders = await activeHolders(db);
          emergencyTypes = decidable.filter((t) => !holders!.some((u) => u.id !== actor.id && u.perms.has(APPROVAL_TYPES[t].approvePermission)));
        }
        and.push({ OR: [{ requestedById: null }, { requestedById: { not: actor.id } }, ...(emergencyTypes.length ? [{ requestedById: actor.id, type: { in: emergencyTypes } }] : [])] });
      }
    }
    where.AND = and;
  }

  // The module rules (per type, over the given pending rows) and the caller's verdict on a row.
  const moduleRules = new Map<string, Map<string, string[] | null>>();
  const loadModuleRules = async (pendingRows: { type: string; entityId: string; requestedById: string | null }[]) => {
    if (!rules.ineligible) return;
    for (const type of new Set(pendingRows.map((r) => r.type as ApprovalType))) {
      if (moduleRules.has(type)) continue;
      const found = await rules.ineligible(type, pendingRows.filter((r) => r.type === type).map((r) => ({ entityId: r.entityId, requestedById: r.requestedById })), db);
      if (found) moduleRules.set(type, found);
    }
  };
  type Judged = { status: string; type: string; entityId: string; requestedById: string | null; decisions: { deciderId: string | null }[] };
  type Verdict = { canDecide: boolean; emergency: boolean; rejectOnly: boolean; blocked: DecisionBlock | null };
  const ownRequest = (r: { requestedById: string | null }) => !!actor.id && r.requestedById === actor.id;
  const decidedBy = (r: Judged, userId: string | null) => !!userId && r.decisions.some((d) => d.deciderId === userId);
  const refusedFor = (r: Judged) => moduleRules.get(r.type)?.get(r.entityId);

  let rows: Prisma.ApprovalRequestGetPayload<{ include: { decisions: true } }>[];
  let total: number;
  if (scope === "decide") {
    // Every candidate's few columns (one statement), judged; then the page's full rows.
    const candidates = await db.approvalRequest.findMany({ where, orderBy, select: { id: true, type: true, status: true, entityId: true, requestedById: true, decisions: { select: { deciderId: true } } } });
    const judgeable = candidates.filter((r) => isApprovalType(r.type));
    await loadModuleRules(judgeable);
    if (!holders && judgeable.some(ownRequest)) holders = await activeHolders(db);
    const decidableIds = judgeable.filter((r) => judgeWith(r).canDecide).map((r) => r.id);
    total = decidableIds.length;
    const pageIds = decidableIds.slice(skip, skip + take);
    rows = pageIds.length ? await db.approvalRequest.findMany({ where: { id: { in: pageIds } }, orderBy, include: { decisions: { orderBy: { level: "asc" } } } }) : [];
  } else {
    rows = await db.approvalRequest.findMany({
      where,
      // The id breaks ties so paging never repeats or skips a row.
      orderBy,
      take,
      skip,
      include: { decisions: { orderBy: { level: "asc" } } },
    });
    total = skip === 0 && rows.length < take ? rows.length : await db.approvalRequest.count({ where });
  }

  const pending = rows.filter((r) => r.status === "pending" && isApprovalType(r.type));
  await loadModuleRules(pending);
  // Names are read only when some pending row is not the caller's to decide (or is their own,
  // where the emergency path depends on who else holds the permission).
  const needsNames = pending.some((r) => {
    const refused = refusedFor(r);
    return opts.withApprovers || ownRequest(r) || !decidable.includes(r.type as ApprovalType) || decidedBy(r, actor.id) || refused === null || (!!actor.id && !!refused?.includes(actor.id));
  });
  if (!holders) holders = needsNames ? await activeHolders(db) : [];
  const allHolders = holders;

  function judgeWith(r: Judged): Verdict {
    if (r.status !== "pending" || !isApprovalType(r.type)) return { canDecide: false, emergency: false, rejectOnly: false, blocked: null };
    const block = (blocked: DecisionBlock): Verdict => ({ canDecide: false, emergency: false, rejectOnly: false, blocked });
    if (!decidable.includes(r.type)) return block("no_permission");
    if (decidedBy(r, actor.id)) return block("already_decided");
    const refused = refusedFor(r);
    if (refused === null) return block("no_decider");
    const refusedHere = !!actor.id && !!refused?.includes(actor.id);
    // The module refuses this caller's approval only; their rejection is the engine's to judge.
    const approveRefused = refusedHere && !!rules.approveOnly?.(r.type);
    if (refusedHere && !approveRefused) return block(ownRequest(r) ? "own_request" : "prepared_or_submitted");
    if (rules.requireDifferentApprover && ownRequest(r)) {
      // The engine refuses the requester's rejection, and here the module their approval.
      if (approveRefused) return block("own_request");
      // recordDecision's emergency path: a SUPER_ADMIN whom no other active user can replace
      // may approve (never reject) their own request, with a written reason.
      const permission = APPROVAL_TYPES[r.type as ApprovalType].approvePermission;
      const others = (holders ?? []).filter((u) => u.id !== actor.id && u.perms.has(permission));
      return actor.role === "SUPER_ADMIN" && others.length === 0 ? { canDecide: true, emergency: true, rejectOnly: false, blocked: null } : block("own_request");
    }
    return { canDecide: true, emergency: false, rejectOnly: approveRefused, blocked: null };
  }
  const approversOf = (r: (typeof rows)[number]) => {
    const refused = refusedFor(r);
    if (refused === null) return [];
    const permission = APPROVAL_TYPES[r.type as ApprovalType].approvePermission;
    return allHolders
      .filter((u) => u.perms.has(permission) && u.id !== actor.id && !(rules.requireDifferentApprover && u.id === r.requestedById) && !refused?.includes(u.id) && !decidedBy(r, u.id))
      .map((u) => u.name);
  };

  const approvals = rows.map((r) => {
    const verdict = judgeWith(r);
    const named = r.status === "pending" && isApprovalType(r.type) && (opts.withApprovers || !verdict.canDecide || verdict.emergency || verdict.rejectOnly);
    return {
      ...r,
      label: isApprovalType(r.type) ? APPROVAL_TYPES[r.type].label : r.type,
      link: isApprovalType(r.type) ? APPROVAL_TYPES[r.type].link(r.entityId) : null,
      approvePermission: isApprovalType(r.type) ? APPROVAL_TYPES[r.type].approvePermission : null,
      ownRequest: ownRequest(r),
      ...verdict,
      ...(named ? { approvers: approversOf(r) } : {}),
    };
  });
  return { approvals, total };
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
