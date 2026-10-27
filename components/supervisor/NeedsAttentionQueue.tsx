"use client";

import { useState } from "react";
import Link from "next/link";
import type { ClassifiedOrderDTO, PriorityReason } from "@/lib/client-types";
import { useLocale } from "@/lib/locale";

const REASON_ICON: Record<PriorityReason, string> = {
  blocked_approval: "🔴",
  stalled: "⏸️",
  delivery_risk: "⏰",
  waiting_to_start: "⏳",
  ready_for_loading: "🟢",
  loading: "🟠",
  on_track: "✓",
};

const REASON_TONE: Record<PriorityReason, string> = {
  blocked_approval: "border-united-danger/30 bg-red-50/50",
  stalled: "border-united-warn/30 bg-amber-50/50",
  delivery_risk: "border-united-warn/30 bg-amber-50/50",
  waiting_to_start: "border-united-warn/20 bg-amber-50/30",
  ready_for_loading: "border-united-border",
  loading: "border-united-border",
  on_track: "border-united-border",
};

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
      <div className="card p-4 border-united-green/30 bg-united-green/5 text-center">
        <span className="font-extrabold text-united-dark">{t("attention.none")}</span>
      </div>
    );
  }

  const shown = expanded ? items : items.slice(0, 4);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-extrabold text-united-dark">{t("attention.heading", { count: items.length })}</h2>
      </div>
      <div className="flex flex-col gap-2">
        {shown.map((o) => (
          <Link
            key={o.id}
            href={`/orders/${o.id}`}
            className={`block rounded-xl border-2 p-3 transition hover:border-united-green/50 ${REASON_TONE[o.reason]}`}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-extrabold text-united-dark">
                {REASON_ICON[o.reason]} {o.customerName}{" "}
                <span className="text-united-muted font-bold text-sm">· {o.orderNumber}</span>
              </span>
              <span className="text-xs font-bold text-united-dark/60 whitespace-nowrap">
                {t("attention.since", { duration: minutesLabel(o.minutesInStage, t) })}
              </span>
            </div>
            <p className="text-sm font-bold text-united-dark mt-1">{byCode("reason", o.reason, o.reasonLabel)}</p>
            <p className="text-xs text-united-dark/60 mt-0.5">{byCode("why", o.reason, o.whyItMatters)}</p>
            <p className="text-sm font-bold text-united-green mt-1">← {byCode("action", o.reason, o.recommendedAction)}</p>
          </Link>
        ))}
      </div>
      {items.length > 4 && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-sm font-bold text-united-muted underline mt-3"
        >
          {expanded ? t("attention.show-less") : t("attention.show-all", { count: items.length })}
        </button>
      )}
    </div>
  );
}
