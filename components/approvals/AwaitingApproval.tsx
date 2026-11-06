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
 * table-cell notices of one type on a screen share one request for exactly the records the
 * table shows (`batch`: entity_ids, in chunks of 200), so no row past a cap goes without one.
 *
 * The listing shows only what the caller may decide or raised; anyone else sees where it is
 * decided, without its detail.
 */
/** The server's cap on entity_ids (and on a page) per request. */
const BATCH_MAX = 200;

export function usePendingApprovals(type: string, enabled = true, entityId?: string, entityIds?: string[]) {
  // A stable key for the same set of records, whatever order the table lists them in.
  const ids = entityIds ? [...new Set(entityIds)].sort() : null;
  return useQuery({
    queryKey: ["approvals", "for", type, entityId ?? null, ids?.join(",") ?? null],
    queryFn: async () => {
      const base = `/api/approvals?status=pending&type=${encodeURIComponent(type)}&approvers=1`;
      if (entityId) return (await apiFetch<{ approvals: ApprovalDTO[] }>(`${base}&entity_id=${encodeURIComponent(entityId)}&limit=5`)).approvals;
      if (!ids) return (await apiFetch<{ approvals: ApprovalDTO[] }>(`${base}&limit=${BATCH_MAX}`)).approvals;
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += BATCH_MAX) chunks.push(ids.slice(i, i + BATCH_MAX));
      const pages = await Promise.all(chunks.map((c) => apiFetch<{ approvals: ApprovalDTO[] }>(`${base}&entity_ids=${c.map(encodeURIComponent).join(",")}&limit=${BATCH_MAX}`)));
      return pages.flatMap((p) => p.approvals);
    },
    enabled: enabled && (!ids || ids.length > 0),
    // The table's id set changes after a withdraw or a decision: the notices it already has stay
    // up while the new set loads, instead of every cell blanking (same type and record only).
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === type && prevQuery?.queryKey[3] === (entityId ?? null) ? prev : undefined,
  });
}

/** `batch` (compact cells): every record of this type the table shows pending, this one included. */
export function AwaitingApproval({ type, entityId, compact = false, batch }: { type: string; entityId: string; compact?: boolean; batch?: string[] }) {
  const { t, locale } = useLocale();
  const typeLabel = useTypeLabel();
  const headingId = useId();
  const q = usePendingApprovals(type, true, compact ? undefined : entityId, compact ? (batch ?? [entityId]) : undefined);
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
