"use client";

import { intlLocale } from "@/lib/format";
import { Bell } from "lucide-react";
import { systemText } from "@/lib/locale/system-text";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";

type NotificationDTO = {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

const DOT: Record<NotificationDTO["severity"], string> = {
  info: "bg-united-info",
  warning: "bg-united-warn",
  critical: "bg-united-danger",
};

/**
 * The header bell: unread count, and a panel with the latest notifications. Opening
 * one marks it read and goes to the thing it is about.
 */
export function NotificationBell() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const { t, dir, isRTL, locale: curLocale, locale } = useLocale();

  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiFetch<{ items: NotificationDTO[]; unread: number }>("/api/notifications?limit=20"),
    refetchInterval: 20_000,
    // The bell is part of every page's header and remounts with each page: a list fetched in
    // the last 15 s is shown as it is instead of being asked for again on every navigation
    // (the 20 s poll and "mark read" still refresh it).
    staleTime: 15_000,
  });

  // Opening moves focus to the panel's title (a dialog takes focus; the title names it). The panel
  // closes on a click elsewhere, when focus moves out of the bell and panel (Tab past its last
  // item, like the kit Menu), or on Esc while it is open, with focus back on the bell.
  useEffect(() => {
    if (!open) return;
    title.current?.focus();
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    // Esc from anywhere while the panel is open: focus may be on the page behind it.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      bell.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);
  // Focus leaving for another control closes the panel; focus leaving for nowhere (the window
  // lost focus, a click on the page) is the mousedown handler's business.
  const onBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (open && next && !box.current?.contains(next)) setOpen(false);
  };

  const unread = q.data?.unread ?? 0;

  async function openItem(n: NotificationDTO) {
    setOpen(false);
    if (!n.readAt) {
      await apiPost("/api/notifications/read", { ids: [n.id] }).catch(() => undefined);
      qc.invalidateQueries({ queryKey: ["notifications"] });
    }
    if (n.link) router.push(n.link);
  }

  async function readAll() {
    await apiPost("/api/notifications/read", { all: true }).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ["notifications"] });
  }

  return (
    <div className="relative" ref={box} onBlur={onBlur}>
      <button
        ref={bell}
        type="button"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={unread > 0 ? t("ui.notifications.count", { n: unread }) : t("ui.notifications")}
        dir={dir}
        className="relative w-10 h-10 rounded-xl text-united-dark hover:bg-united-subtle grid place-items-center"
      >
        <Bell size={20} strokeWidth={1.75} aria-hidden />
        {unread > 0 && (
          <span className="absolute -top-0.5 -end-0.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-united-danger text-white text-[11px] font-bold grid place-items-center tabular-nums ring-2 ring-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {/* On a phone the bell sits well inside the header, so a panel hung from it ran off the
          start edge. Below sm the panel is pinned to the header instead (its backdrop-blur makes
          the header the containing block of a fixed child), 1rem from either screen edge.
          Mobile-first on purpose: `max-sm:` emits nothing with this project's custom screens. */}
      {open && (
        <div id={panelId} role="dialog" aria-labelledby={`${panelId}-title`} className="fixed inset-x-4 top-14 sm:absolute sm:inset-x-auto sm:top-auto sm:end-0 sm:w-[22rem] mt-2 card shadow-pop p-2 z-40">
          <div className="flex items-center justify-between px-2 py-1">
            <span ref={title} id={`${panelId}-title`} tabIndex={-1} className="font-extrabold text-united-dark outline-none">{t("ui.notifications")}</span>
            {unread > 0 && (
              <button type="button" onClick={readAll} className="text-xs font-bold text-united-green">
                {t("ui.notifications.mark-read")}
              </button>
            )}
          </div>
          {(q.data?.items.length ?? 0) === 0 ? (
            <p className="p-4 text-center text-sm font-bold text-united-muted">{t("ui.notifications.empty")}</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {q.data!.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => openItem(n)}
                    // A read notification is told apart by its grey dot and lighter title, not by
                    // dimming the whole row (that took its text below AA contrast).
                    className="w-full flex gap-2 items-start rounded-xl px-2 py-2.5 hover:bg-united-dark/5"
                    dir={isRTL ? "rtl" : "ltr"}
                  >
                    <span aria-hidden className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.readAt ? "bg-united-dark/20" : DOT[n.severity]}`} />
                    <span className="min-w-0">
                      <span className={`block text-sm text-united-dark ${n.readAt ? "font-medium" : "font-bold"}`}>{systemText(n.title, locale)}</span>
                      {n.body && <span className="block text-xs font-bold text-united-muted">{n.body}</span>}
                      <span className="block text-[10px] font-bold text-united-muted mt-0.5" dir="ltr">
                        {new Date(n.createdAt).toLocaleString(intlLocale(curLocale), { dateStyle: "short", timeStyle: "short" })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
