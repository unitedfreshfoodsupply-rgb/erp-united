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

const SHORTCUTS: { key: string; href: string; icon: LucideIcon; permission: Permission | Permission[] }[] = [
  { key: "new-order", href: "/supervisor", icon: ShoppingCart, permission: "orders.create" },
  { key: "receive", href: "/stock", icon: PackagePlus, permission: "stock.receive" },
  { key: "collect", href: "/accounting", icon: Banknote, permission: "accounting.receipts.manage" },
  { key: "pay", href: "/accounting", icon: Wallet, permission: "accounting.payments.manage" },
  { key: "new-customer", href: "/sales", icon: UserPlus, permission: "sales.customers.manage" },
  { key: "purchase", href: "/purchasing", icon: PackageCheck, permission: "purchasing.orders.manage" },
  { key: "dispatch", href: "/operations", icon: Truck, permission: "operations.trips.manage" },
];

const n = (v: string | number | null | undefined) => Number(v ?? 0);

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
                    <Link href={s.href} className="flex min-h-[72px] flex-col justify-between gap-2 rounded-xl border border-united-border p-3 text-sm font-medium text-united-dark hover:border-united-border-strong hover:bg-united-subtle">
                      <s.icon size={18} className="text-united-green" aria-hidden />
                      {t(`home.shortcut.${s.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {q.data.operations && (
            <section className="card flex min-w-0 flex-col gap-3 p-5" aria-labelledby="home-ops">
              <header className="flex items-center justify-between">
                <h2 id="home-ops" className="section-title">{t("home.ops.title")}</h2>
                <Link href="/supervisor" className="text-xs font-semibold text-united-green hover:underline">{t("home.open")}</Link>
              </header>
              <p className="text-3xl font-bold text-united-dark" dir="ltr">{num(q.data.operations.open)}</p>
              <p className="-mt-2 text-xs text-united-muted">{t("home.ops.open")}{q.data.operations.late > 0 && <> · <span className="font-semibold text-united-danger">{t("home.ops.late", { count: num(q.data.operations.late) })}</span></>}</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {ORDER_STATUS_ORDER.filter((s) => q.data!.operations!.byStatus[s]).map((s) => (
                  <li key={s} className="flex items-center justify-between gap-2"><span className="text-united-muted">{t(`orders.status.${s}`)}</span><span className="num font-semibold" dir="ltr">{num(q.data!.operations!.byStatus[s])}</span></li>
                ))}
              </ul>
            </section>
          )}

          {q.data.sales && (
            <section className="card flex min-w-0 flex-col gap-3 p-5" aria-labelledby="home-sales">
              <header className="flex items-center justify-between">
                <h2 id="home-sales" className="section-title">{t("home.sales.title")}</h2>
                <Link href="/management/overview" className="text-xs font-semibold text-united-green hover:underline">{t("home.open")}</Link>
              </header>
              <p className="text-3xl font-bold text-united-dark" dir="ltr">{money(n(q.data.sales.monthToDate))}</p>
              <p className="-mt-2 text-xs text-united-muted">
                {t("home.sales.mtd", { count: num(q.data.sales.invoicesIssued) })}
                {n(q.data.sales.previousToDate) > 0 && (() => {
                  const ch = ((n(q.data!.sales!.monthToDate) - n(q.data!.sales!.previousToDate)) / n(q.data!.sales!.previousToDate)) * 100;
                  return <> · <span className={`font-semibold ${ch >= 0 ? "text-united-green" : "text-united-danger"}`} dir="ltr">{`${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}</span> {t("home.sales.vs-last-month")}</>;
                })()}
              </p>
              <dl className="flex flex-col gap-1.5 text-sm">
                <div className="flex justify-between gap-2"><dt className="text-united-muted">{t("mgmt.overview.collected")}</dt><dd className="num font-semibold" dir="ltr">{money(n(q.data.sales.collected))}</dd></div>
                {q.data.receivables && <>
                  <div className="flex justify-between gap-2"><dt className="text-united-muted">{t("mgmt.overview.receivables")}</dt><dd className="num font-semibold" dir="ltr">{money(n(q.data.receivables.total))}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-united-muted">{t("home.sales.overdue")}</dt><dd className={`num font-semibold ${n(q.data.receivables.overdue) > 0 ? "text-united-warn" : ""}`} dir="ltr">{money(n(q.data.receivables.overdue))}</dd></div>
                </>}
              </dl>
            </section>
          )}

          {q.data.stock && (
            <section className="card flex min-w-0 flex-col gap-3 p-5" aria-labelledby="home-stock">
              <header className="flex items-center justify-between">
                <h2 id="home-stock" className="section-title">{t("home.stock.title")}</h2>
                <Link href="/stock" className="text-xs font-semibold text-united-green hover:underline">{t("home.open")}</Link>
              </header>
              <p className="text-3xl font-bold text-united-dark" dir="ltr">{num(n(q.data.stock.receivedTodayKg))} <span className="text-base font-medium text-united-muted">{t("mgmt.overview.kg")}</span></p>
              <p className="-mt-2 text-xs text-united-muted">{t("home.stock.received-today", { count: num(q.data.stock.receiptsToday) })}</p>
              <dl className="flex flex-col gap-1.5 text-sm">
                <div className="flex justify-between gap-2"><dt className="text-united-muted">{t("home.stock.products")}</dt><dd className="num font-semibold" dir="ltr">{num(q.data.stock.activeProducts)}</dd></div>
              </dl>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
