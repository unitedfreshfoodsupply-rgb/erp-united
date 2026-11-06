"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, ApiClientError } from "@/lib/api-client";
import { money } from "@/lib/format";
import { useLocale } from "@/lib/locale";
import { systemText } from "@/lib/locale/system-text";
import { permissionText } from "@/lib/permissions";
import { CONFIRM_TYPES, EMERGENCY_REASON_MIN, MONEY_TYPES } from "@/lib/core/approval-presentation";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";

/**
 * One approval request as GET /api/approvals returns it, and the two pieces every screen that
 * shows a pending request shares: who can decide it (WhoDecides) and the decision itself
 * (DecideControls) — used by the inbox card and by the "waiting for approval" notice on the
 * record's own screen (AwaitingApproval).
 */

export type Decision = { id: string; level: number; decision: "approve" | "reject"; decider: string; deciderId: string | null; comment: string | null; createdAt: string };
export type ApprovalDTO = {
  id: string;
  number: string;
  type: string;
  label: string;
  entityId: string;
  title: string;
  summary: string | null;
  /** Decimal as a string; money for the types in MONEY_TYPES. */
  amount: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requiredLevels: number;
  approvedLevels: number;
  requestedBy: string;
  requestReason: string | null;
  closedReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  version: number;
  link: string | null;
  approvePermission: string | null;
  ownRequest: boolean;
  canDecide: boolean;
  /** The caller may decide only through the one-admin emergency path: approve, with a written reason. */
  emergency: boolean;
  /** The caller may reject (withdraw) it but not approve it: the module refuses their approval only. */
  rejectOnly?: boolean;
  blocked: "no_permission" | "already_decided" | "own_request" | "prepared_or_submitted" | "no_decider" | null;
  /** Who else can decide it (names), when the caller cannot decide it or asked. */
  approvers?: string[];
  decisions: Decision[];
};

/** Names shown before "and N more". */
const NAMES_SHOWN = 4;

export const approvalAmount = (a: Pick<ApprovalDTO, "type" | "amount">) => (a.amount != null && MONEY_TYPES.has(a.type) ? money(a.amount) : null);

export function useTypeLabel() {
  const { t } = useLocale();
  // The type label is a fixed definition (lib/core/approvals.ts): show it by key, and the
  // server's own label for a type this screen does not know yet.
  return (x: Pick<ApprovalDTO, "type" | "label">) => {
    const key = `approvals.type.${x.type}`;
    const label = t(key);
    return label === key ? x.label : label;
  };
}

/** For a pending request the caller cannot decide (or may decide only as an emergency): why, and who can. */
export function WhoDecides({ a, className = "" }: { a: ApprovalDTO; className?: string }) {
  const { t, locale } = useLocale();
  if (a.status !== "pending") return null;
  const names = a.approvers ?? [];
  const reason = a.blocked && a.blocked !== "no_permission" ? t(`approvals.blocked.${a.blocked}`) : null;
  const permission = a.approvePermission ? permissionText(a.approvePermission, locale).label : "";
  return (
    <div className={`flex flex-col gap-0.5 text-sm ${className}`}>
      {reason && <p className="font-medium text-united-dark">{reason}</p>}
      {names.length > 0 ? (
        <p className="text-united-dark">
          {t("approvals.who.can-decide", { names: names.slice(0, NAMES_SHOWN).join(locale === "en" ? ", " : "، ") })}
          {names.length > NAMES_SHOWN && ` ${t("approvals.who.more", { n: names.length - NAMES_SHOWN })}`}
        </p>
      ) : a.approvers && !a.emergency && a.blocked !== "no_decider" ? (
        <p className="font-medium text-united-warn">{t("approvals.who.none", { permission })}</p>
      ) : null}
    </div>
  );
}

/** Approve / reject one request: confirms money and postings first, says it is working, never sends twice. */
export function DecideControls({ a, onDone }: { a: ApprovalDTO; onDone?: () => void }) {
  const { t, locale } = useLocale();
  const typeLabel = useTypeLabel();
  const qc = useQueryClient();
  const toast = useToast();
  const dialogs = useDialogs();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A refusal about the comment itself (no reason to reject, a short emergency reason) marks the
  // field and puts the cursor in it; a server refusal is about the request, not the field.
  const [fieldError, setFieldError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  if (!a.canDecide) return null;
  const reasonShort = a.emergency && comment.trim().length < EMERGENCY_REASON_MIN;
  const errorId = `approval-error-${a.id}`;

  async function decide(decision: "approve" | "reject") {
    if (busy) return;
    const missing = decision === "reject" && !comment.trim() ? t("approvals.reject-reason") : decision === "approve" && reasonShort ? t("approvals.emergency.label") : null;
    if (missing) {
      setError(missing);
      setFieldError(true);
      inputRef.current?.focus();
      return;
    }
    if (decision === "approve" && (CONFIRM_TYPES.has(a.type) || approvalAmount(a))) {
      const amount = approvalAmount(a);
      // The number kept whole and left to right, as on the cards: a narrow screen wraps the title
      // around "APR-2026-00059", never inside it — and it reads, copies and searches as typed.
      const [before, after = ""] = t("approvals.confirm.title", { number: "{number}" }).split("{number}");
      const ok = await dialogs.confirm({
        title: (
          <>
            {before}
            <bdi dir="ltr" className="whitespace-nowrap">{a.number}</bdi>
            {after}
          </>
        ),
        body: (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium">{typeLabel(a)}</p>
            <p className="font-semibold text-united-dark">{systemText(a.title, locale)}</p>
            {a.summary && <p>{systemText(a.summary, locale)}</p>}
            {amount && <p className="font-bold text-united-dark">{t("approvals.amount", { amount })}</p>}
            {CONFIRM_TYPES.has(a.type) && <p>{t("approvals.confirm.body")}</p>}
          </div>
        ),
        confirmLabel: t("approvals.btn.approve"),
      });
      if (!ok) return;
    }
    setBusy(decision);
    setError(null);
    setFieldError(false);
    try {
      await apiPost(`/api/approvals/${a.id}/decide`, { decision, comment: comment || undefined, expected_version: a.version });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["approvals"] }),
        qc.invalidateQueries({ queryKey: ["orders"] }),
        qc.invalidateQueries({ queryKey: ["notifications"] }),
        qc.invalidateQueries({ queryKey: ["acc"] }),
      ]);
      toast.show(decision === "approve" ? t("approvals.toast.approved") : t("approvals.toast.rejected"), "success");
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {a.emergency && <p className="text-sm font-medium text-united-warn">{t("approvals.emergency.hint")}</p>}
      {a.rejectOnly && <p className="text-sm font-medium text-united-dark">{t("approvals.reject-only")}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label={a.emergency ? t("approvals.emergency.label") : t("approvals.comment")} className="flex-1 min-w-[12rem]">
          <input
            ref={inputRef}
            className="field"
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              if (fieldError) {
                setFieldError(false);
                setError(null);
              }
            }}
            disabled={!!busy}
            aria-invalid={fieldError || undefined}
            aria-describedby={fieldError && error ? errorId : undefined}
          />
        </Field>
        {/* Stays enabled with a short emergency reason: the click says what is missing. */}
        {!a.rejectOnly && (
          <button type="button" className="btn-primary" disabled={!!busy} aria-busy={busy === "approve"} aria-describedby={error ? errorId : undefined} onClick={() => decide("approve")}>
            {busy === "approve" ? t("approvals.busy.approve") : t("approvals.btn.approve")}
          </button>
        )}
        {/* The emergency path approves only (recordDecision refuses a self-rejection). */}
        {!a.emergency && (
          <button type="button" className="btn-danger" disabled={!!busy} aria-busy={busy === "reject"} aria-describedby={error ? errorId : undefined} onClick={() => decide("reject")}>
            {busy === "reject" ? t("approvals.busy.reject") : t("approvals.reject")}
          </button>
        )}
      </div>
      {error && <p id={errorId} role="alert" className="text-sm font-medium text-united-danger">{error}</p>}
    </div>
  );
}
