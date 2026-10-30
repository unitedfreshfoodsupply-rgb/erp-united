"use client";

import { useState } from "react";
import Link from "next/link";
import type { ClassifiedOrderDTO, PriorityReason } from "@/lib/client-types";
import { ArrowRight, CheckCircle2, Clock, Hourglass, OctagonAlert, PauseCircle, Truck, type LucideIcon } from "lucide-react";
import { useLocale } from "@/lib/locale";

/** Each reason: an icon and a severity colour (bar + icon), never colour alone. */
const REASON: Record<PriorityReason, { icon: LucideIcon; tone: "danger" | "warn" | "neutral" }> = {
  blocked_approval: { icon: OctagonAlert, tone: "danger" },
  stalled: { icon: PauseCircle, tone: "warn" },
  delivery_risk: { icon: Clock, tone: "warn" },
  waiting_to_start: { icon: Hourglass, tone: "warn" },
  ready_for_loading: { icon: Truck, tone: "neutral" },
  loading: { icon: Truck, tone: "neutral" },
  on_track: { icon: CheckCircle2, tone: "neutral" },
};
const BAR = { danger: "bg-united-danger", warn: "bg-[#E2A33B]", neutral: "bg-united-border-strong" };
const ICON = { danger: "text-united-danger", warn: "text-united-warn", neutral: "text-united-muted" };

function minutesLabel(min: number, t: (key: string, params?: Record<string, string | number>) => string) {
  if (min < 60) return t("attention.minutes", { m: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? t("attention.hours-minutes", { h, m }) : t("attention.hours", { h });
}

/** "Needs Attention Now" — the one, ranked, explained list a supervisor should
 * read first. Only orders with a genuinely actionable reason appear here
 * (server-classified); nothing that's merely informational/historical. */
export function NeedsAttentionQueue({ items }: { items: ClassifiedOrderDTO[] }) {
  const { t } = useLocale();
  // The server sends Arabic text plus the reason code; show the code's own wording in
  // the user's language, and the server text for a code this screen does not know.
  const byCode = (kind: "reason" | "why" | "action", code: string, fallback: string) => {
    const key = `attention.${kind}.${code}`;
    const text = t(key);
    return text === key ? fallback : text;
  };
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return (
      <div className="card flex items-center justify-center gap-2 p-4 text-united-green">
        <CheckCircle2 size={18} aria-hidden />
        <span className="font-semibold">{t("attention.none")}</span>
      </div>
    );
  }

  const shown = expanded ? items : items.slice(0, 4);

  return (
    <section className="card overflow-hidden" aria-labelledby="attention-heading">
      <div className="card-header">
        <h2 id="attention-heading" className="section-title">{t("attention.heading", { count: items.length })}</h2>
      </div>
      <ul className="divide-y divide-united-border">
        {shown.map((o) => {
          const r = REASON[o.reason];
          const Icon = r.icon;
          return (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className="relative flex gap-3 px-5 py-3.5 transition-colors hover:bg-united-bg">
                <span aria-hidden className={`absolute inset-y-2 start-0 w-1 rounded-e ${BAR[r.tone]}`} />
                <Icon size={20} className={`mt-0.5 shrink-0 ${ICON[r.tone]}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="font-semibold text-united-dark">
                      {o.customerName} <span className="text-sm font-normal text-united-muted">· <span dir="ltr">{o.orderNumber}</span></span>
                    </span>
                    <span className="whitespace-nowrap text-xs text-united-muted">{t("attention.since", { duration: minutesLabel(o.minutesInStage, t) })}</span>
                  </div>
                  <p className="mt-0.5 text-sm font-medium text-united-dark">{byCode("reason", o.reason, o.reasonLabel)}</p>
                  <p className="mt-0.5 text-xs text-united-muted">{byCode("why", o.reason, o.whyItMatters)}</p>
                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold text-united-green">
                    <ArrowRight size={15} className="rtl:rotate-180" aria-hidden />
                    {byCode("action", o.reason, o.recommendedAction)}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {items.length > 4 && (
        <div className="border-t border-united-border px-5 py-2.5">
          <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} className="min-h-10 px-1 text-sm font-semibold text-united-green hover:underline">
            {expanded ? t("attention.show-less") : t("attention.show-all", { count: items.length })}
          </button>
        </div>
      )}
    </section>
  );
}
