import type { ReactNode } from "react";

/**
 * One status vocabulary for the whole product. A pill = a coloured dot + a word, never
 * colour alone (WCAG 1.4.1) and never an emoji (they render differently per device).
 *
 * Tones carry meaning, not decoration:
 *   neutral — nothing to do (draft, finished, cancelled)
 *   info    — new / approved, waiting for the next normal step
 *   warn    — in progress or waiting on someone (pending approval, partial)
 *   success — done correctly (posted, paid, delivered)
 *   danger  — failed, rejected, voided, needs action now
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
 * Document states used across finance, purchasing, stock and approvals, mapped once.
 * Unknown states fall back to neutral rather than guessing.
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
  void: "danger",
  voided: "danger",
  rejected: "danger",
  invalid: "danger",
  failed: "danger",
  unknown: "warn",
  reversed: "neutral",
};

export function docTone(status: string | null | undefined): Tone {
  return (status && DOC_STATUS_TONE[status]) || "neutral";
}
