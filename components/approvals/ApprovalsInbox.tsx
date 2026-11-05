"use client";

import { intlLocale } from "@/lib/format";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { systemText } from "@/lib/locale/system-text";
import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { DICTIONARY, useLocale } from "@/lib/locale";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { Check, X } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { Pagination } from "@/components/ui/Pagination";
import { approvalAmount, DecideControls, useTypeLabel, WhoDecides, type ApprovalDTO } from "@/components/approvals/ApprovalDecision";

const STATUS: Record<ApprovalDTO["status"], { label: string; tone: Tone }> = {
  pending: { label: "approvals.status.pending", tone: "warn" },
  approved: { label: "approvals.status.approved", tone: "success" },
  rejected: { label: "approvals.status.rejected", tone: "danger" },
  cancelled: { label: "approvals.status.cancelled", tone: "neutral" },
};

/** Every approval type the screens have a label for (the same set as lib/core/approvals.ts,
 * tests/unit/approval-type-labels.test.ts). */
const TYPE_PREFIX = "approvals.type.";
const KNOWN_TYPES = Object.keys(DICTIONARY).filter((k) => k.startsWith(TYPE_PREFIX)).map((k) => k.slice(TYPE_PREFIX.length));
const PAGE_SIZE = 50;

const when = (iso: string, locale: string) => new Date(iso).toLocaleString(intlLocale(locale), { dateStyle: "short", timeStyle: "short" });

type Page = { approvals: ApprovalDTO[]; total: number };

/**
 * One inbox for every approval type: decide here, or open the thing being approved.
 * ?id= opens one request (pinned on top, scrolled to and highlighted); ?type= filters both tabs.
 */
export function ApprovalsInbox() {
  // `t` is the tab variable below; the translator is `tr` here.
  const { t: tr } = useLocale();
  const typeLabel = useTypeLabel();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const focusId = params.get("id");
  const typeParam = params.get("type");
  const type = typeParam && KNOWN_TYPES.includes(typeParam) ? typeParam : "";
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [tab, type]);

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (tab === "pending") qs.set("status", "pending");
  if (type) qs.set("type", type);
  if (page > 1) qs.set("offset", String((page - 1) * PAGE_SIZE));
  const q = useQuery({
    queryKey: ["approvals", tab, type, page],
    queryFn: () => apiFetch<Page>(`/api/approvals?${qs}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  const focus = useQuery({
    queryKey: ["approvals", "one", focusId],
    queryFn: () => apiFetch<Page>(`/api/approvals?id=${encodeURIComponent(focusId ?? "")}`).then((r) => r.approvals[0] ?? null),
    enabled: !!focusId,
    refetchInterval: 10_000,
  });

  const setParam = (key: "id" | "type", value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const rows = (q.data?.approvals ?? []).filter((a) => a.id !== focusId);
  const total = q.data?.total ?? 0;
  return (
    <div className="page-narrow">
      <PageHeader
        title={tr("approvals.title")}
        description={tr("approvals.description")}
        actions={<Segmented label={tr("approvals.title")} value={tab} onChange={setTab} items={[{ key: "pending", label: tr("approvals.tab.pending"), ...(tab === "pending" && q.data ? { count: q.data.total } : {}) }, { key: "all", label: tr("approvals.tab.all") }]} />}
      />
      {focusId && (
        <section aria-labelledby="approval-focus" className="mb-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="approval-focus" className="section-title">{tr("approvals.focus.title")}</h2>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setParam("id", null)}>{tr("approvals.focus.show-all")}</button>
          </div>
          {focus.isLoading ? <LoadingState /> : focus.isError ? <ErrorState message={errorMessage(focus.error)} onRetry={() => focus.refetch()} /> : focus.data ? (
            <ul><ApprovalCard a={focus.data} highlighted /></ul>
          ) : (
            <p className="card p-4 text-sm text-united-muted">{tr("approvals.focus.not-found")}</p>
          )}
        </section>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="field-label">{tr("approvals.filter.type")}</span>
          <select className="field" value={type} onChange={(e) => setParam("type", e.target.value || null)}>
            <option value="">{tr("approvals.filter.all-types")}</option>
            {KNOWN_TYPES.map((k) => <option key={k} value={k}>{typeLabel({ type: k, label: k })}</option>)}
          </select>
        </label>
      </div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && q.data.approvals.length === 0 && <EmptyState icon="✅" title={tab === "pending" ? tr("approvals.empty.pending") : tr("approvals.empty.all")} />}
      <ul className="flex flex-col gap-3">
        {rows.map((a) => (
          <ApprovalCard key={a.id} a={a} />
        ))}
      </ul>
      {total > PAGE_SIZE && <div className="mt-3"><Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} /></div>}
    </div>
  );
}

function ApprovalCard({ a, highlighted = false }: { a: ApprovalDTO; highlighted?: boolean }) {
  const { t, locale } = useLocale();
  const typeLabel = useTypeLabel();
  const ref = useRef<HTMLLIElement>(null);
  // The request a link opened: brought into view and focused once, so it is the one read first.
  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView({ block: "center" });
    ref.current.focus({ preventScroll: true });
  }, [highlighted]);
  const amount = approvalAmount(a);

  return (
    <li ref={ref} tabIndex={highlighted ? -1 : undefined} className={`card p-4 ${highlighted ? "ring-2 ring-united-warn outline-none" : ""}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs font-medium text-united-muted">
            {typeLabel(a)} · <bdi dir="ltr">{a.number}</bdi>
          </div>
          <div className="mt-0.5 text-base font-semibold text-united-dark">{systemText(a.title, locale)}</div>
          {a.summary && <p className="mt-0.5 text-sm text-united-dark">{systemText(a.summary, locale)}</p>}
          {amount && <p className="mt-0.5 text-sm font-bold text-united-dark">{t("approvals.amount", { amount })}</p>}
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

      {/* Not the caller's to decide (or only as an emergency): why, and who can. */}
      {a.status === "pending" && (!a.canDecide || a.emergency) && <WhoDecides a={a} className="mt-2" />}

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-united-border pt-3">
        {a.link && (
          <Link href={a.link} className="btn-secondary text-sm">
            {t("approvals.open")}
          </Link>
        )}
        {a.canDecide && <div className="flex-1 min-w-[16rem]"><DecideControls a={a} /></div>}
      </div>
    </li>
  );
}
