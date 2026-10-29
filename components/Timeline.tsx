"use client";

import { useQuery } from "@tanstack/react-query";
import { systemText } from "@/lib/locale/system-text";
import { apiFetch } from "@/lib/api-client";
import type { AuditLogDTO } from "@/lib/client-types";
import { buildTimeline, SOURCE_LABEL, SOURCE_LABEL_EN } from "@/lib/auditLabels";
import { agoLabel, clockLabel } from "@/lib/format";
import { TimelineSkeleton } from "@/components/Skeleton";
import { useLocale } from "@/lib/locale";
import { EventIcon } from "@/components/ui/EventIcon";

/**
 * The order's story, oldest first: WHO did WHAT, to WHICH item, with WHAT result, WHEN.
 *
 * Milestones (the order moving between stages) are visually heavier than the routine
 * item-by-item work, so an operator can find "where is this now" without reading every
 * weighing. Raw audit fields are deliberately not shown here — they remain on the
 * supervisor's audit screen under the technical view.
 */
export function Timeline({ orderId }: { orderId: string }) {
  const { t, locale } = useLocale();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["audit", orderId],
    queryFn: () => apiFetch<{ logs: AuditLogDTO[] }>(`/api/audit?orderId=${orderId}`),
    // Slower than the order itself: the timeline is context, not the working surface,
    // and it is invalidated directly whenever an action on this page succeeds.
    refetchInterval: 20_000,
    staleTime: 5_000,
  });

  if (isLoading) return <TimelineSkeleton />;
  if (isError)
    return (
      <p className="text-united-danger font-bold">
        {t("ui.timeline.error")}{" "}
        <button type="button" onClick={() => refetch()} className="underline">
          {t("ui.timeline.retry")}
        </button>
      </p>
    );

  const events = buildTimeline(data?.logs ?? [], locale);
  if (!events.length) return <p className="text-united-dark/50">{t("ui.timeline.empty")}</p>;

  return (
    <ul className="flex flex-col">
      {events.map((e, i) => (
        <li key={e.id} className="flex gap-3 items-start relative pb-4">
          {/* connector line between events */}
          {i < events.length - 1 && (
            <span className="absolute top-7 start-[13px] bottom-0 w-px bg-united-border" aria-hidden />
          )}
          <span
            className={`z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
              e.milestone ? "bg-united-green/15 text-united-green" : "bg-united-subtle text-united-muted"
            }`}
          >
            <EventIcon symbol={e.icon} size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={`${e.milestone ? "font-semibold" : "font-medium"} text-united-dark`}>
              <span className="text-united-green">{e.actor}</span> {e.headline}
            </div>
            {e.detail && <div className="text-sm text-united-dark/80">{systemText(e.detail, locale)}</div>}
            {e.reason && <div className="text-sm text-united-muted">{t("audit.reason-prefix")} {e.reason}</div>}
            <div className="flex items-center gap-1.5 flex-wrap text-xs text-united-muted mt-0.5">
              <span dir="ltr">{clockLabel(e.at, locale)}</span>
              <span>·</span>
              <span>{agoLabel(e.at, undefined, locale)}</span>
              {e.source !== "user" && (
                <span className="rounded-full bg-united-subtle px-1.5 py-0.5">
                  {(locale === "en" ? SOURCE_LABEL_EN : SOURCE_LABEL)[e.source] ?? e.source}
                </span>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
