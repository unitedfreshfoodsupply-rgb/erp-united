"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import type { OrderDTO, OperationalIntelligenceDTO } from "@/lib/client-types";
import { OrderCard } from "@/components/OrderCard";
import { CreateOrderForm } from "./CreateOrderForm";
import { PipelineFunnel } from "./PipelineFunnel";
import { OperationalHealthBanner } from "./OperationalHealthBanner";
import { NeedsAttentionQueue } from "./NeedsAttentionQueue";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import {
  needsSupervisorAction,
  isWaitingTooLong,
  isStalledInProgress,
} from "@/lib/orderPresentation";
import type { OrderStatus } from "@/lib/types";
import { useNewOrderAlert, useAttentionAlert, useStalledAlert } from "@/lib/liveAlerts";
import { useOperationalSettings } from "@/lib/use-operational-settings";
import { Search } from "lucide-react";
import { useLocale } from "@/lib/locale";
import { SkeletonLine } from "@/components/Skeleton";

type QuickFilter = "all" | "attention" | "waiting" | "stalled" | "cancelled";

const QUICK_FILTER_KEYS: { key: QuickFilter; dictKey: string }[] = [
  { key: "all", dictKey: "supervisor.quick.all" },
  { key: "attention", dictKey: "supervisor.quick.attention" },
  { key: "waiting", dictKey: "supervisor.quick.waiting" },
  { key: "stalled", dictKey: "supervisor.quick.stalled" },
  { key: "cancelled", dictKey: "supervisor.quick.cancelled" },
];

const SORT_KEYS = [
  { key: "priority", dictKey: "supervisor.sort.priority" },
  { key: "delivery", dictKey: "supervisor.sort.delivery" },
  { key: "newest", dictKey: "supervisor.sort.newest" },
] as const;

function matchesSearch(o: OrderDTO, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    o.customerName.toLowerCase().includes(needle) ||
    o.orderNumber.toLowerCase().includes(needle) ||
    (o.externalId ?? "").toLowerCase().includes(needle)
  );
}

export function SupervisorBoard() {
  const { t } = useLocale();
  const ops = useOperationalSettings();
  const sortDict: Record<string, string> = {};
  SORT_KEYS.forEach((sk) => { sortDict[sk.key] = t(sk.dictKey); });
  const [statusFilter, setStatusFilter] = useState<OrderStatus | null>(null);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<(typeof SORT_KEYS)[number]["key"]>("priority");
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["orders", "supervisor"],
    queryFn: () =>
      apiFetch<{ orders: OrderDTO[]; intelligence: OperationalIntelligenceDTO }>(
        "/api/supervisor/intelligence"
      ),
    refetchInterval: 4000,
  });

  useNewOrderAlert(data?.orders);
  useAttentionAlert(data?.orders);
  useStalledAlert(data?.orders, ops.stalledMinutes);

  const all = useMemo(() => data?.orders ?? [], [data?.orders]);
  const needsAttention = all.filter(needsSupervisorAction);
  const waiting = all.filter((o) => isWaitingTooLong(o.status, o.createdAt, ops.waitingToStartMinutes));
  const stalled = all.filter((o) => isStalledInProgress(o.status, o.updatedAt, ops.stalledMinutes));
  const activeCount = all.filter((o) =>
    ["new", "preparing", "ready_for_loading", "loading"].includes(o.status)
  ).length;

  const orders = useMemo(() => {
    let list = all;
    if (statusFilter) list = list.filter((o) => o.status === statusFilter);
    if (quickFilter === "attention") list = needsAttention;
    else if (quickFilter === "waiting") list = waiting;
    else if (quickFilter === "stalled") list = stalled;
    else if (quickFilter === "cancelled") list = list.filter((o) => o.status === "cancelled");
    else if (quickFilter === "all" && !statusFilter) list = list.filter((o) => o.status !== "cancelled");
    list = list.filter((o) => matchesSearch(o, search));

    const rank = (o: OrderDTO) =>
      needsSupervisorAction(o)
        ? 0
        : isWaitingTooLong(o.status, o.createdAt, ops.waitingToStartMinutes)
        ? 1
        : isStalledInProgress(o.status, o.updatedAt, ops.stalledMinutes)
        ? 2
        : 3;
    return [...list].sort((a, b) => {
      if (sort === "priority") {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        return a.deliveryTime && b.deliveryTime ? a.deliveryTime.localeCompare(b.deliveryTime) : 0;
      }
      if (sort === "delivery") {
        return `${a.deliveryDate}${a.deliveryTime ?? ""}`.localeCompare(
          `${b.deliveryDate}${b.deliveryTime ?? ""}`
        );
      }
      return b.createdAt.localeCompare(a.createdAt); // newest
    });
  }, [all, statusFilter, quickFilter, search, sort, needsAttention, waiting, stalled, ops]);

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="flex flex-col gap-0.5">
          <h1 className="page-title">{t("supervisor.page-title")}</h1>
          <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
        </div>
        <div className="flex gap-2 shrink-0">
          <Link href="/supervisor/audit" className="btn-ghost btn-sm">
            {t("supervisor.btn.audit-log")}
          </Link>
          <button onClick={() => setShowCreate((s) => !s)} className="btn-primary btn-sm">
            {showCreate ? t("supervisor.btn.cancel") : t("supervisor.btn.manual-order")}
          </button>
        </div>
      </div>

      {/* Same footprint as the funnel and health banner below, so the toolbar and the
          list do not jump down when the first poll lands. */}
      {isLoading && (
        <div aria-hidden>
          <div className="mt-4 grid grid-cols-4 sm:grid-cols-7 gap-2">
            {Array.from({ length: 7 }).map((_, i) => <SkeletonLine key={i} className="h-[84px] lg:h-[69px] rounded-2xl" />)}
          </div>
          <div className="mt-5 flex flex-col gap-3">
            <SkeletonLine className="h-[150px] sm:h-[98px] lg:h-[78px] rounded-2xl" />
            <SkeletonLine className="h-40 rounded-2xl" />
          </div>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="mt-4">
          <PipelineFunnel
            orders={all}
            activeStatus={statusFilter}
            onSelect={(s) => {
              setStatusFilter(s);
              setQuickFilter("all");
            }}
          />
        </div>
      )}

      {showCreate && (
        <div className="mt-4">
          <CreateOrderForm onDone={() => setShowCreate(false)} />
        </div>
      )}

      {!isLoading && !isError && data?.intelligence && (
        <div className="mt-5 flex flex-col gap-3">
          <OperationalHealthBanner health={data.intelligence.health} />
          <NeedsAttentionQueue items={data.intelligence.needsAttention} />
        </div>
      )}

      <div className="toolbar">
        <div className="relative flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("supervisor.search-placeholder")}
            aria-label={t("supervisor.search-placeholder")}
            type="search"
            className="field field-sm ps-9"
          />
          <Search size={16} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-united-muted" />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          aria-label={t("supervisor.sort-label")}
          className="field field-sm sm:w-44"
        >
          <option value="">{t("supervisor.sort-label")}</option>
          {SORT_KEYS.map((s) => (
            <option key={s.key} value={s.key}>
              {sortDict[s.key]}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-bar">
        {QUICK_FILTER_KEYS.map((fk) => {
          const count = fk.key === "attention" ? needsAttention.length : fk.key === "stalled" ? stalled.length : 0;
          const isActive = quickFilter === fk.key && !statusFilter;
          return (
          <button
            key={fk.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => {
              setQuickFilter(fk.key);
              setStatusFilter(null);
            }}
            className={isActive ? "filter-pill-active" : "filter-pill-inactive"}
          >
            {t(fk.dictKey)}
            {count > 0 && (
              <span className={`ms-1.5 rounded-full px-1.5 text-xs font-semibold ${fk.key === "attention" ? "bg-united-danger text-white" : isActive ? "bg-white text-united-dark" : "bg-[#FDF3E3] text-united-warn"}`}>{count}</span>
            )}
          </button>
        );
        })}
        <span className="ms-auto whitespace-nowrap px-3 py-2 text-sm text-united-muted">
          {activeCount} {t("supervisor.active-orders")}
        </span>
      </div>

      <div className="mt-4">
        {isLoading && <LoadingState />}
        {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
        {!isLoading && !isError && orders.length === 0 && (
          <EmptyState
            icon="📭"
            title={
              search
                ? t("supervisor.empty-search")
                : quickFilter === "attention"
                ? t("supervisor.empty-attention")
                : quickFilter === "waiting"
                ? t("supervisor.empty-waiting")
                : quickFilter === "stalled"
                ? t("supervisor.empty-stalled")
                : t("supervisor.empty-filter")
            }
          />
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          {orders.map((o) => (
            <OrderCard key={o.id} order={o} />
          ))}
        </div>
      </div>
    </div>
  );
}
