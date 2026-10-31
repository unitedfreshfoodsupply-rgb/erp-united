"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck, BarChart3, BookOpen, CalendarCheck, CalendarDays, ChevronDown, ClipboardList, Clock, FileCheck2, FileSpreadsheet, Gauge, House, Landmark,
  Languages, LayoutDashboard, LogOut, Menu, PackageOpen, PackageSearch, PanelLeftClose, PanelLeftOpen, ReceiptText, ScrollText, Settings, ShieldAlert,
  ShoppingCart, Sprout, Truck, UserRound, Users, Wallet, Warehouse, X, Building2, type LucideIcon,
} from "lucide-react";
import { useSession, usePermissions } from "@/lib/use-session";
import { apiPost } from "@/lib/api-client";
import { ROLE_LABEL, ROLE_LABEL_EN } from "@/lib/types";
import { visibleNavLinks, homePathFor, NAV_GROUPS, type NavGroup, type NavLink } from "@/lib/nav";
import { NotificationBell } from "@/components/NotificationBell";
import { Modal } from "@/components/ui/Dialog";
import { useLocale } from "@/lib/locale";
import { Avatar } from "@/components/ui/Avatar";

/**
 * The application shell.
 *
 *  - Roles that span several departments (office: admin, finance, supervision) get a
 *    sidebar on desktop — every module one click away, grouped by department — and the
 *    same list in a drawer below 1024px.
 *  - Roles with a handful of screens (the floor: preparation, loading) keep a single row
 *    of large tabs under the top bar on every screen size: no menu to open on a tablet.
 *
 * Links still come only from visibleNavLinks(permissions), so the shell can never offer
 * a module the server would refuse. The page offset for the sidebar is pure CSS
 * (main:has(.u-shell-sidebar) in app/globals.css), so nothing shifts after hydration.
 */

const GROUP_ICON: Record<NavGroup, LucideIcon> = {
  home: House,
  people: UserRound,
  ops: Truck,
  control: Gauge,
  sales: Users,
  purchasing: ShoppingCart,
  stock: Warehouse,
  finance: Landmark,
  admin: Settings,
};

/** One line icon per module, so a long list can be scanned by shape as well as by word. */
const LINK_ICON: Record<string, LucideIcon> = {
  "/home": House, "/prep": PackageOpen, "/load": Truck, "/production": Sprout, "/production/sheet": ClipboardList, "/operations": Truck,
  "/supervisor": Gauge, "/supervisor/exceptions": ShieldAlert, "/supervisor/report": FileSpreadsheet, "/supervisor/audit": ScrollText, "/approvals": BadgeCheck,
  "/management/operations": BarChart3, "/sales": Users, "/purchasing": ShoppingCart, "/accounting": Landmark, "/assets": Building2, "/eta": ReceiptText,
  "/management/overview": LayoutDashboard, "/management": BarChart3, "/stock": Warehouse, "/stock/inventory": PackageSearch, "/stock/entries": FileCheck2,
  "/stock/ledger": BookOpen, "/stock/setup": ClipboardList, "/hr": Wallet, "/hr/attendance": Clock, "/hr/leave": CalendarDays, "/hr/payroll": CalendarCheck,
  "/admin": Settings,
};

const COLLAPSED_KEY = "united_nav_collapsed";

/** Only the most specific link is "here": on /stock/inventory, the /stock/inventory link — not /stock as well. */
function activeHrefFor(links: NavLink[], pathname: string | null) {
  const matches = (href: string) => pathname === href || (href !== "/" && !!pathname?.startsWith(href + "/"));
  return links.filter((l) => matches(l.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

function Brand({ href, compact = false }: { href: string; compact?: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 shrink-0 rounded-lg" aria-label="UNITED">
      <Image src="/brand/united-mark.webp" alt="" width={34} height={34} className="shrink-0" priority />
      {!compact && (
        <span className="flex flex-col leading-none" dir="ltr">
          <span className="font-bold tracking-wide text-united-dark">UNITED</span>
          <span className="text-[10px] font-medium text-united-muted">Fruits &amp; Vegetables</span>
        </span>
      )}
    </Link>
  );
}

function GroupedLinks({ links, activeHref, onNavigate, rail = false }: { links: NavLink[]; activeHref?: string; onNavigate?: () => void; rail?: boolean }) {
  const { t } = useLocale();
  const groups = NAV_GROUPS.filter((g) => links.some((l) => l.group === g.key));
  // Groups the person folded away, remembered in this browser; the group holding the current
  // page always stays open so "where am I" is never hidden.
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]"); } catch { return []; }
  });
  const toggle = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* storage unavailable: the choice lasts for this page only */ }
  };
  return (
    <div className={`flex flex-col ${rail ? "gap-2" : "gap-3"}`}>
      {groups.map((g) => {
        const Icon = GROUP_ICON[g.key];
        const items = links.filter((l) => l.group === g.key);
        const holdsActive = items.some((l) => l.href === activeHref);
        const single = items.length === 1;
        const open = rail || single || holdsActive || !collapsed.includes(g.key);
        return (
          <section key={g.key} aria-label={t(g.labelKey)} className={rail ? "border-b border-united-border pb-2 last:border-0" : ""}>
            {!rail && !single && (
              <button
                type="button"
                onClick={() => !holdsActive && toggle(g.key)}
                aria-expanded={open}
                className="flex w-full min-h-[32px] items-center gap-2 rounded-md px-3 text-[11px] font-semibold uppercase tracking-wide text-united-muted hover:text-united-dark"
              >
                <Icon size={14} strokeWidth={2} aria-hidden />
                <span className="flex-1 text-start">{t(g.labelKey)}</span>
                {!holdsActive && <ChevronDown size={14} aria-hidden className={`transition-transform ${open ? "" : "-rotate-90 rtl:rotate-90"}`} />}
              </button>
            )}
            {open && (
              <ul className="flex flex-col gap-0.5">
                {items.map((l) => {
                  const active = l.href === activeHref;
                  const ItemIcon = LINK_ICON[l.href] ?? Icon;
                  const label = t(l.labelKey);
                  return (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        aria-label={rail ? label : undefined}
                        title={rail ? label : undefined}
                        className={`relative flex min-h-[38px] items-center gap-2.5 rounded-lg text-sm transition-colors coarse:min-h-[44px] ${rail ? "justify-center px-0" : "px-3"} ${
                          active ? "bg-united-green/10 font-semibold text-united-green" : "text-united-dark hover:bg-united-subtle"
                        }`}
                      >
                        {active && <span aria-hidden className="absolute inset-y-1.5 start-0 w-[3px] rounded-full bg-united-green" />}
                        <ItemIcon size={17} strokeWidth={active ? 2.25 : 1.75} aria-hidden className={`shrink-0 ${active ? "" : "text-united-muted"}`} />
                        {!rail && <span className="truncate">{label}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** The desktop sidebar can fold to an icon rail; remembered in a layout cookie (read by the
 * root layout as data-rail, so the page offset is right before any script runs). */
function useRail() {
  const [rail, setRail] = useState(false);
  useEffect(() => { setRail(document.documentElement.dataset.rail === "1"); }, []);
  const toggle = () => {
    const next = !rail;
    setRail(next);
    document.documentElement.dataset.rail = next ? "1" : "0";
    document.cookie = `u_rail=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  };
  return [rail, toggle] as const;
}

export function Nav() {
  const { data, isLoading } = useSession();
  const { permissions } = usePermissions();
  const { t, locale, toggleLocale } = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const user = data?.user;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rail, toggleRail] = useRail();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuBox = useRef<HTMLDivElement>(null);

  // Leaving the page closes the drawer and the account menu.
  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // The account menu closes on a click elsewhere or on Esc (focus back on its button).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!menuBox.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenuOpen(false); menuBox.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  async function logout() {
    setLoggingOut(true);
    try {
      await apiPost("/api/auth/logout");
    } catch {
      // A failed logout should never leave the user stranded on a dead session:
      // clear the local credential anyway and land on the login screen.
    } finally {
      // Remove the tab-scoped Bearer token so this tab is signed out even if
      // other tabs still hold their own tokens (sessionStorage is per-tab).
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("united_token");
      }
      qc.clear();
      router.push("/login");
    }
  }

  // Links come from the shared NAV_LINKS definition filtered by effective permissions,
  // so the shell can never offer a module the server would refuse.
  const links = visibleNavLinks(permissions);
  const groups = NAV_GROUPS.filter((g) => links.some((l) => l.group === g.key));
  // A role with a handful of screens sees them all as tabs; a role spanning departments
  // gets the grouped sidebar — never a wall of twenty pills.
  const grouped = links.length > 7 && groups.length > 1;

  // Remember the shell shape for the next page load (a layout hint, nothing else).
  useEffect(() => {
    if (!user) return;
    const shape = grouped ? "grouped" : "tabs";
    if (!document.cookie.split("; ").includes(`u_shell=${shape}`)) {
      document.cookie = `u_shell=${shape}; path=/; max-age=31536000; samesite=lax`;
    }
  }, [user, grouped]);

  // Hold the bar's height (and, on the desktop, the sidebar's width when this browser's last
  // session had one — the u_shell hint above, read in app/layout.tsx) while the session
  // loads, so the page does not move once it arrives.
  if (!user) {
    return isLoading ? (
      <>
        <span aria-hidden className="u-shell-placeholder hidden" />
        <div aria-hidden className="sticky top-0 z-20 h-14 box-content border-b border-united-border bg-white/95" />
      </>
    ) : null;
  }

  const home = homePathFor(permissions, user.role);
  const roleLabel = locale === "en" ? ROLE_LABEL_EN[user.role] : ROLE_LABEL[user.role];
  const activeHref = activeHrefFor(links, pathname);
  const activeLink = links.find((l) => l.href === activeHref);
  const activeGroup = activeLink ? NAV_GROUPS.find((g) => g.key === activeLink.group) : undefined;

  return (
    <>
      {grouped && (
        <aside className="u-shell-sidebar hidden lg:flex fixed inset-y-0 start-0 z-30 w-[var(--u-sidebar)] flex-col border-e border-united-border bg-white">
          <div className={`flex h-14 items-center border-b border-united-border ${rail ? "justify-center px-2" : "px-4"}`}>
            <Brand href={home} compact={rail} />
          </div>
          <nav aria-label={t("ui.nav.main")} className={`flex-1 overflow-y-auto py-3 ${rail ? "px-1.5" : "px-2"}`}>
            <GroupedLinks links={links} activeHref={activeHref} rail={rail} />
          </nav>
          <div className="border-t border-united-border p-2">
            <button type="button" onClick={toggleRail} aria-pressed={rail} title={rail ? t("ui.nav.expand") : t("ui.nav.collapse")}
              className={`flex w-full min-h-[38px] items-center gap-2.5 rounded-lg text-sm text-united-muted hover:bg-united-subtle hover:text-united-dark ${rail ? "justify-center" : "px-3"}`}>
              {rail ? <PanelLeftOpen size={17} aria-hidden className="rtl:-scale-x-100" /> : <PanelLeftClose size={17} aria-hidden className="rtl:-scale-x-100" />}
              {rail ? <span className="sr-only">{t("ui.nav.expand")}</span> : <span>{t("ui.nav.collapse")}</span>}
            </button>
          </div>
        </aside>
      )}

      <header className="sticky top-0 z-20 border-b border-united-border bg-white/95 backdrop-blur-sm">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          {grouped && (
            <button type="button" onClick={() => setDrawerOpen(true)} className="lg:hidden grid h-10 w-10 place-items-center rounded-xl hover:bg-united-subtle" aria-label={t("ui.nav.open-menu")}>
              <Menu size={20} aria-hidden />
            </button>
          )}
          <div className={grouped ? "lg:hidden" : ""}>
            <Brand href={home} compact={grouped} />
          </div>
          {/* Where am I: department › module, on the desktop shell. */}
          {grouped && activeLink && (
            <p className="hidden lg:flex items-center gap-1.5 text-sm text-united-muted min-w-0">
              {/* A group named like its only page (Home) is not repeated. */}
              {activeGroup && t(activeGroup.labelKey) !== t(activeLink.labelKey) && <><span>{t(activeGroup.labelKey)}</span><span aria-hidden>/</span></>}
              <span className="font-semibold text-united-dark truncate">{t(activeLink.labelKey)}</span>
            </p>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={toggleLocale}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl px-2.5 text-sm font-medium text-united-dark hover:bg-united-subtle"
            title={t("ui.lang.switch")}
            lang={locale === "ar" ? "en" : "ar"}
          >
            <Languages size={18} strokeWidth={1.75} aria-hidden />
            <span>{t("ui.lang.switch")}</span>
          </button>
          <NotificationBell />
          <div className="relative" ref={menuBox}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="flex h-10 items-center gap-2 rounded-xl ps-1 pe-2 hover:bg-united-subtle"
            >
              <Avatar name={user.name} seed={user.id} size="sm" />
              <span className="hidden sm:flex flex-col items-start leading-tight">
                <span className="text-sm font-semibold text-united-dark">{user.name}</span>
                <span className="text-[11px] text-united-muted">{roleLabel}</span>
              </span>
              <ChevronDown size={16} className="text-united-muted" aria-hidden />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute end-0 mt-2 w-56 card shadow-pop p-1.5 z-40">
                <div className="px-3 py-2 sm:hidden">
                  <div className="text-sm font-semibold">{user.name}</div>
                  <div className="text-xs text-united-muted">{t("ui.role")} {roleLabel}</div>
                </div>
                <Link role="menuitem" href="/profile" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-united-subtle">
                  <UserRound size={16} aria-hidden /> {t("ui.profile")}
                </Link>
                <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); setConfirmingLogout(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-united-danger hover:bg-red-50">
                  <LogOut size={16} aria-hidden /> {t("ui.logout")}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Floor roles: every screen one tap away, on every device. */}
        {!grouped && links.length > 0 && (
          <nav aria-label={t("ui.nav.main")} className="flex items-end gap-1 overflow-x-auto no-scrollbar px-3 sm:px-4">
            {links.map((l) => {
              const active = l.href === activeHref;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative inline-flex min-h-[44px] items-center whitespace-nowrap px-3.5 text-[15px] transition-colors ${
                    active ? "font-semibold text-united-green" : "text-united-dark hover:text-united-green"
                  }`}
                >
                  {t(l.labelKey)}
                  {active && <span aria-hidden className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-united-green" />}
                </Link>
              );
            })}
          </nav>
        )}
      </header>

      {/* Below 1024px the grouped navigation lives in a drawer (a native modal dialog). */}
      {grouped && <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} links={links} activeHref={activeHref} home={home} />}

      <Modal
        open={confirmingLogout}
        onClose={() => { if (!loggingOut) setConfirmingLogout(false); }}
        title={t("confirm.logout")}
        description={t("confirm.logout-body-tab")}
        size="sm"
        initialFocus="[data-cancel]"
        footer={
          <>
            <button type="button" data-cancel className="btn-secondary btn-sm" disabled={loggingOut} onClick={() => setConfirmingLogout(false)}>
              {t("ui.cancel")}
            </button>
            <button type="button" className="btn-danger-solid btn-sm" disabled={loggingOut} onClick={logout}>
              {loggingOut ? t("ui.saving") : t("confirm.logout")}
            </button>
          </>
        }
      />
    </>
  );
}

function NavDrawer({ open, onClose, links, activeHref, home }: { open: boolean; onClose: () => void; links: NavLink[]; activeHref?: string; home: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useLocale();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      aria-label={t("ui.nav.main")}
      className="m-0 h-[100dvh] max-h-none w-[min(19rem,88vw)] p-0 fixed inset-y-0 start-0 end-auto border-e border-united-border bg-white text-united-dark"
    >
      <div className="flex h-14 items-center justify-between border-b border-united-border px-4">
        <Brand href={home} />
        <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl hover:bg-united-subtle" aria-label={t("ui.close")}>
          <X size={20} aria-hidden />
        </button>
      </div>
      <nav className="overflow-y-auto px-2 py-4">
        <GroupedLinks links={links} activeHref={activeHref} onNavigate={onClose} />
      </nav>
    </dialog>
  );
}
