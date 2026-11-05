"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/lib/locale";

function relativeTime(ms: number, t: (key: string, params?: Record<string, string | number>) => string) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 3) return t("ui.live.now");
  if (secs < 60) return t("ui.live.seconds", { n: secs });
  const mins = Math.round(secs / 60);
  return t("ui.live.minutes", { n: mins });
}

/** Small "this is live" cue — a pulsing dot plus a relative last-updated time that
 * ticks on its own, so the operator trusts the screen without a manual refresh.
 * `stale`: the last background refresh failed while the screen still shows the data it had
 * (PM-4) — the cue says so and keeps counting the data's age instead of the board being
 * replaced by an error. Polling keeps retrying on its own. */
export function LiveIndicator({
  dataUpdatedAt,
  isLoading,
  stale,
}: {
  dataUpdatedAt?: number;
  isLoading?: boolean;
  stale?: boolean;
}) {
  const { t } = useLocale();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (isLoading || !dataUpdatedAt) return null;

  if (stale) {
    return (
      <div className="flex items-center gap-1.5 text-xs font-bold text-united-warn">
        <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-united-warn" />
        {t("ui.live.stale", { when: relativeTime(dataUpdatedAt, t) })}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-xs font-bold text-united-muted">
      <span className="live-dot" />
      {t("ui.live.label", { when: relativeTime(dataUpdatedAt, t) })}
    </div>
  );
}
