"use client";

import Link from "next/link";
import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { approvalAmount, DecideControls, useTypeLabel, WhoDecides, type ApprovalDTO } from "@/components/approvals/ApprovalDecision";

/**
 * "Waiting for approval" on the record's own screen (an opening batch, a journal request…):
 * who can decide it, a link to it in the approvals inbox, and — for whoever may decide it —
 * the decision right here. Every notice of one type on a screen shares one request.
 *
 * The listing shows only what the caller may decide or raised; anyone else sees where it is
 * decided, without its detail.
 */
export function usePendingApprovals(type: string, enabled = true) {
  return useQuery({
    queryKey: ["approvals", "for", type],
    queryFn: () => apiFetch<{ approvals: ApprovalDTO[] }>(`/api/approvals?status=pending&type=${encodeURIComponent(type)}&approvers=1&limit=200`).then((r) => r.approvals),
    enabled,
  });
}

export function AwaitingApproval({ type, entityId, compact = false }: { type: string; entityId: string; compact?: boolean }) {
  const { t, locale } = useLocale();
  const typeLabel = useTypeLabel();
  const headingId = useId();
  const q = usePendingApprovals(type);
  const a = q.data?.find((x) => x.entityId === entityId);
  if (q.isLoading) return null;
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
      {a.canDecide && !a.emergency && <p className="font-medium text-united-dark">{t("approvals.notice.you-can")}</p>}
      <DecideControls a={a} />
      <div><Link href={inbox} className="btn-secondary btn-sm">{t("approvals.notice.open")}</Link></div>
    </section>
  );
}
