"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import type { AuditLogDTO } from "@/lib/client-types";
import { EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { buildTimeline, timeLabel, SOURCE_LABEL, SOURCE_LABEL_EN, type TimelineLocale } from "@/lib/auditLabels";
import { ROLE_LABEL, ROLE_LABEL_EN, isRole } from "@/lib/types";
import { CardSkeleton } from "@/components/Skeleton";
import { useLocale } from "@/lib/locale";

type DecisionFilter = "all" | "approvals" | "overrides" | "cancel_reopen" | "edits";

const DECISION_FILTER_KEYS: { key: DecisionFilter; dictKey: string; actions?: string[] }[] = [
  { key: "all", dictKey: "audit.filter.all" },
  { key: "approvals", dictKey: "audit.filter.approvals", actions: ["shortage_approved"] },
  { key: "overrides", dictKey: "audit.filter.overrides", actions: ["status_override"] },
  { key: "cancel_reopen", dictKey: "audit.filter.cancel_reopen", actions: ["order_cancelled", "order_reopened"] },
  { key: "edits", dictKey: "audit.filter.edits", actions: ["order_edited", "required_quantity_edited"] },
];

const AUDIT_ENTITIES = ["sales_invoice", "credit_note", "supplier_bill", "debit_note", "journal_entry", "customer_receipt", "supplier_payment", "order", "purchase_order", "stock_intake", "inventory_document", "approval_request", "employee", "expense", "user", "settings"];

export function AuditLogView() {
  const { t, locale } = useLocale();
  const [search, setSearch] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [entityFilter, setEntityFilter] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Build query string for server-side filtering
  const qs = new URLSearchParams();
  if (search.trim()) qs.set("q", search.trim());
  if (entityFilter !== "all") qs.set("entity", entityFilter);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const queryStr = qs.toString() ? "?" + qs.toString() : "";
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["audit", queryStr || "all"],
    queryFn: () => apiFetch<{ logs: AuditLogDTO[] }>("/api/audit" + queryStr),
    refetchInterval: 5000,
  });

  const activeFilter = DECISION_FILTER_KEYS.find((f) => f.key === decisionFilter)!;
  const needle = search.trim().toLowerCase();
  const logs = (data?.logs ?? [])
    .filter((l) => !activeFilter.actions || activeFilter.actions.includes(l.action))
    .filter(
      (l) =>
        !needle ||
        l.userName.toLowerCase().includes(needle) ||
        l.order?.customerName.toLowerCase().includes(needle) ||
        l.order?.orderNumber.toLowerCase().includes(needle) ||
        describeOne(l, locale).headline.toLowerCase().includes(needle)
    );

  return (
    <div className="p-4 max-w-2xl mx-auto pb-10">
      <Link href="/supervisor" className="inline-flex items-center gap-1 text-united-muted font-bold mb-3">
        <span>→</span>{t("audit.back-supervisor")}
      </Link>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold text-united-dark">{t("audit.page-title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>
      <p className="text-united-muted text-sm mb-4">{t("audit.subtitle")}</p>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("audit.search-placeholder")}
        className="field mb-3"
      />

      <div className="flex gap-2 overflow-x-auto no-scrollbar mb-4 pb-1">
        {DECISION_FILTER_KEYS.map((f) => (
          <button
            key={f.key}
            onClick={() => setDecisionFilter(f.key)}
            className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition ${
              decisionFilter === f.key
                ? "bg-united-dark text-white"
                : "bg-white text-united-dark border border-united-border"
            }`}
          >
            {t(f.dictKey)}
          </button>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap items-end mb-3">
        <select
          value={entityFilter}
          onChange={(e) => setEntityFilter(e.target.value)}
          className="field text-sm"
        >
          <option value="all">{t("audit.entity-label")}</option>
          {AUDIT_ENTITIES.map((entity) => <option key={entity} value={entity}>{t(`audit.entity.${entity}`)}</option>)}
        </select>

        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder={t("audit.from-date-placeholder")}
          className="field text-sm"
          style={{ maxWidth: 140 }}
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={t("audit.to-date-placeholder")}
          className="field text-sm"
          style={{ maxWidth: 140 }}
        />
      </div>

      {isLoading && (
        <div className="flex flex-col gap-2">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </div>
      )}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && logs.length === 0 && (
        <EmptyState
          icon="🗒️"
          title={search || decisionFilter !== "all" ? t("audit.empty-search") : t("audit.empty-none")}
        />
      )}

      <div className="flex flex-col gap-2">
        {logs.map((l) => {
          const { icon, headline, detail } = describeOne(l, locale);
          return (
            <div key={l.id} className="card p-4">
              {l.order && (
                <Link
                  href={`/orders/${l.orderId}`}
                  className="inline-flex items-center gap-1 text-xs font-bold text-united-green bg-united-green/10 px-2 py-1 rounded-full mb-2"
                >
                  {l.order.orderNumber} · {l.order.customerName}
                </Link>
              )}
              <div className="flex items-center justify-between mb-1 text-sm">
                <span className="font-bold text-united-dark">
                  {l.userName} <span className="text-united-muted font-normal">· {isRole(l.role) ? (locale === "en" ? ROLE_LABEL_EN : ROLE_LABEL)[l.role] : l.role}</span>
                </span>
                <span className="text-united-muted">{timeLabel(l.timestamp, locale)}</span>
              </div>
              <p className="font-bold text-united-dark flex items-center gap-1.5">
                <span>{icon}</span> {headline}
              </p>
              {detail && <p className="text-sm font-bold text-united-dark/70">{detail}</p>}
              {l.reason && <p className="text-sm text-united-muted">{t("audit.reason-prefix")} {l.reason}</p>}
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs font-bold text-united-muted bg-united-dark/5 px-2 py-0.5 rounded-full">
                  {(locale === "en" ? SOURCE_LABEL_EN : SOURCE_LABEL)[l.source] ?? l.source}
                </span>
                {l.orderId && (
                  <Link href={`/orders/${l.orderId}`} className="text-xs font-bold text-united-green">
                    {t("audit.view-order-link")}
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Same operational wording as the order timeline, for one standalone row. */
function describeOne(l: AuditLogDTO, locale: TimelineLocale) {
  const [event] = buildTimeline([l], locale);
  return event ?? { icon: "•", headline: l.action, detail: undefined };
}
