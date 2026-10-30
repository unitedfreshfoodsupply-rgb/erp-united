"use client";

import { useLocale } from "@/lib/locale";

/**
 * Footer for a list that returns a window of its rows (see lib/core/list-window.ts):
 * says how many of how many are shown and loads the next batch. Renders nothing when
 * every row is already on screen.
 */
export function ListMore({ shown, total, busy, onMore }: { shown: number; total: number; busy?: boolean; onMore: () => void }) {
  const { t } = useLocale();
  if (shown >= total) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-bold text-united-muted" role="status">
      <span>{t("ui.list.showing", { shown, total })}</span>
      <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={onMore}>{t("ui.list.more")}</button>
    </div>
  );
}

/** Rows added by each "load more". */
export const LIST_PAGE = 300;
