"use client";

import { intlLocale } from "@/lib/format";
import Link from "next/link";
import { systemText } from "@/lib/locale/system-text";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useLocale } from "@/lib/locale";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { Check, X } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";

type Decision = { id: string; level: number; decision: "approve" | "reject"; decider: string; comment: string | null; createdAt: string };
type ApprovalDTO = {
  id: string;
  number: string;
  type: string;
  label: string;
  title: string;
  summary: string | null;
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
  canDecide: boolean;
  decisions: Decision[];
};

const STATUS: Record<ApprovalDTO["status"], { label: string; tone: Tone }> = {
  pending: { label: "approvals.status.pending", tone: "warn" },
  approved: { label: "approvals.status.approved", tone: "success" },
  rejected: { label: "approvals.status.rejected", tone: "danger" },
  cancelled: { label: "approvals.status.cancelled", tone: "neutral" },
};

const when = (iso: string, locale: string) => new Date(iso).toLocaleString(intlLocale(locale), { dateStyle: "short", timeStyle: "short" });

/** One inbox for every approval type: decide here, or open the thing being approved. */
export function ApprovalsInbox() {
  // `t` is the tab variable below; the translator is `tr` here.
  const { t: tr } = useLocale();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const q = useQuery({
    queryKey: ["approvals", tab],
    queryFn: () => apiFetch<{ approvals: ApprovalDTO[] }>(`/api/approvals${tab === "pending" ? "?status=pending" : ""}`),
    refetchInterval: 10_000,
  });

  return (
    <div className="page-narrow">
      <PageHeader
        title={tr("approvals.title")}
        description={tr("approvals.description")}
        actions={<Segmented label={tr("approvals.title")} value={tab} onChange={setTab} items={[{ key: "pending", label: tr("approvals.tab.pending"), ...(tab === "pending" && q.data ? { count: q.data.approvals.length } : {}) }, { key: "all", label: tr("approvals.tab.all") }]} />}
      />
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && q.data.approvals.length === 0 && <EmptyState icon="✅" title={tab === "pending" ? tr("approvals.empty.pending") : tr("approvals.empty.all")} />}
      <ul className="flex flex-col gap-3">
        {q.data?.approvals.map((a) => (
          <ApprovalCard key={a.id} a={a} />
        ))}
      </ul>
    </div>
  );
}

function ApprovalCard({ a }: { a: ApprovalDTO }) {
  const { t, locale } = useLocale();
  // The type label is a fixed definition (lib/core/approvals.ts): show it by key, and the
  // server's own label for a type this screen does not know yet.
  const typeLabel = (x: ApprovalDTO) => {
    const key = `approvals.type.${x.type}`;
    const label = t(key);
    return label === key ? x.label : label;
  };
  const qc = useQueryClient();
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (busy) return;
    if (decision === "reject" && !comment.trim()) {
      setError(t("approvals.reject-reason"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/approvals/${a.id}/decide`, { decision, comment: comment || undefined, expected_version: a.version });
      await Promise.all([qc.invalidateQueries({ queryKey: ["approvals"] }), qc.invalidateQueries({ queryKey: ["orders"] }), qc.invalidateQueries({ queryKey: ["notifications"] })]);
      toast.show(decision === "approve" ? t("approvals.toast.approved") : t("approvals.toast.rejected"), "success");
    } catch (err) {
      setError(err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card p-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs font-medium text-united-muted">
            {typeLabel(a)} · <bdi dir="ltr">{a.number}</bdi>
          </div>
          <div className="mt-0.5 text-base font-semibold text-united-dark">{systemText(a.title, locale)}</div>
          {a.summary && <p className="mt-0.5 text-sm text-united-dark">{systemText(a.summary, locale)}</p>}
          <p className="mt-1 text-xs text-united-muted">
            {t("approvals.requested-by", { name: a.requestedBy })} · <bdi dir="ltr">{when(a.createdAt, locale)}</bdi>
            {a.requiredLevels > 1 && t("approvals.level", { done: a.approvedLevels, required: a.requiredLevels })}
          </p>
          {a.requestReason && <p className="text-xs text-united-dark/80">{t("approvals.reason-line", { reason: a.requestReason })}</p>}
          {a.closedReason && <p className="text-xs text-united-muted">{a.closedReason}</p>}
        </div>
        <StatusPill tone={STATUS[a.status].tone}>{t(STATUS[a.status].label)}</StatusPill>
      </div>

      {a.decisions.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-united-muted">
          {a.decisions.map((d) => (
            <li key={d.id} className="flex items-center gap-1.5">
              {d.decision === "approve" ? <Check size={14} className="text-united-green" aria-label={t("approvals.status.approved")} /> : <X size={14} className="text-united-danger" aria-label={t("approvals.status.rejected")} />} {d.decider}
              {d.comment && ` — ${d.comment}`} · <bdi dir="ltr">{when(d.createdAt, locale)}</bdi>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-united-border pt-3">
        {a.link && (
          <Link href={a.link} className="btn-secondary text-sm">
            {t("approvals.open")}
          </Link>
        )}
        {a.canDecide && (
          <>
            <input
              className="field flex-1 min-w-[12rem]"
              placeholder={t("approvals.comment")}
              aria-label={t("approvals.comment")}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <button type="button" className="btn-primary" disabled={busy} onClick={() => decide("approve")}>
              {t("approvals.btn.approve")}
            </button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => decide("reject")}>
              {t("approvals.reject")}
            </button>
          </>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm font-medium text-united-danger">{error}</p>}
    </li>
  );
}
