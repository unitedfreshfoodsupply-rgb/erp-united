import { prisma } from "@/lib/prisma";
import { asText } from "@/lib/http";
import { ApiError } from "@/lib/rbac";
import { inTx, type Tx } from "@/lib/tx";
import { getSetting } from "@/lib/core/settings-service";
import { recordDecision, type ApprovalType, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import type { Role } from "@/lib/types";
import { applyShortageApproval } from "@/lib/orders-service";
import { postApprovedAdjustment, rejectPendingAdjustment } from "@/lib/inventory/documents";
import { applyCreditDecision } from "@/lib/sales/credit";
import { applyPoDecision } from "@/lib/purchasing/orders";
import { applyBillDecision } from "@/lib/purchasing/bills";
import { applyExpenseDecision } from "@/lib/hr/service";
import { applyCorrectionDecision } from "@/lib/hr/attendance";
import { applyLeaveDecision } from "@/lib/hr/leave";
import { applyCompensationDecision } from "@/lib/hr/compensation";
import { applyRunDecision } from "@/lib/hr/payroll";

/**
 * What each approval type DOES once decided. Kept apart from the engine core so the
 * engine imports no module and modules import only the core — the dependency runs one
 * way. Every handler runs inside the transaction that records the final decision.
 */
type Handler = {
  onApproved: (tx: Tx, request: { entityId: string; payload: unknown }, decider: Decider, comment?: string) => Promise<unknown>;
  /** Optional: most rejections simply leave the thing blocked. */
  onRejected?: (tx: Tx, request: { entityId: string; payload: unknown }, decider: Decider, comment?: string) => Promise<unknown>;
};

/** Deciders always come from an authenticated context, so their role is a real Role. */
const asActor = (d: Decider): ServiceActor => ({ ...d, role: d.role as Role });

const HANDLERS: Record<ApprovalType, Handler> = {
  "orders.shortage": {
    onApproved: (tx, req, decider, comment) =>
      applyShortageApproval(tx, req.entityId, { ...decider, source: "user" }, comment ?? "اعتماد من صندوق الموافقات"),
    // A rejected shortage stays blocked: the preparer corrects the quantities, and a
    // fresh request is raised automatically if the variance is still over tolerance.
  },
  "inventory.adjustment": {
    // The adjustment posts at the moment of approval, against the balances of that
    // moment — if stock moved since the request, the ledger rules decide again.
    onApproved: (tx, req, decider) => postApprovedAdjustment(tx, req.entityId, asActor(decider)),
    onRejected: (tx, req, decider) => rejectPendingAdjustment(tx, req.entityId, asActor(decider)),
  },
  "purchasing.order": {
    // Approved: the buyer may send it. Rejected: back to draft for the buyer to change.
    onApproved: (tx, req, decider, comment) => applyPoDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyPoDecision(tx, req.entityId, false, decider, comment),
  },
  "purchasing.bill": {
    // Approved: the variance is accepted and the bill is posted. Rejected: back to draft
    // (correct it, or cancel it and ask the supplier for a corrected invoice).
    onApproved: (tx, req, decider, comment) => applyBillDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyBillDecision(tx, req.entityId, false, decider, comment),
  },
  "hr.expense": {
    // Approved: posted to the ledger. Rejected: recorded, nothing posted.
    onApproved: (tx, req, decider, comment) => applyExpenseDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyExpenseDecision(tx, req.entityId, false, decider, comment),
  },
  "hr.attendance_correction": {
    // Approved: the day takes the requested values (a locked day's pay difference goes to the
    // next payroll run). Rejected: the day stays as it was. The requester may not decide.
    onApproved: (tx, req, decider, comment) => applyCorrectionDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyCorrectionDecision(tx, req.entityId, false, decider, comment),
  },
  "hr.leave": {
    // Approved: `taken` on the balance and confirmed leave days in the register. Rejected:
    // nothing changes. The person who recorded the request may not decide it.
    onApproved: (tx, req, decider, comment) => applyLeaveDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyLeaveDecision(tx, req.entityId, false, decider, comment),
  },
  "hr.compensation_change": {
    // Approved: the package is in force from its start and the previous one ends the day
    // before. Rejected: nothing changes. The proposer may not decide.
    onApproved: (tx, req, decider, comment) => applyCompensationDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyCompensationDecision(tx, req.entityId, false, decider, comment),
  },
  "hr.payroll_run": {
    // Approved: only by someone who neither prepared nor submitted it, and only if a fresh
    // calculation still gives the submitted figures. Rejected: returned to the preparer.
    onApproved: (tx, req, decider, comment) => applyRunDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyRunDecision(tx, req.entityId, false, decider, comment),
  },
  "sales.credit": {
    // Finance accepts the risk for this one order; it may then start preparation.
    onApproved: (tx, req, decider, comment) => applyCreditDecision(tx, req.entityId, true, decider, comment),
    onRejected: (tx, req, decider, comment) => applyCreditDecision(tx, req.entityId, false, decider, comment),
  },
};

export function registeredApprovalTypes() {
  return Object.keys(HANDLERS) as ApprovalType[];
}

/** Approve or reject one request from the approvals inbox. */
export async function decideApproval(
  requestId: string,
  decision: unknown,
  decider: Decider,
  opts: { comment?: string; expectedVersion?: number }
) {
  if (decision !== "approve" && decision !== "reject") throw new ApiError(400, "القرار لازم يكون approve أو reject");
  if (decision === "reject" && !asText(opts.comment, "comment")?.trim()) throw new ApiError(400, "اكتب سبب الرفض");
  const requireDifferentApprover = await getSetting("approvals.require_different_approver");
  const request = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new ApiError(404, "طلب الموافقة مش موجود");
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== request.version) {
    throw new ApiError(409, `الطلب اتغيّر من واحد تاني، حدّث الشاشة (النسخة الحالية: ${request.version})`);
  }
  const handler = HANDLERS[request.type as ApprovalType];
  if (!handler) throw new ApiError(400, "نوع موافقة غير معروف");

  return inTx(async (tx) => {
    const outcome = await recordDecision(tx, request, decision, decider, { comment: opts.comment, requireDifferentApprover });
    if (outcome.final && outcome.status === "approved") await handler.onApproved(tx, request, decider, opts.comment);
    if (outcome.final && outcome.status === "rejected" && handler.onRejected) await handler.onRejected(tx, request, decider, opts.comment);
    return tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId }, include: { decisions: { orderBy: { level: "asc" } } } });
  });
}
