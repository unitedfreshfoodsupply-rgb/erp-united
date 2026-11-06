import type { ReactNode } from "react";

/**
 * One status vocabulary for the whole product. A pill = a coloured dot + a word, never
 * colour alone (WCAG 1.4.1) and never an emoji (they render differently per device).
 *
 * Tones carry meaning, not decoration:
 *   neutral — nothing to do (draft, finished, cancelled, voided)
 *   info    — new / approved, waiting for the next normal step
 *   warn    — in progress or waiting on someone (pending approval, partial)
 *   success — done correctly (posted, paid, delivered)
 *   danger  — failed, rejected, needs action now
 */
export type Tone = "neutral" | "info" | "warn" | "success" | "danger";

const CLASS: Record<Tone, string> = {
  neutral: "pill-neutral",
  info: "pill-info",
  warn: "pill-warn",
  success: "pill-success",
  danger: "pill-danger",
};

export function StatusPill({ tone, children, strike = false, size = "sm" }: { tone: Tone; children: ReactNode; strike?: boolean; size?: "sm" | "md" }) {
  return (
    <span className={`${CLASS[tone]} ${size === "md" ? "text-sm px-3 py-1" : ""}`}>
      <span aria-hidden className="pill-dot" />
      <span className={strike ? "line-through" : undefined}>{children}</span>
    </span>
  );
}

/**
 * Document states used across finance, purchasing, stock, HR and assets, mapped once.
 * A screen with states of its own (a trip's "in transit", an asset "in service") passes
 * them to docTone as `extra`; a state listed here always keeps this tone, so the same
 * word never reads in two colours. Unknown states fall back to neutral rather than guessing.
 */
export const DOC_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  pending: "warn",
  pending_approval: "warn",
  submitted: "info",
  approved: "info",
  sent: "info",
  partially_received: "warn",
  received: "success",
  closed: "neutral",
  posted: "success",
  issued: "success",
  paid: "success",
  valid: "success",
  delivered: "success",
  partial: "warn",
  cancelled: "neutral",
  // A voided draft was never issued: finished, like a cancelled document, not an alarm.
  void: "neutral",
  voided: "neutral",
  rejected: "danger",
  invalid: "danger",
  failed: "danger",
  unknown: "warn",
  reversed: "neutral",
  verified: "success",
  retired: "neutral",
  superseded: "neutral",
  withdrawn: "neutral",
};

export function docTone(status: string | null | undefined, extra?: Record<string, Tone>): Tone {
  if (!status) return "neutral";
  return DOC_STATUS_TONE[status] ?? extra?.[status] ?? "neutral";
}

/**
 * A request decided by someone (an approval, a leave request, an attendance correction, an
 * expense claim, a salary package): approval is its outcome, so it reads as done (success),
 * not as a document's "approved, next step pending" (info). Same rule for `extra`.
 */
export const REQUEST_STATUS_TONE: Record<string, Tone> = {
  pending: "warn",
  pending_approval: "warn",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  withdrawn: "neutral",
  superseded: "neutral",
};

export function requestTone(status: string | null | undefined, extra?: Record<string, Tone>): Tone {
  if (!status) return "neutral";
  return REQUEST_STATUS_TONE[status] ?? extra?.[status] ?? "neutral";
}
