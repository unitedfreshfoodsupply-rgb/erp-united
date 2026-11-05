"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";

/** An action (`onSelect`) or a page to open (`href`): exactly one of the two, so no item is dead. */
export type MenuItem = ({ onSelect: () => void; href?: never } | { href: string; onSelect?: never }) & { key: string; label: string; icon?: ReactNode; tone?: "danger"; disabled?: boolean; hint?: string };

/**
 * A row's secondary actions behind one "more" button (menu button pattern): opens below at the
 * inline end, arrow keys move between items, Esc or a click elsewhere closes and returns focus,
 * Tab closes and moves on. Items that do not apply are left out by the caller; `disabled` keeps
 * one visible with a reason.
 *
 * `trigger` gives the button its own visible content (the account button: avatar, name, role);
 * that content then names the button, and `label` names the menu. `header` is shown above the
 * items, outside the role="menu" list (a menu owns only its items), and is not one of them.
 * `menuClassName` sets the popup's width when the 12rem minimum is too narrow for its labels.
 */
export function Menu({ label, items, icon, trigger, triggerClassName, header, menuClassName }: { label: string; items: MenuItem[]; icon?: ReactNode; trigger?: ReactNode; triggerClassName?: string; header?: ReactNode; menuClassName?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    box.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  if (!items.length) return null;
  const onKey = (e: React.KeyboardEvent) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); }
    if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    if (e.key === "Tab") setOpen(false);
  };
  const itemClass = (it: MenuItem) =>
    `flex w-full min-h-[40px] items-center ${it.icon ? "gap-2" : ""} px-3 text-start text-sm hover:bg-united-subtle focus-visible:bg-united-subtle disabled:cursor-not-allowed disabled:opacity-40 ${it.tone === "danger" ? "text-united-danger" : "text-united-dark"}`;
  return (
    <div ref={box} className="relative" onKeyDown={onKey}>
      <button ref={button} type="button" className={trigger ? triggerClassName : "btn-ghost btn-sm coarse:min-h-[44px] coarse:min-w-[44px]"} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
        {...(trigger ? {} : { "aria-label": label, title: label })} onClick={() => setOpen((v) => !v)}>
        {trigger ?? icon ?? <MoreHorizontal size={18} aria-hidden />}
      </button>
      {open && (
        <div className={`absolute end-0 top-full z-30 mt-1 min-w-[12rem] rounded-xl border border-united-border bg-white py-1 shadow-pop ${menuClassName ?? ""}`}>
          {header}
          <div id={id} role="menu" aria-label={label}>
          {items.map((it) =>
            it.href && !it.disabled ? (
              <Link key={it.key} href={it.href} role="menuitem" title={it.hint} className={itemClass(it)} onClick={() => setOpen(false)}>
                {it.icon}{it.label}
              </Link>
            ) : (
              <button key={it.key} type="button" role="menuitem" disabled={it.disabled} title={it.hint} className={itemClass(it)}
                onClick={() => { setOpen(false); button.current?.focus(); it.onSelect?.(); }}>
                {it.icon}{it.label}
              </button>
            )
          )}
          </div>
        </div>
      )}
    </div>
  );
}
