"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export type MenuItem = { key: string; label: string; onSelect: () => void; tone?: "danger"; disabled?: boolean; hint?: string };

/**
 * A row's secondary actions behind one "more" button (menu button pattern): opens below at the
 * inline end, arrow keys move between items, Esc or a click elsewhere closes and returns focus.
 * Items that do not apply are left out by the caller; `disabled` keeps one visible with a reason.
 */
export function Menu({ label, items, icon }: { label: string; items: MenuItem[]; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    box.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  if (!items.length) return null;
  const onKey = (e: React.KeyboardEvent) => {
    const all = [...(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); }
    if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    if (e.key === "Tab") setOpen(false);
  };
  return (
    <div ref={box} className="relative" onKeyDown={onKey}>
      <button ref={button} type="button" className="btn-ghost btn-sm coarse:min-h-[44px] coarse:min-w-[44px]" aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        {icon ?? <MoreHorizontal size={18} aria-hidden />}
      </button>
      {open && (
        <div id={id} role="menu" aria-label={label} className="absolute end-0 top-full z-30 mt-1 min-w-[12rem] rounded-xl border border-united-border bg-white py-1 shadow-pop">
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitem" disabled={it.disabled} title={it.hint}
              className={`flex w-full min-h-[40px] items-center px-3 text-start text-sm hover:bg-united-subtle focus-visible:bg-united-subtle disabled:cursor-not-allowed disabled:opacity-40 ${it.tone === "danger" ? "text-united-danger" : "text-united-dark"}`}
              onClick={() => { setOpen(false); button.current?.focus(); it.onSelect(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
