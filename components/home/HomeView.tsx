"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Banknote, CheckCircle2, ClipboardCheck, FileText, PackageCheck, PackagePlus, Receipt, ShieldCheck, ShoppingCart,
  Truck, UserPlus, Wallet, type LucideIcon,
} from "lucide-react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { usePermissions } from "@/lib/use-session";
import { ErrorState } from "@/components/States";
import { SkeletonLine } from "@/components/Skeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { OPEN_STATUSES as ORDER_STATUS_ORDER } from "@/lib/orderPresentation";
import type { HomeSummary } from "@/lib/home/summary";
import type { Permission } from "@/lib/permissions";

const ACTION_ICON: Record<string, LucideIcon> = {
  approvals: ShieldCheck, "orders-review": ClipboardCheck, "orders-to-invoice": FileText,
  "draft-invoices": Receipt, "draft-bills": FileText, "eta-pending": FileText,
};

// `href` may depend on what the person can open: the supervisor board needs reports.view,
// so a salesperson creates the order from the sales screen instead.
const SHORTCUTS: { key: string; href: string | ((can: (p: Permission) => boolean) => string); icon: LucideIcon; permission: Permission | Permission[] }[] = [
  { key: "new-order", href: (can) => (can("reports.view") ? "/supervisor" : "/sales?tab=order"), icon: ShoppingCart, permission: "orders.create" },
  { key: "receive", href: "/stock", icon: PackagePlus, permission: "stock.receive" },
  { key: "collect", href: "/accounting", icon: Banknote, permission: "accounting.receipts.manage" },
  { key: "pay", href: "/accounting", icon: Wallet, permission: "accounting.payments.manage" },
  { key: "new-customer", href: "/sales?tab=new", icon: UserPlus, permission: "sales.customers.manage" },
  { key: "purchase", href: "/purchasing", icon: PackageCheck, permission: "purchasing.orders.manage" },
  { key: "dispatch", href: "/operations", icon: Truck, permission: "operations.trips.manage" },
];

const n = (v: string | number | null | undefined) => Number(v ?? 0);

/**
 * One figure with its definition (UX: every KPI says what it is). The definition is the
 * accessible description and the hover title, so it is never decoration only.
 */
function Metric({ label, value, def, big, sub }: { label: string; value: string; def?: string; big?: boolean; sub?: { text: string; tone?: "danger" | "warn" } }) {
  if (big) {
    return (
      <div className="flex flex-col gap-0.5" title={def}>
        <span className="text-xs font-medium text-united-muted">{label}{def && <span className="sr-only"> — {def}</span>}</span>
        <span className="num text-3xl font-bold text-united-dark" dir="ltr" style={{ textAlign: "start" }}>{value}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 py-2" title={def}>
      <dt className="text-united-muted">{label}{def && <span className="sr-only"> — {def}</span>}</dt>
      <dd className="flex flex-col items-end">
        <span className="num font-semibold text-united-dark" dir="ltr">{value}</span>
        {sub && <span className={`text-xs ${sub.tone === "danger" ? "font-semibold text-united-danger" : sub.tone === "warn" ? "font-semibold text-united-warn" : "text-united-muted"}`}>{sub.text}</span>}
      </dd>
    </div>
  );
}

/** A count that asks for attention when it is not zero, and links to where it is handled. */
function AttentionRow({ href, label, def, count, neutral }: { href: string; label: string; def?: string; count: number; neutral?: boolean }) {
  const hot = !neutral && count > 0;
  return (
    <li title={def}>
      <Link href={href} className="flex min-h-[44px] items-center justify-between gap-3 py-2 hover:text-united-green">
        <span className="text-united-muted">{label}{def && <span className="sr-only"> — {def}</span>}</span>
        <span className={`num rounded-full px-2.5 py-0.5 text-sm font-semibold ${hot ? "bg-united-warn/10 text-united-warn" : "bg-united-subtle text-united-dark"}`} dir="ltr">{count.toLocaleString("en-US")}</span>
      </Link>
    </li>
  );
}

export function HomeView({ name }: { name: string }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ["home"], queryFn: () => apiFetch<HomeSummary>("/api/home"), refetchOnWindowFocus: true, staleTime: 30_000 });
  const tag = locale === "en" ? "en-GB" : "ar-EG-u-nu-latn";
  const money = (v: number) => `${new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(v)} ${t("mgmt.overview.egp")}`;
  const num = (v: number) => new Intl.NumberFormat(tag).format(v);
  const dateLine = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  const shortcuts = SHORTCUTS.filter((s) => (Array.isArray(s.permission) ? s.permission.some((p) => can(p)) : can(s.permission)));
  const first = name.trim().split(/\s+/)[0] ?? name;

  return (
    <div className="page-container">
      <PageHeader title={t("home.greeting", { name: first })} description={dateLine} />

      {q.isLoading && (
        <div aria-busy="true" className="grid gap-4 lg:grid-cols-3">
          <SkeletonLine className="h-64 rounded-xl lg:col-span-2" />
          <SkeletonLine className="h-64 rounded-xl" />
        </div>
      )}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}

      {q.data && (
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">
          {/* What is waiting for this person — the reason to open the app. */}
          <section className="card flex min-w-0 flex-col p-0 lg:col-span-2" aria-labelledby="home-actions">
            <header className="flex items-center justify-between border-b border-united-border px-5 py-4">
              <h2 id="home-actions" className="section-title">{t("home.actions.title")}</h2>
              {q.data.actions.length > 0 && <span className="rounded-full bg-united-warn/10 px-2.5 py-0.5 text-xs font-semibold text-united-warn">{num(q.data.actions.reduce((s, a) => s + a.count, 0))}</span>}
            </header>
            {q.data.actions.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-12 text-center">
                <CheckCircle2 size={28} className="text-united-green" aria-hidden />
                <p className="font-semibold text-united-dark">{t("home.actions.clear")}</p>
                <p className="text-sm text-united-muted">{t("home.actions.clear-hint")}</p>
              </div>
            ) : (
              <ul className="divide-y divide-united-border">
                {q.data.actions.map((a) => {
                  const Icon = ACTION_ICON[a.key] ?? FileText;
                  return (
                    <li key={a.key}>
                      <Link href={a.href} className="group flex min-h-[56px] items-center gap-3 px-5 py-3 hover:bg-united-subtle focus-visible:bg-united-subtle">
                        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-united-warn/10 text-united-warn"><Icon size={18} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-united-dark">{t(`home.action.${a.key}`, { count: num(a.count) })}</span>
                          <span className="block text-xs text-united-muted">{t(`home.action.${a.key}.hint`)}</span>
                        </span>
                        <span className="num rounded-full bg-united-subtle px-2.5 py-0.5 text-sm font-semibold text-united-dark" dir="ltr">{num(a.count)}</span>
                        <ArrowLeft size={16} aria-hidden className="shrink-0 text-united-muted ltr:rotate-180 group-hover:text-united-dark" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Quick ways in, limited to what this person may do. */}
          <section className="card flex min-w-0 flex-col gap-3 p-5" aria-labelledby="home-shortcuts">
            <h2 id="home-shortcuts" className="section-title">{t("home.shortcuts.title")}</h2>
            {shortcuts.length === 0 ? <p className="text-sm text-united-muted">{t("home.shortcuts.none")}</p> : (
              <ul className="grid grid-cols-2 gap-2">
                {shortcuts.map((s) => (
                  <li key={s.key}>
                    <Link href={typeof s.href === "function" ? s.href(can) : s.href} className="flex min-h-[72px] flex-col justify-between gap-2 rounded-xl border border-united-border p-3 text-sm font-medium text-united-dark hover:border-united-border-strong hover:bg-united-subtle">
                      <s.icon size={18} className="text-united-green" aria-hidden />
                      {t(`home.shortcut.${s.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Today's flow: where every open order stands, left to right as the work moves. */}
          {q.data.operations && (
            <section className="card min-w-0 p-5 lg:col-span-3" aria-labelledby="home-flow">
              <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 id="home-flow" className="section-title">{t("home.flow.title")}</h2>
                <span className="flex items-center gap-3 text-xs text-united-muted">
                  {q.data.operations.late > 0 && <span className="pill-danger"><span className="pill-dot" />{t("home.flow.late", { count: num(q.data.operations.late) })}</span>}
                  {/* The board needs reports.view; order viewers without it (accountant, sales) get today's production. */}
                  <Link href={can("reports.view") ? "/supervisor" : "/production"} className="font-semibold text-united-green hover:underline">{t("home.open")}</Link>
                </span>
              </header>
              <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[...ORDER_STATUS_ORDER.map((st) => ({ key: st, label: t(`orders.status.${st}`), count: q.data!.operations!.byStatus[st] ?? 0, done: false })),
                  { key: "dispatched-today", label: t("home.flow.dispatched"), count: q.data.operations.dispatchedToday, done: true }].map((stage, i) => (
                  <li key={stage.key} className={`relative flex min-h-[76px] flex-col justify-between rounded-xl border p-3 ${stage.done ? "border-united-green/30 bg-united-green/5" : stage.count ? "border-united-border-strong bg-white" : "border-united-border bg-united-subtle/60"}`}>
                    <span className="text-xs font-medium text-united-muted">{stage.label}</span>
                    <span className={`num text-2xl font-bold ${stage.count ? (stage.done ? "text-united-green" : "text-united-dark") : "text-united-muted/70"}`} dir="ltr">{num(stage.count)}</span>
                    {i < ORDER_STATUS_ORDER.length && <span aria-hidden className="absolute -end-1.5 top-1/2 hidden -translate-y-1/2 text-united-border-strong sm:block rtl:rotate-180">›</span>}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {(q.data.sales || q.data.cash) && (
            <section className="card flex min-w-0 flex-col gap-3 p-5" aria-labelledby="home-money">
              <header className="flex items-center justify-between">
                <h2 id="home-money" className="section-title">{t("home.money.title")}</h2>
                <Link href="/management/overview" className="text-xs font-semibold text-united-green hover:underline">{t("home.open")}</Link>
              </header>
              {q.data.sales && <>
                <Metric big label={t("home.sales.title")} def={t("home.def.sales")} value={money(n(q.data.sales.monthToDate))} />
                <p className="-mt-2 text-xs text-united-muted">
                  {t("home.sales.mtd", { count: num(q.data.sales.invoicesIssued) })}
                  {n(q.data.sales.previousToDate) > 0 && (() => {
                    const ch = ((n(q.data!.sales!.monthToDate) - n(q.data!.sales!.previousToDate)) / n(q.data!.sales!.previousToDate)) * 100;
                    return <> · <span className={`font-semibold ${ch >= 0 ? "text-united-green" : "text-united-danger"}`} dir="ltr">{`${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}</span> {t("home.sales.vs-last-month")}</>;
                  })()}
                </p>
              </>}
              <dl className="flex flex-col divide-y divide-united-border text-sm">
                {q.data.sales && <Metric label={t("mgmt.overview.collected")} def={t("home.def.collected")} value={money(n(q.data.sales.collected))} />}
                {q.data.receivables && <Metric label={t("mgmt.overview.receivables")} def={t("home.def.receivables")} value={money(n(q.data.receivables.total))} sub={n(q.data.receivables.overdue) > 0 ? { text: t("home.sales.overdue") + " " + money(n(q.data.receivables.overdue)), tone: "danger" } : undefined} />}
                {q.data.payables && <Metric label={t("home.money.payables")} def={t("home.def.payables")} value={money(n(q.data.payables.total))} sub={n(q.data.payables.overdue) > 0 ? { text: t("home.money.payables-overdue") + " " + money(n(q.data.payables.overdue)), tone: "warn" } : undefined} />}
                {q.data.cash && <Metric label={t("home.money.cash-bank")} def={t("home.def.cash")} value={money(n(q.data.cash.total))} sub={{ text: `${t("home.money.cash")} ${money(n(q.data.cash.cash))} · ${t("home.money.bank")} ${money(n(q.data.cash.bank))}` }} />}
              </dl>
            </section>
          )}

          {q.data.stock && (() => {
            const g = q.data.stock!.gradedToday;
            const parts = [{ k: "good", v: n(g.good), cls: "bg-[var(--viz-good)]" }, { k: "gradeB", v: n(g.gradeB), cls: "bg-[var(--viz-gradeb)]" }, { k: "waste", v: n(g.waste), cls: "bg-[var(--viz-waste)]" }];
            const total = parts.reduce((s0, p) => s0 + p.v, 0);
            const wastePct = total > 0 ? (n(g.waste) / total) * 100 : 0;
            return (
              <section className="viz card flex min-w-0 flex-col gap-3 p-5 lg:col-span-2" aria-labelledby="home-produce">
                <header className="flex items-center justify-between">
                  <h2 id="home-produce" className="section-title">{t("home.produce.title")}</h2>
                  <Link href="/stock" className="text-xs font-semibold text-united-green hover:underline">{t("home.open")}</Link>
                </header>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-2">
                    <Metric big label={t("home.stock.received-today", { count: num(q.data.stock!.receiptsToday) })} def={t("home.def.received")} value={`${num(n(q.data.stock!.receivedTodayKg))} ${t("mgmt.overview.kg")}`} />
                    {total > 0 ? (
                      <>
                        <div className="flex h-3 w-full overflow-hidden rounded-full bg-united-subtle" role="img" aria-label={parts.map((p) => `${t(`home.produce.${p.k}`)} ${p.v}`).join("، ")}>
                          {parts.map((p) => p.v > 0 && <span key={p.k} className={p.cls} style={{ width: `${(p.v / total) * 100}%` }} />)}
                        </div>
                        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          {parts.map((p) => (
                            <li key={p.k} className="flex items-center gap-1.5 text-united-muted"><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${p.cls}`} />{t(`home.produce.${p.k}`)} <span className="num font-semibold text-united-dark" dir="ltr">{num(p.v)}</span></li>
                          ))}
                        </ul>
                        <p className={`text-xs font-semibold ${wastePct > 5 ? "text-united-warn" : "text-united-muted"}`} title={t("home.def.waste")}>{t("home.produce.waste-rate", { pct: wastePct.toFixed(1) })}</p>
                      </>
                    ) : <p className="text-sm text-united-muted">{t("home.produce.none")}</p>}
                  </div>
                  <ul className="flex flex-col divide-y divide-united-border text-sm">
                    <AttentionRow href="/stock/inventory" label={t("home.stock.low")} def={t("home.def.low")} count={q.data.stock!.lowStock} />
                    <AttentionRow href="/stock/inventory?tab=exceptions" label={t("home.stock.exceptions")} def={t("home.def.exceptions")} count={q.data.stock!.openExceptions} />
                    {q.data.purchaseRequests && <AttentionRow href="/purchasing/requests" label={t("home.stock.prs")} def={t("home.def.prs")} count={q.data.purchaseRequests.open} />}
                    <AttentionRow href="/stock/setup" label={t("home.stock.products")} count={q.data.stock!.activeProducts} neutral />
                  </ul>
                </div>
              </section>
            );
          })()}
        </div>
      )}
    </div>
  );
}
