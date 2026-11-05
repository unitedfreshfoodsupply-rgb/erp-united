"use client";

import Link from "next/link";
import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { approvalAmount, DecideControls, useTypeLabel, WhoDecides, type ApprovalDTO } from "@/components/approvals/ApprovalDecision";

/**
 * "Waiting for approval" on the record's own screen (an opening batch, a journal request…):
 * who can decide it, a link to it in the approvals inbox, and — for whoever may decide it —
 * the decision right here. The full notice asks for its own record (entity_id); the compact
 * table-cell notices of one type on a screen share one request (the newest 200 pending).
 *
 * The listing shows only what the caller may decide or raised; anyone else sees where it is
 * decided, without its detail.
 */
export function usePendingApprovals(type: string, enabled = true, entityId?: string) {
  return useQuery({
    queryKey: ["approvals", "for", type, entityId ?? null],
    queryFn: () =>
      apiFetch<{ approvals: ApprovalDTO[] }>(`/api/approvals?status=pending&type=${encodeURIComponent(type)}&approvers=1&${entityId ? `entity_id=${encodeURIComponent(entityId)}&limit=5` : "limit=200"}`).then((r) => r.approvals),
    enabled,
  });
}

export function AwaitingApproval({ type, entityId, compact = false }: { type: string; entityId: string; compact?: boolean }) {
  const { t, locale } = useLocale();
  const typeLabel = useTypeLabel();
  const headingId = useId();
  const q = usePendingApprovals(type, true, compact ? undefined : entityId);
  const a = q.data?.find((x) => x.entityId === entityId);
  if (q.isLoading) return null;
  if (q.isError) {
    // Not "decided elsewhere": the screen could not tell, and says so.
    return (
      <p role="alert" className={compact ? "block text-xs text-united-danger" : "rounded-xl border border-united-danger/40 bg-united-danger/10 p-3 text-sm font-medium text-united-danger"}>
        {t("approvals.notice.load-error")} {errorMessage(q.error) ?? t("ui.error.generic")}{" "}
        <button type="button" className="underline font-bold" onClick={() => q.refetch()}>{t("ui.retry")}</button>
      </p>
    );
  }
  if (!a) {
    return compact ? null : (
      <p role="status" className="rounded-xl border border-united-warn/40 bg-united-warn/10 p-3 text-sm font-medium text-united-warn">
        {t("approvals.notice.elsewhere")} <Link href="/approvals" className="underline">{t("approvals.title")}</Link>
      </p>
    );
  }
  const inbox = `/approvals?id=${encodeURIComponent(a.id)}`;
  if (compact) {
    // One line in a table cell: who decides, and where.
    const names = a.approvers ?? [];
    return (
      <span className="block text-xs text-united-muted">
        {a.canDecide ? t("approvals.notice.you-can") : names.length ? t("approvals.who.can-decide", { names: names.join(locale === "en" ? ", " : "، ") }) : t("approvals.who.none-short")}
        {" · "}<Link href={inbox} className="underline font-bold">{t("approvals.notice.open")}</Link>
      </span>
    );
  }
  const amount = approvalAmount(a);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-xl border border-united-warn/40 bg-united-warn/10 p-3 text-sm">
      <p id={headingId} className="font-bold text-united-warn">
        {t("approvals.notice.title")} · {typeLabel(a)} · <bdi dir="ltr">{a.number}</bdi>
        {amount && <> · <bdi>{amount}</bdi></>}
      </p>
      <p className="text-united-dark">{t("approvals.requested-by", { name: a.requestedBy })}</p>
      {(!a.canDecide || a.emergency || !!a.approvers?.length) && <WhoDecides a={a} />}
      {a.canDecide && !a.emergency && !a.rejectOnly && <p className="font-medium text-united-dark">{t("approvals.notice.you-can")}</p>}
      <DecideControls a={a} />
      <div><Link href={inbox} className="btn-secondary btn-sm">{t("approvals.notice.open")}</Link></div>
    </section>
  );
}
