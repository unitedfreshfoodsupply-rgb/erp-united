"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, errorMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill, docTone } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { fmtMoney } from "@/components/stock/inventory/shared";
import { AwaitingApproval } from "@/components/approvals/AwaitingApproval";
import { APPROVAL_TYPE } from "@/lib/core/approval-presentation";
import { changeText } from "@/lib/auditLabels";

type Req = { id: string; number: string; date: string; description: string; total: string; status: "pending_approval" | "posted" | "rejected" | "cancelled"; requestedBy: string; decidedBy: string | null; decisionNote: string | null; entry: { number: string } | null };

/** Manual journals waiting for (or decided by) a second person — shown only when there are any. */
export function JournalRequests() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["acc", "journal-requests"], queryFn: () => apiFetch<{ requests: Req[] }>("/api/accounting/journal-requests").then((r) => r.requests) });
  const rows = (q.data ?? []).filter((r) => r.status === "pending_approval" || Date.now() - Date.parse(`${r.date}T00:00:00Z`) < 30 * 86_400_000);
  // A failed load must not look like "nothing waiting": say so, with a retry.
  if (q.isError) return (
    <section className="card p-3 flex flex-wrap items-center justify-between gap-2" role="alert">
      <span className="text-sm font-semibold text-united-danger">{t("journal.requests-load-error")}{errorMessage(q.error) ? ` — ${errorMessage(q.error)}` : ""}</span>
      <button type="button" className="btn-secondary btn-sm" onClick={() => q.refetch()}>{t("ui.retry")}</button>
    </section>
  );
  if (!rows.length) return null;
  // The compact notices share one request for exactly the pending rows shown.
  const pendingIds = rows.filter((r) => r.status === "pending_approval").map((r) => r.id);
  const cancel = async (r: Req) => {
    const reason = await dialogs.prompt({ title: t("journal.prompt-cancel", { number: r.number }), label: t("ui.reason-label"), required: true, tone: "danger", confirmLabel: t("journal.cancel") });
    if (!reason) return;
    try { await apiPost(`/api/accounting/journal-requests/${r.id}/cancel`, { reason }); toast.show(t("journal.toast-cancelled"), "success"); void qc.invalidateQueries({ queryKey: ["acc"] }); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  return (
    <section className="card overflow-x-auto" aria-labelledby="journal-requests">
      <div className="p-3">
        <h2 id="journal-requests" className="section-title">{t("journal.requests-title")}</h2>
        <p className="text-xs text-united-muted">{t("journal.requests-hint")}</p>
      </div>
      <table className="data-table">
        <thead><tr><th>{t("treasury.col.number")}</th><th>{t("treasury.col.date")}</th><th>{t("accounting.description")}</th><th className="num">{t("treasury.field.amount")}</th><th>{t("treasury.col.status")}</th><th><span className="sr-only">{t("treasury.col.actions")}</span></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><bdi dir="ltr">{r.number}</bdi>{r.entry && <span className="block text-xs text-united-muted"><bdi dir="ltr">{r.entry.number}</bdi></span>}</td>
              <td><bdi dir="ltr">{r.date}</bdi></td>
              <td>{r.description}<span className="block text-xs text-united-muted">{/* requester → decider, the arrow in the reading direction (U+2192 does not mirror) */}{r.decidedBy ? changeText(r.requestedBy, r.decidedBy, locale) : r.requestedBy}{r.decisionNote ? ` · ${r.decisionNote}` : ""}</span></td>
              <td className="num" dir="ltr">{fmtMoney(r.total)}</td>
              <td><StatusPill tone={docTone(r.status)}>{t(`journal.status.${r.status}`)}</StatusPill>{r.status === "pending_approval" && <AwaitingApproval type={APPROVAL_TYPE.manualJournal} entityId={r.id} compact batch={pendingIds} />}</td>
              <td>{r.status === "pending_approval" && can("accounting.manage") && <button type="button" className="btn-secondary btn-sm" onClick={() => cancel(r)}>{t("journal.cancel")}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
