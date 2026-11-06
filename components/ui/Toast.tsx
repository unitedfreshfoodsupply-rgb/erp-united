"use client";

import { intlLocale } from "@/lib/format";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from "lucide-react";
import { useLocale } from "@/lib/locale";

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; text: string; href?: string; time: string };
type ShowOptions = { kind?: ToastKind; href?: string };

const ToastContext = createContext<{
  show: (text: string, opts?: ToastKind | ShowOptions) => void;
  /** Take back an error that no longer holds (the user fixed what it was about). */
  clear: (text: string) => void;
} | null>(
  null
);

const KIND_STYLE: Record<ToastKind, string> = {
  success: "bg-united-dark text-white",
  error: "bg-united-danger text-white",
  info: "bg-white text-united-dark border border-united-border",
};

const KIND_ICON: Record<ToastKind, LucideIcon> = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
};

/** Success and info notes leave on their own. An error is often the only place a refusal is
 * explained (two lines with figures), so it stays until it is closed. */
const AUTO_DISMISS_MS = 4200;
/** At most this many errors on screen: a new one pushes out the oldest. */
const MAX_ERRORS = 3;

function nowLabel() {
  // Called outside render: read the language the locale provider put on <html>.
  const en = typeof document !== "undefined" && document.documentElement.lang === "en";
  return new Date().toLocaleTimeString(intlLocale(en ? "en" : "ar"), { hour: "2-digit", minute: "2-digit" });
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const { t } = useLocale();

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);

  // Accepts either a plain kind ("success") or { kind, href } for a notification
  // that should link straight to the order it's about.
  const show = useCallback((text: string, opts?: ToastKind | ShowOptions) => {
    const { kind = "success", href } = typeof opts === "string" ? { kind: opts } : opts ?? {};
    const id = ++counter.current;
    const next: ToastItem = { id, kind, text, href, time: nowLabel() };
    if (kind !== "error") {
      setToasts((all) => [...all, next]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      return;
    }
    setToasts((all) => {
      // The same error again replaces the one on screen; past the cap the oldest goes.
      const kept = all.filter((x) => !(x.kind === "error" && x.text === text));
      const errors = kept.filter((x) => x.kind === "error");
      const drop = new Set(errors.slice(0, Math.max(0, errors.length - MAX_ERRORS + 1)).map((x) => x.id));
      return [...kept.filter((x) => !drop.has(x.id)), next];
    });
  }, [dismiss]);

  const clear = useCallback((text: string) => setToasts((all) => all.filter((x) => !(x.kind === "error" && x.text === text))), []);

  const render = (x: ToastItem) => {
    const Icon = KIND_ICON[x.kind];
    const body = (
      <>
        <Icon size={18} className="shrink-0" aria-hidden />
        <span className="flex-1">{x.text}</span>
        <span className="text-xs font-normal opacity-60 shrink-0" aria-hidden>{x.time}</span>
      </>
    );
    const cls = `pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl shadow-pop font-semibold text-sm max-w-sm animate-[toast-in_0.15s_ease-out] ${KIND_STYLE[x.kind]}`;
    if (x.kind === "error") {
      return (
        <div key={x.id} className={`${cls} pe-2`}>
          {x.href ? <Link href={x.href} className="flex flex-1 items-center gap-2 hover:opacity-90">{body}</Link> : body}
          <button type="button" onClick={() => dismiss(x.id)} className="-my-1 shrink-0 rounded-lg p-1.5 hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" aria-label={t("ui.close")}>
            <X size={16} aria-hidden />
          </button>
        </div>
      );
    }
    return x.href ? (
      <Link key={x.id} href={x.href} className={`${cls} hover:opacity-90`}>
        {body}
      </Link>
    ) : (
      <div key={x.id} className={cls}>
        {body}
      </div>
    );
  };

  return (
    <ToastContext.Provider value={{ show, clear }}>
      {children}
      <div className="fixed bottom-20 sm:bottom-6 inset-x-0 z-50 flex flex-col items-center gap-2 pointer-events-none px-4">
        {/* Errors are announced at once, the rest politely. Both regions stay mounted, so a
            screen reader hears what is added to them. */}
        <div role="alert" className="flex flex-col items-center gap-2">
          {toasts.filter((x) => x.kind === "error").map(render)}
        </div>
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-2">
          {toasts.filter((x) => x.kind !== "error").map(render)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
