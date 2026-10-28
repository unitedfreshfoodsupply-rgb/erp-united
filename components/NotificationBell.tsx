"use client";

import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const { t, dir, isRTL, locale: curLocale } = useLocale();

  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiFetch<{ items: NotificationDTO[]; unread: number }>("/api/notifications?limit=20"),
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

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
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
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
      {open && (
        <div className="absolute end-0 mt-2 w-[min(22rem,calc(100vw-2rem))] card shadow-pop p-2 z-40">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="font-extrabold text-united-dark">{t("ui.notifications")}</span>
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
                    className={`w-full flex gap-2 items-start rounded-xl px-2 py-2.5 hover:bg-united-dark/5 ${
                      n.readAt ? "opacity-60" : ""
                    }`}
                    dir={isRTL ? "rtl" : "ltr"}
                  >
                    <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.readAt ? "bg-united-dark/20" : DOT[n.severity]}`} />
                    <span className="min-w-0">
                      <span className="block font-bold text-sm text-united-dark">{n.title}</span>
                      {n.body && <span className="block text-xs font-bold text-united-muted">{n.body}</span>}
                      <span className="block text-[10px] font-bold text-united-muted mt-0.5" dir="ltr">
                        {new Date(n.createdAt).toLocaleString(curLocale === "ar" ? "ar-EG" : "en-US", { dateStyle: "short", timeStyle: "short" })}
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
