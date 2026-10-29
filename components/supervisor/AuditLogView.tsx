"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import type { AuditLogDTO } from "@/lib/client-types";
import { EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { systemText } from "@/lib/locale/system-text";
import { settingLabel, settingValueText } from "@/lib/core/settings-registry";
import { buildTimeline, timeLabel, SOURCE_LABEL, SOURCE_LABEL_EN, type TimelineLocale } from "@/lib/auditLabels";
import { ROLE_LABEL, ROLE_LABEL_EN, isRole } from "@/lib/types";
import { CardSkeleton } from "@/components/Skeleton";
import { useLocale } from "@/lib/locale";
import { DICTIONARY } from "@/lib/locale/dictionary";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { EventIcon } from "@/components/ui/EventIcon";

type DecisionFilter = "all" | "approvals" | "overrides" | "cancel_reopen" | "edits";

const DECISION_FILTER_KEYS: { key: DecisionFilter; dictKey: string; actions?: string[] }[] = [
  { key: "all", dictKey: "audit.filter.all" },
  { key: "approvals", dictKey: "audit.filter.approvals", actions: ["shortage_approved"] },
  { key: "overrides", dictKey: "audit.filter.overrides", actions: ["status_override"] },
  { key: "cancel_reopen", dictKey: "audit.filter.cancel_reopen", actions: ["order_cancelled", "order_reopened"] },
  { key: "edits", dictKey: "audit.filter.edits", actions: ["order_edited", "required_quantity_edited"] },
];

const AUDIT_ENTITIES = ["sales_invoice", "credit_note", "supplier_bill", "debit_note", "journal_entry", "customer_receipt", "supplier_payment", "order", "purchase_order", "stock_intake", "inventory_document", "approval_request", "employee", "department", "expense", "employee_transaction", "attendance_day", "attendance_correction", "leave_request", "employee_compensation", "pay_component", "statutory_rule_set", "payroll_run", "payroll_adjustment", "payroll_payment", "customer", "supplier", "product", "user", "settings"];
const PAGE_SIZE = 50;

export function AuditLogView() {
  const { t, locale } = useLocale();
  const [search, setSearch] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [entityFilter, setEntityFilter] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  // Server-side filtering and paging; any filter change goes back to the first page.
  const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
  if (search.trim()) qs.set("q", search.trim());
  if (entityFilter !== "all") qs.set("entity", entityFilter);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const queryStr = qs.toString() ? "?" + qs.toString() : "";
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["audit", queryStr || "all"],
    queryFn: () => apiFetch<{ logs: AuditLogDTO[]; total: number }>("/api/audit" + queryStr),
    refetchInterval: 5000,
  });

  const activeFilter = DECISION_FILTER_KEYS.find((f) => f.key === decisionFilter)!;
  // The text search runs on the server (who, action, reason, values, order, ids); the
  // decision pills narrow the page already loaded.
  const logs = (data?.logs ?? []).filter((l) => !activeFilter.actions || activeFilter.actions.includes(l.action));
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="page-narrow">
      <PageHeader
        back={{ href: "/supervisor", label: t("audit.back-supervisor") }}
        title={t("audit.page-title")}
        description={t("audit.subtitle")}
        actions={<LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />}
      />

      <input
        value={search}
        onChange={(e) => reset(setSearch)(e.target.value)}
        placeholder={t("audit.search-placeholder")}
        className="field mb-3"
      />

      <div className="flex gap-2 overflow-x-auto no-scrollbar mb-4 pb-1">
        {DECISION_FILTER_KEYS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={decisionFilter === f.key}
            onClick={() => setDecisionFilter(f.key)}
            className={decisionFilter === f.key ? "filter-pill-active" : "filter-pill-inactive"}
          >
            {t(f.dictKey)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
        <span className="field-label">{t("audit.entity-filter-label")}</span>
        <select
          value={entityFilter}
          onChange={(e) => reset(setEntityFilter)(e.target.value)}
          className="field field-sm"
        >
          <option value="all">{t("audit.entity-label")}</option>
          {AUDIT_ENTITIES.map((entity) => <option key={entity} value={entity}>{t(`audit.entity.${entity}`)}</option>)}
        </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="field-label">{t("audit.from-date-placeholder")}</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => reset(setFrom)(e.target.value)} className="field field-sm w-auto" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="field-label">{t("audit.to-date-placeholder")}</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => reset(setTo)(e.target.value)} className="field field-sm w-auto" />
        </label>
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
                  className="mb-2 inline-flex items-center gap-1 rounded-full bg-united-green/10 px-2 py-1 text-xs font-semibold text-united-green"
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
              <p className="flex items-center gap-1.5 font-medium text-united-dark">
                <EventIcon symbol={icon} className="shrink-0 text-united-muted" /> {headline}
              </p>
              {detail && <p className="text-sm text-united-dark/80">{systemText(detail, locale)}</p>}
              {l.reason && <p className="text-sm text-united-muted">{t("audit.reason-prefix")} {systemText(l.reason, locale)}</p>}
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
      {data && data.total > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />}
    </div>
  );
}

/** Same operational wording as the order timeline, for one standalone row. The timeline's
 * catch-all says "updated the order"; for a row about anything else (an employee, a journal
 * entry, a bill) say what it is and what happened to it instead. */
function describeOne(l: AuditLogDTO, locale: TimelineLocale) {
  const [event] = buildTimeline([l], locale);
  const setting = l.fieldChanged ? settingLabel(l.fieldChanged, locale) : null;
  if (setting) {
    const en = locale === "en";
    const entity = DICTIONARY["audit.entity.system_setting"];
    const verb = l.action.endsWith("_reset") ? (en ? "reset to default" : "رجع للافتراضي") : (en ? "changed" : "اتغيّر");
    return {
      icon: "•",
      headline: `${en ? entity.en : entity.ar} — ${verb}`,
      detail: `${setting}: ${settingValueText(l.fieldChanged!, l.oldValue, locale)} → ${settingValueText(l.fieldChanged!, l.newValue, locale)}`,
    };
  }
  const isOrder = !l.entityType || l.entityType === "order" || l.entityType === "order_item";
  if (event && (isOrder || event.icon !== "•")) return event;
  const en = locale === "en";
  const entity = DICTIONARY[`audit.entity.${l.entityType}` as keyof typeof DICTIONARY];
  const what = entity ? (en ? entity.en : entity.ar) : l.entityType;
  const verb = Object.entries(VERBS).sort((a, b) => b[0].length - a[0].length).find(([suffix]) => l.action.endsWith(suffix))?.[1];
  return {
    icon: "•",
    // An action without a verb here still reads in the reader's language: English gets the
    // action in words, Arabic a neutral "activity" rather than an English identifier.
    headline: `${what} — ${verb ? (en ? verb.en : verb.ar) : en ? l.action.replace(/_/g, " ") : "نشاط مسجّل"}`,
    detail: event?.detail ?? l.newValue ?? undefined,
  };
}

const VERBS: Record<string, { ar: string; en: string }> = {
  _created: { ar: "اتضاف", en: "created" },
  _updated: { ar: "اتعدّل", en: "updated" },
  _approved: { ar: "اتعتمد", en: "approved" },
  _rejected: { ar: "اترفض", en: "rejected" },
  _posted: { ar: "اترحّل", en: "posted" },
  _recorded: { ar: "اتسجل", en: "recorded" },
  _cancelled: { ar: "اتلغى", en: "cancelled" },
  _reversed: { ar: "اتعكس", en: "reversed" },
  _deleted: { ar: "اتمسح", en: "deleted" },
  _advance: { ar: "سلفة", en: "advance paid" },
  _reimbursement: { ar: "صرف مستحقات", en: "reimbursement paid" },
  _advance_return: { ar: "رد سلفة", en: "advance returned" },
  _viewed: { ar: "اتعرض", en: "viewed" },
  _changed: { ar: "اتغيّر", en: "changed" },
  _edited: { ar: "اتعدّل", en: "edited" },
  _reset: { ar: "رجع للافتراضي", en: "reset to default" },
  _calculated: { ar: "اتحسب", en: "calculated" },
  _returned: { ar: "اترجّع للتعديل", en: "returned for changes" },
  _submitted: { ar: "اتبعت للاعتماد", en: "submitted for approval" },
  _withdrawn: { ar: "اتسحب", en: "withdrawn" },
  _exported: { ar: "اتصدّر", en: "exported" },
  _applied: { ar: "اتطبّق", en: "applied" },
  _requested: { ar: "اتطلب", en: "requested" },
  _confirmed: { ar: "اتأكد", en: "confirmed" },
  _compiled: { ar: "اتجمّع", en: "compiled" },
  _reopened: { ar: "اتفتح تاني", en: "reopened" },
  _issued: { ar: "اتصدر", en: "issued" },
  _paid: { ar: "اتدفع", en: "paid" },
  _added: { ar: "اتضاف", en: "added" },
  _removed: { ar: "اتشال", en: "removed" },
  _assigned: { ar: "اتوزّع", en: "assigned" },
  _set: { ar: "اتحدد", en: "set" },
  _verified: { ar: "اتراجع واتأكد", en: "verified" },
  _retired: { ar: "اتوقف", en: "retired" },
  _discarded: { ar: "اتلغت المسودة", en: "draft discarded" },
  _allocated: { ar: "اتوزّع الرصيد", en: "allocated" },
  _adjusted: { ar: "اتسوّى", en: "adjusted" },
  _voided: { ar: "اتلغى", en: "voided" },
  _resolved: { ar: "اتحل", en: "resolved" },
  _skipped: { ar: "اتعدّى", en: "skipped" },
  _raised: { ar: "اتسجل", en: "raised" },
  _revoked: { ar: "اتلغى", en: "revoked" },
  _locked: { ar: "اتقفل", en: "locked" },
  _unlocked: { ar: "اتفتح", en: "unlocked" },
  _closed: { ar: "اتقفل", en: "closed" },
  _sent: { ar: "اتبعت", en: "sent" },
  _accepted: { ar: "اتقبل", en: "accepted" },
  _mapped: { ar: "اتربط", en: "linked" },
  _unmapped: { ar: "اتفك ربطه", en: "unlinked" },
  _saved: { ar: "اتحفظ", en: "saved" },
  _cleared: { ar: "اتمسح", en: "cleared" },
  _corrected: { ar: "اتصحّح", en: "corrected" },
  _priced: { ar: "اتسعّر", en: "priced" },
  _overridden: { ar: "اتغيّر يدويًا", en: "overridden" },
  _evaluated: { ar: "اتراجع", en: "evaluated" },
  _initialized: { ar: "اتجهّز", en: "initialized" },
  _cloned: { ar: "اتنسخ", en: "copied" },
  _redated: { ar: "اتغيّر تاريخه", en: "redated" },
  _entered: { ar: "اتدخل", en: "entered" },
  _proposed: { ar: "اتقترح", en: "proposed" },
  _recovered: { ar: "اتسترد", en: "recovered" },
  _refunded: { ar: "اترد", en: "refunded" },
  _imported: { ar: "اتستورد", en: "imported" },
  _activated: { ar: "اتفعّل", en: "activated" },
  _deactivated: { ar: "اتوقف", en: "deactivated" },
  _disabled: { ar: "اتوقف", en: "disabled" },
  _enabled: { ar: "اتفعّل", en: "enabled" },
  _repriced: { ar: "اتعاد تسعيره", en: "repriced" },
};
