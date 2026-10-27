"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { LoadingState, ErrorState, EmptyState } from "@/components/States";
import { usePermissions } from "@/lib/use-session";
import { ROLE_LABEL } from "@/lib/types";
import { GROUP_LABEL, SECURITY_ACTION_LABEL, type AdminOverview, type AdminUser } from "@/lib/admin-client-types";
import { UsersPanel } from "@/components/admin/UsersPanel";
import { SettingsPanel } from "@/components/admin/SettingsPanel";
import { MasterDataPanel } from "@/components/admin/MasterDataPanel";
import { IntegrationsPanel } from "@/components/admin/IntegrationsPanel";
import { StatTile } from "@/components/stock/StatTile";
import { DataImportPanel } from "@/components/admin/DataImportPanel";
import { useLocale } from "@/lib/locale";
import { intlLocale } from "@/lib/format";

type Tab = "users" | "matrix" | "overview" | "settings" | "master" | "integrations" | "import";

export function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("users");
  const { can } = usePermissions();
  const { t } = useLocale();
  const importAllowed = {
    customers: can("sales.customers.manage"),
    customer_groups: can("sales.customers.manage"),
    customer_legal_entities: can("sales.customers.manage"),
    suppliers: can("purchasing.suppliers.manage"),
    products: can("stock.manage_products"),
    product_settings: can("stock.manage_products"),
    product_packaging: can("stock.manage_products"),
    opening_stock: can("accounting.manage"),
    opening_balances: can("accounting.manage"),
    sales_prices: can("sales.pricing.manage"),
    supplier_prices: can("purchasing.prices.manage"),
  };
  const canImport = Object.values(importAllowed).some(Boolean);

  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => apiFetch<{ users: AdminUser[] }>("/api/admin/users"),
    refetchInterval: 30_000,
  });
  const overviewQ = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => apiFetch<AdminOverview>("/api/admin/overview"),
    refetchInterval: 30_000,
  });

  return (
    <div className="page-container">
      <h1 className="page-title">{t("admin.title.system")}</h1>

      {overviewQ.data && (
        <section className="kpi-grid">
          <StatTile label={t("admin.stats.all-users")} value={String(overviewQ.data.overview.totalUsers)} />
          <StatTile label={t("admin.stats.active")} value={String(overviewQ.data.overview.activeUsers)} tone="good" />
          <StatTile
            label={t("admin.stats.suspended")}
            value={String(overviewQ.data.overview.disabledUsers)}
            tone={overviewQ.data.overview.disabledUsers > 0 ? "warn" : "muted"}
          />
          <StatTile
            label={t("admin.stats.super-admins")}
            value={String(overviewQ.data.overview.activeSuperAdmins)}
            tone={overviewQ.data.overview.activeSuperAdmins <= 1 ? "warn" : "good"}
            sub={overviewQ.data.overview.activeSuperAdmins <= 1 ? t("admin.stats.last-admin-protected") : undefined}
          />
        </section>
      )}

      {overviewQ.data && !overviewQ.data.matrix.catalogueInSync && (
        <div className="card p-4 border-r-4 border-united-warn">
          <p className="font-extrabold text-united-warn">{t("admin.warning.permissions-mismatch-title")}</p>
          <p className="text-sm font-bold text-united-muted mt-1" dangerouslySetInnerHTML={{ __html: t("admin.warning.permissions-mismatch-body") }} />
        </div>
      )}

      {/* Scrolls sideways inside itself on a phone, so the page never does. */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4">
        <TabButton active={tab === "users"} onClick={() => setTab("users")} label={t("admin.tab.users")} />
        <TabButton active={tab === "matrix"} onClick={() => setTab("matrix")} label={t("admin.tab.roles-permissions")} />
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} label={t("admin.tab.access-overview")} />
        {can("core.masterdata.view") && (
          <TabButton active={tab === "master"} onClick={() => setTab("master")} label={t("admin.tab.company-stores")} />
        )}
        {can("integrations.manage") && (
          <TabButton active={tab === "integrations"} onClick={() => setTab("integrations")} label={t("admin.tab.integrations")} />
        )}
        {can("settings.manage") && (
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")} label={t("admin.tab.operational-settings")} />
        )}
        {canImport && <TabButton active={tab === "import"} onClick={() => setTab("import")} label={t("admin.tab.initial-data-load")} />}
      </div>

      {tab === "settings" && can("settings.manage") && <SettingsPanel />}
      {tab === "integrations" && can("integrations.manage") && <IntegrationsPanel />}
      {tab === "master" && can("core.masterdata.view") && <MasterDataPanel canManage={can("core.masterdata.manage")} />}
      {tab === "import" && canImport && <DataImportPanel allowed={importAllowed} />}

      {tab === "users" && (
        <>
          {usersQ.isLoading && <LoadingState />}
          {usersQ.isError && <ErrorState message={errorMessage(usersQ.error)} onRetry={() => usersQ.refetch()} />}
          {usersQ.data && <UsersPanel users={usersQ.data.users} />}
        </>
      )}

      {tab === "matrix" && (
        <>
          {overviewQ.isLoading && <LoadingState />}
          {overviewQ.isError && <ErrorState message={errorMessage(overviewQ.error)} onRetry={() => overviewQ.refetch()} />}
          {overviewQ.data && <PermissionMatrix data={overviewQ.data} />}
        </>
      )}

      {tab === "overview" && (
        <>
          {overviewQ.isLoading && <LoadingState />}
          {overviewQ.isError && <ErrorState message={errorMessage(overviewQ.error)} onRetry={() => overviewQ.refetch()} />}
          {overviewQ.data && <SystemOverview data={overviewQ.data} canSeeAudit={can("users.view")} />}
        </>
      )}
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`tap-target flex-1 shrink-0 whitespace-nowrap px-4 rounded-xl font-extrabold text-sm transition ${
        active ? "bg-united-green text-white" : "bg-united-dark/5 text-united-dark"
      }`}
    >
      {label}
    </button>
  );
}

function PermissionMatrix({ data }: { data: AdminOverview }) {
  const { permissions, roles } = data.matrix;
  const groups = [...new Set(permissions.map((p) => p.group))];
  const { t } = useLocale();

  return (
    <section className="card p-4">
      <h2 className="text-lg font-extrabold text-united-dark mb-1">{t("admin.matrix.title")}</h2>
      <p className="text-xs font-bold text-united-muted mb-3" dangerouslySetInnerHTML={{ __html: t("admin.matrix.description") }} />
      {/* Wide tables scroll inside their own container so the page never scrolls sideways. */}
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-sm border-collapse min-w-[640px]">
          <thead>
            <tr>
              <th className="text-right p-2 font-extrabold text-united-muted sticky right-0 bg-white">{t("admin.matrix.col.permission")}</th>
              {roles.map((r) => (
                <th key={r.role} className="p-2 font-extrabold text-united-dark whitespace-nowrap">
                  <div>{ROLE_LABEL[r.role]}</div>
                  <div className="text-[10px] font-bold text-united-muted">
                    {r.activeUsers} {t("admin.matrix.col.active")}{r.disabledUsers > 0 ? ` · ${r.disabledUsers} ${t("admin.matrix.col.suspended")}` : ""}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <>
                <tr key={group}>
                  <td colSpan={roles.length + 1} className="p-2 pt-4 font-extrabold text-united-green text-xs">
                    {GROUP_LABEL[group]}
                  </td>
                </tr>
                {permissions
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <tr key={p.key} className="border-t border-united-border">
                      <td className="p-2 sticky right-0 bg-white">
                        <div className="font-bold text-united-dark">{p.label}</div>
                        <code dir="ltr" className="text-[10px] text-united-muted">
                          {p.key}
                        </code>
                      </td>
                      {roles.map((r) => (
                        <td key={r.role} className="p-2 text-center">
                          {r.permissions.includes(p.key) ? (
                            <span className="text-united-green font-extrabold" title={t("admin.matrix.allowed")}>
                              ✓
                            </span>
                          ) : (
                            <span className="text-united-dark/20" title={t("admin.matrix.denied")}>
                              —
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SystemOverview({ data, canSeeAudit }: { data: AdminOverview; canSeeAudit: boolean }) {
  const { t, locale } = useLocale();

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-4">
        <h2 className="text-lg font-extrabold text-united-dark mb-3">{t("admin.exceptions.title")}</h2>
        {data.overview.overrides.length === 0 ? (
          <EmptyState icon="⚖️" title={t("admin.exceptions.empty")} />
        ) : (
          <ul className="flex flex-col divide-y divide-united-border">
            {data.overview.overrides.map((o) => (
              <li key={`${o.userId}-${o.permissionKey}`} className="py-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-extrabold text-united-dark">
                    {o.userName} <span className="text-xs font-bold text-united-muted">({ROLE_LABEL[o.role]})</span>
                  </span>
                  <span
                    className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full ${
                      o.effect === "grant"
                        ? "bg-united-green/10 text-united-green"
                        : "bg-united-danger/10 text-united-danger"
                    }`}
                  >
                    {o.effect === "grant" ? t("admin.exceptions.granted") : t("admin.exceptions.revoked")}
                  </span>
                </div>
                <div className="text-xs font-bold text-united-muted mt-0.5">
                  {o.permissionLabel} · <code dir="ltr">{o.permissionKey}</code> · {t("admin.by-label")} {o.grantedBy}
                </div>
                {o.reason && <p className="text-xs font-bold text-united-dark/70 mt-0.5">{t("admin.reason")}: {o.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canSeeAudit && (
        <section className="card p-4">
          <h2 className="text-lg font-extrabold text-united-dark mb-3">{t("admin.audit.title")}</h2>
          {data.audit.length === 0 ? (
            <EmptyState icon="🛡️" title={t("admin.audit.empty")} />
          ) : (
            <ul className="flex flex-col divide-y divide-united-border">
              {data.audit.map((l) => (
                <li key={l.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-bold text-united-dark">
                      {SECURITY_ACTION_LABEL[l.action] ?? l.action}
                    </span>
                    <span dir="ltr" className="text-[11px] font-bold text-united-muted">
                      {new Date(l.timestamp).toLocaleString(intlLocale(locale), { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  </div>
                  <div className="text-xs font-bold text-united-muted">
                    {t("admin.by-label")} {l.userName}
                    {l.fieldChanged && <> · {l.fieldChanged}</>}
                    {l.oldValue && l.newValue && (
                      <>
                        {" "}
                        · <span dir="ltr">{l.oldValue} → {l.newValue}</span>
                      </>
                    )}
                    {!l.oldValue && l.newValue && (
                      <>
                        {" "}
                        · <span dir="ltr">{l.newValue}</span>
                      </>
                    )}
                  </div>
                  {l.reason && <p className="text-xs font-bold text-united-dark/70">{t("admin.reason")}: {l.reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
