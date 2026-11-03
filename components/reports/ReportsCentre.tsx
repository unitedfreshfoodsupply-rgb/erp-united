"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Boxes, ExternalLink, Landmark, ShoppingCart, Truck } from "lucide-react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorState, LoadingState } from "@/components/States";

type Entry = { key: string; category: "financial" | "sales" | "purchasing" | "inventory" | "operations"; title: { ar: string; en: string }; description: { ar: string; en: string }; href: string | null };
const ORDER = ["financial", "sales", "purchasing", "inventory", "operations"] as const;
const ICON = { financial: Landmark, sales: BarChart3, purchasing: ShoppingCart, inventory: Boxes, operations: Truck } as const;

/**
 * Every report in one place, by business area (maturity 2026-11). Reports that have
 * their own screen (statements, aging, reconciliation) open there; the rest open in the
 * shared report viewer. The list is what this user may open — nothing else is shown.
 */
export function ReportsCentre() {
  const { t, locale } = useLocale();
  const [find, setFind] = useState("");
  const q = useQuery({ queryKey: ["reports", "catalogue"], queryFn: () => apiFetch<{ reports: Entry[] }>("/api/reports") });
  const groups = useMemo(() => {
    const needle = find.trim().toLowerCase();
    const list = (q.data?.reports ?? []).filter((r) => !needle || `${r.title.ar} ${r.title.en} ${r.description.ar} ${r.description.en}`.toLowerCase().includes(needle));
    return ORDER.map((c) => ({ c, items: list.filter((r) => r.category === c) })).filter((g) => g.items.length);
  }, [q.data, find]);
  return (
    <div className="page-container">
      <PageHeader title={t("reports.title")} description={t("reports.description")} />
      <label className="flex max-w-md flex-col gap-1">
        <span className="field-label">{t("reports.find")}</span>
        <input type="search" className="field-sm" value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("reports.find-hint")} />
      </label>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map(({ c, items }) => {
          const Icon = ICON[c];
          return (
            <section key={c} className="card p-0" aria-labelledby={`rc-${c}`}>
              <header className="flex items-center gap-2 border-b border-united-border px-5 py-3">
                <Icon size={18} className="text-united-green" aria-hidden />
                <h2 id={`rc-${c}`} className="section-title">{t(`reports.cat.${c}`)}</h2>
                <span className="ms-auto text-xs text-united-muted">{items.length}</span>
              </header>
              <ul className="divide-y divide-united-border">
                {items.map((r) => (
                  <li key={r.key}>
                    <Link href={r.href ?? `/reports/${r.key}`} className="flex min-h-[56px] items-start gap-3 px-5 py-3 hover:bg-united-subtle focus-visible:bg-united-subtle">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-united-dark">{r.title[locale === "en" ? "en" : "ar"]}</span>
                        <span className="block text-xs text-united-muted">{r.description[locale === "en" ? "en" : "ar"]}</span>
                      </span>
                      {r.href && <ExternalLink size={14} className="mt-1 shrink-0 text-united-muted" aria-label={t("reports.opens-screen")} />}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
