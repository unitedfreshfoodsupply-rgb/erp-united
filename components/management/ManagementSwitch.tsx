"use client";

import Link from "next/link";
import { useLocale } from "@/lib/locale";

/** Overview · Management reports · Cash flow — one switch for the three finance views. */
export function ManagementSwitch({ current }: { current: "overview" | "finance" | "cash-flow" }) {
  const { t } = useLocale();
  const items = [
    ["overview", "/management/overview", t("mgmt.overview.tab")],
    ["finance", "/management", t("mgmt.finance.tab.finance")],
    ["cash-flow", "/management/cash-flow", t("mgmt.finance.tab.cashflow")],
  ] as const;
  return (
    <nav aria-label={t("management.title.finance")} className="inline-flex max-w-full overflow-x-auto rounded-lg border border-united-border bg-united-subtle p-0.5 no-scrollbar">
      {items.map(([k, href, label]) => (
        <Link key={k} href={href} aria-current={current === k ? "page" : undefined} className={`inline-flex min-h-[36px] shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm coarse:min-h-[44px] ${current === k ? "bg-white font-semibold text-united-dark shadow-card" : "font-medium text-united-muted hover:text-united-dark"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
