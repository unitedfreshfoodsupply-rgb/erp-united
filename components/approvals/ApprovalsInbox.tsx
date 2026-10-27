"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useLocale } from "@/lib/locale";

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

const STATUS: Record<ApprovalDTO["status"], { label: string; cls: string }> = {
  pending: { label: "approvals.status.pending", cls: "bg-united-warn/10 text-united-warn" },
  approved: { label: "approvals.status.approved", cls: "bg-united-green/10 text-united-green" },
  rejected: { label: "approvals.status.rejected", cls: "bg-united-danger/10 text-united-danger" },
  cancelled: { label: "approvals.status.cancelled", cls: "bg-united-dark/5 text-united-muted" },
};

const when = (iso: string, locale: string) => new Date(iso).toLocaleString(locale === "en" ? "en-GB" : "ar-EG", { dateStyle: "short", timeStyle: "short" });

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
    <div className="p-4 max-w-3xl mx-auto pb-10 flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-united-dark">{tr("approvals.title")}</h1>
      <div className="flex gap-2">
        {(["pending", "all"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`tap-target flex-1 rounded-xl font-extrabold text-sm ${tab === t ? "bg-united-green text-white" : "bg-united-dark/5 text-united-dark"}`}
          >
            {tr(`approvals.tab.${t}`)}
          </button>
        ))}
      </div>
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
          <div className="text-xs font-bold text-united-muted">
            {typeLabel(a)} · <bdi dir="ltr">{a.number}</bdi>
          </div>
          <div className="font-extrabold text-united-dark text-lg">{a.title}</div>
          {a.summary && <p className="text-sm font-bold text-united-dark/80 mt-0.5">{a.summary}</p>}
          <p className="text-xs font-bold text-united-muted mt-1">
            {t("approvals.requested-by", { name: a.requestedBy })} · <bdi dir="ltr">{when(a.createdAt, locale)}</bdi>
            {a.requiredLevels > 1 && t("approvals.level", { done: a.approvedLevels, required: a.requiredLevels })}
          </p>
          {a.requestReason && <p className="text-xs font-bold text-united-dark/70">{t("approvals.reason-line", { reason: a.requestReason })}</p>}
          {a.closedReason && <p className="text-xs font-bold text-united-muted">{a.closedReason}</p>}
        </div>
        <span className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full ${STATUS[a.status].cls}`}>{t(STATUS[a.status].label)}</span>
      </div>

      {a.decisions.length > 0 && (
        <ul className="mt-2 text-xs font-bold text-united-muted">
          {a.decisions.map((d) => (
            <li key={d.id}>
              {d.decision === "approve" ? "✓" : "✗"} {d.decider}
              {d.comment && ` — ${d.comment}`} · <bdi dir="ltr">{when(d.createdAt, locale)}</bdi>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2 items-end">
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
      {error && <p className="mt-2 text-sm font-bold text-united-danger">{error}</p>}
    </li>
  );
}
