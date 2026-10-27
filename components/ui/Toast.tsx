"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import Link from "next/link";

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; text: string; href?: string; time: string };
type ShowOptions = { kind?: ToastKind; href?: string };

const ToastContext = createContext<{ show: (text: string, opts?: ToastKind | ShowOptions) => void } | null>(
  null
);

const KIND_STYLE: Record<ToastKind, string> = {
  success: "bg-united-dark text-white",
  error: "bg-united-danger text-white",
  info: "bg-white text-united-dark border border-united-dark/10",
};

const KIND_ICON: Record<ToastKind, string> = {
  success: "✓",
  error: "⚠️",
  info: "ℹ️",
};

function nowLabel() {
  // Called outside render: read the language the locale provider put on <html>.
  const en = typeof document !== "undefined" && document.documentElement.lang === "en";
  return new Date().toLocaleTimeString(en ? "en-GB" : "ar-EG", { hour: "2-digit", minute: "2-digit" });
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  // Accepts either a plain kind ("success") or { kind, href } for a notification
  // that should link straight to the order it's about.
  const show = useCallback((text: string, opts?: ToastKind | ShowOptions) => {
    const { kind = "success", href } = typeof opts === "string" ? { kind: opts } : opts ?? {};
    const id = ++counter.current;
    setToasts((t) => [...t, { id, kind, text, href, time: nowLabel() }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-20 sm:bottom-6 inset-x-0 z-50 flex flex-col items-center gap-2 pointer-events-none px-4">
        {toasts.map((t) => {
          const body = (
            <>
              <span>{KIND_ICON[t.kind]}</span>
              <span className="flex-1">{t.text}</span>
              <span className="text-xs font-normal opacity-60 shrink-0">{t.time}</span>
            </>
          );
          const cls = `pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-2xl shadow-lg font-bold text-sm max-w-sm animate-[toast-in_0.15s_ease-out] ${KIND_STYLE[t.kind]}`;
          return t.href ? (
            <Link key={t.id} href={t.href} className={`${cls} hover:opacity-90`}>
              {body}
            </Link>
          ) : (
            <div key={t.id} className={cls}>
              {body}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
