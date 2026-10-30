"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { usePermissions, useSession } from "@/lib/use-session";
import { ROLES, ROLE_LABEL, ROLE_LABEL_EN, type Role } from "@/lib/types";
import { LoadingState, EmptyState } from "@/components/States";
import { GROUP_LABEL, GROUP_LABEL_EN, type AdminUser, type UserPermissionDetail } from "@/lib/admin-client-types";
import { permissionText } from "@/lib/permissions";
import { useLocale } from "@/lib/locale";
import { useDialogs } from "@/components/ui/Dialog";
import { Avatar } from "@/components/ui/Avatar";
import { Menu } from "@/components/ui/Menu";

export function UsersPanel({ users }: { users: AdminUser[] }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const activeSuperAdmins = users.filter((u) => u.role === "SUPER_ADMIN" && u.active).length;
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? users.filter((u) => u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle)) : users;

  return (
    <div className="flex flex-col gap-3">
      {can("users.create") && (
        creating ? (
          <CreateUserForm onDone={() => setCreating(false)} />
        ) : (
          <button onClick={() => setCreating(true)} className="btn-primary self-start text-sm">
            {t("admin.users.new-user-btn")}
          </button>
        )
      )}

      {users.length === 0 && <EmptyState icon="👥" title={t("admin.users.empty")} />}

      {users.length > 0 && (
        <section className="card overflow-visible" aria-label={t("admin.users.list-label")}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-united-border px-4 py-3">
            <p className="text-sm text-united-muted">{t("admin.users.count", { count: shown.length, total: users.length })}</p>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} className="field w-full sm:w-64" placeholder={t("admin.users.search")} aria-label={t("admin.users.search")} />
          </div>
          {shown.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-united-muted">{t("admin.users.no-match")}</p>
          ) : (
            <ul>
              {shown.map((u) => (
                <UserCard
                  key={u.id}
                  user={u}
                  expanded={openId === u.id}
                  onToggle={() => setOpenId(openId === u.id ? null : u.id)}
                  isLastActiveSuperAdmin={u.role === "SUPER_ADMIN" && u.active && activeSuperAdmins <= 1}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = usePermissions();
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [role, setRole] = useState<Role>("PREPARER");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only a super admin may mint another one; the server enforces this too.
  const assignableRoles = ROLES.filter((r) => r !== "SUPER_ADMIN" || can("settings.manage"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await apiPost("/api/admin/users", { name, username, password, role, must_change_password: mustChange });
      await qc.invalidateQueries({ queryKey: ["admin"] });
      toast.show(t("admin.users.created-toast", { username }), "success");
      onDone();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("admin.users.patch-error-toast");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-4 flex flex-col gap-3">
      <h2 className="font-extrabold text-united-dark">{t("admin.users.form-title")}</h2>
      {error && <p className="text-united-danger font-bold text-sm">{error}</p>}
      <input placeholder={t("admin.users.name-label")} value={name} onChange={(e) => setName(e.target.value)} className="field" />
      <input
        placeholder={t("admin.users.username-en-label")}
        dir="ltr"
        autoComplete="off"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="field"
      />
      <input
        placeholder={t("admin.users.password-label")}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="field"
      />
      <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="field font-bold">
        {assignableRoles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-sm font-bold">
        <input type="checkbox" className="w-5 h-5" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
        {t("admin.users.must-change-pw-hint")}
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn-primary flex-1 text-sm">
          {t("admin.users.save-action")}
        </button>
        <button type="button" onClick={onDone} className="btn-secondary flex-1 text-sm">
          {t("admin.users.back-action")}
        </button>
      </div>
    </form>
  );
}

function UserCard({
  user,
  expanded,
  onToggle,
  isLastActiveSuperAdmin,
}: {
  user: AdminUser;
  expanded: boolean;
  onToggle: () => void;
  isLastActiveSuperAdmin: boolean;
}) {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [password, setPassword] = useState("");
  const [forceChange, setForceChange] = useState(true);
  const { data: me } = useSession();
  const isSelf = me?.user?.id === user.id;
  // A super admin account is managed only by a super admin (the server enforces it).
  const mayManage = user.role !== "SUPER_ADMIN" || me?.user?.role === "SUPER_ADMIN";

  // Locale-aware role label lookup
  const rl = locale === "en" ? ROLE_LABEL_EN : ROLE_LABEL;

  async function patch(body: Record<string, unknown>, successMsg: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/admin/users/${user.id}`, { ...body, expected_version: user.version });
      await qc.invalidateQueries({ queryKey: ["admin"] });
      toast.show(successMsg, "success");
      setEditing(false);
      setPassword("");
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("admin.users.patch-error-toast");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  const canEditDetails = can("users.edit") && mayManage;
  const canChangeRole = can("users.change_role") && mayManage && !isSelf;
  const pill = "rounded-full px-2 py-0.5 text-[11px] font-semibold";

  return (
    <li className={`border-b border-united-border last:border-0 ${user.active ? "" : "bg-united-subtle/50"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <Avatar name={user.name} seed={user.id} />
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className={`font-semibold ${user.active ? "text-united-dark" : "text-united-muted"}`}>{user.name}</span>
            {isSelf && <span className="text-xs text-united-muted">{t("admin.users.you")}</span>}
          </div>
          <div className="text-xs text-united-muted"><span dir="ltr">@{user.username}</span></div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 md:w-72">
          <span className={`${pill} bg-united-green/10 text-united-green`}>{rl[user.role]}</span>
          {!user.active && <span className={`${pill} bg-united-danger/10 text-united-danger`}>{t("admin.users.suspended-badge")}</span>}
          {isLastActiveSuperAdmin && <span className={`${pill} bg-united-warn/10 text-united-warn`}>{t("admin.users.last-admin-badge")}</span>}
          {user.overrideCount > 0 && <span className={`${pill} bg-united-info/10 text-united-info`}>{t("admin.users.exception-badge", { count: user.overrideCount })}</span>}
        </div>
        <div className="ms-auto flex items-center gap-1">
          {(canEditDetails || canChangeRole) && (
            <button type="button" onClick={() => setEditing((v) => !v)} aria-expanded={editing} className="btn-secondary btn-sm coarse:min-h-[44px]">
              {t("admin.users.edit-action")}
            </button>
          )}
          <button type="button" onClick={onToggle} aria-expanded={expanded} className="btn-ghost btn-sm coarse:min-h-[44px]">
            {expanded ? t("admin.users.expanded-btn-expanded") : t("admin.users.expanded-btn-collapsed")}
          </button>
          <Menu
            label={t("admin.users.more-actions", { name: user.name })}
            items={[
              ...(can("users.disable") && mayManage
                ? [
                    {
                      key: "sessions",
                      label: t("admin.users.revoke-sessions-action"),
                      disabled: busy || !user.active,
                      onSelect: async () => {
                        if (!(await dialogs.confirm({ title: t("admin.users.revoke-sessions-confirm", { name: user.name }), tone: "danger" }))) return;
                        try {
                          await apiPost(`/api/admin/users/${user.id}/sessions/revoke`);
                          await qc.invalidateQueries({ queryKey: ["admin"] });
                          toast.show(t("admin.users.sessions-revoked-toast"), "success");
                        } catch (err) {
                          toast.show(err instanceof ApiClientError ? err.message : t("admin.users.patch-error-toast"), "error");
                        }
                      },
                    },
                    {
                      key: "active",
                      label: user.active ? t("admin.users.disable-action") : t("admin.users.enable-action"),
                      tone: user.active ? ("danger" as const) : undefined,
                      disabled: busy || (user.active && isLastActiveSuperAdmin),
                      hint: user.active && isLastActiveSuperAdmin ? t("admin.users.last-admin-warning") : undefined,
                      onSelect: async () => {
                        const question = user.active
                          ? t("admin.users.deactivate-confirm", { name: user.name })
                          : t("admin.users.activate-confirm", { name: user.name });
                        if (!(await dialogs.confirm({ title: question, tone: user.active ? "danger" : "primary" }))) return;
                        patch({ active: !user.active }, user.active ? t("admin.users.deactivated-toast") : t("admin.users.activated-toast"));
                      },
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>

      {error && <p role="alert" className="px-4 pb-2 text-sm font-semibold text-united-danger">{error}</p>}
      {isLastActiveSuperAdmin && <p className="px-4 pb-3 text-xs text-united-warn">{t("admin.users.last-admin-warning")}</p>}

      {editing && (
        <div className="mx-4 mb-4 grid gap-3 rounded-xl border border-united-border bg-united-bg p-4 sm:grid-cols-2">
          {canChangeRole && (
            <label className="flex flex-col gap-1">
              <span className="field-label">{t("ui.profile.role")}</span>
              <select
                value={user.role}
                disabled={busy || isLastActiveSuperAdmin}
                onChange={async (e) => {
                  const next = e.target.value as Role;
                  if (next === user.role) return;
                  // The select stays on the current role (it is controlled) until this is confirmed.
                  if (!(await dialogs.confirm({ title: t("admin.users.role-confirm", { name: user.name, fromRole: rl[user.role], toRole: rl[next] }) }))) return;
                  patch({ role: next }, t("admin.users.role-changed-toast"));
                }}
                className="field"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{rl[r]}</option>
                ))}
              </select>
            </label>
          )}
          {canEditDetails && (
            <>
              <label className="flex flex-col gap-1">
                <span className="field-label">{t("admin.users.field-name")}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} className="field" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">{t("admin.users.field-new-password")}</span>
                <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="field" placeholder={t("admin.users.new-password-placeholder")} />
              </label>
              {password && (
                <label className="flex items-center gap-2 self-end text-sm font-medium">
                  <input type="checkbox" className="h-5 w-5" checked={forceChange} onChange={(e) => setForceChange(e.target.checked)} />
                  {t("admin.users.force-change-hint")}
                </label>
              )}
              <div className="flex gap-2 sm:col-span-2">
                <button
                  type="button"
                  onClick={() => patch(password ? { name, password, must_change_password: forceChange } : { name }, t("admin.users.save-changed-toast"))}
                  disabled={busy || !name.trim()}
                  className="btn-primary btn-sm"
                >
                  {t("admin.users.edit-save-action")}
                </button>
                <button type="button" onClick={() => { setEditing(false); setName(user.name); setPassword(""); }} className="btn-secondary btn-sm">
                  {t("admin.users.back-action")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {expanded && <div className="px-4 pb-4"><EffectivePermissions userId={user.id} isSelf={isSelf} locale={locale} /></div>}
    </li>
  );
}

/** The whole catalogue for one user: what the role gives, what an override changes,
 * and the resulting effective answer — the same resolution the server performs. */
function EffectivePermissions({ userId, isSelf, locale }: { userId: string; isSelf: boolean; locale: "ar" | "en" }) {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = usePermissions();
  const { t } = useLocale();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Locale-aware lookups
  const rl = locale === "en" ? ROLE_LABEL_EN : ROLE_LABEL;
  const gl = locale === "en" ? GROUP_LABEL_EN : GROUP_LABEL;

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "user-permissions", userId],
    queryFn: () => apiFetch<UserPermissionDetail>(`/api/admin/users/${userId}/permissions`),
  });

  async function setOverride(permission: string, effect: "grant" | "revoke" | null) {
    setBusyKey(permission);
    try {
      await apiPost(`/api/admin/users/${userId}/permissions`, { permission, effect });
      await qc.invalidateQueries({ queryKey: ["admin"] });
      toast.show(t("admin.users.perms-updated"), "success");
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("admin.users.patch-error-toast"), "error");
    } finally {
      setBusyKey(null);
    }
  }

  if (isLoading) return <LoadingState label={t("admin.users.permissions.loading")} />;
  if (!data) return null;

  const groups = [...new Set(data.permissions.map((p) => p.group))];
  // Your own permissions are someone else's decision (the server refuses it too).
  const canManage = can("settings.manage") && !data.absoluteRole && !isSelf;
  const effectiveCount = data.permissions.filter((p) => p.effective).length;
  const overrides = data.permissions.filter((p) => p.override);

  return (
    <div className="mt-4 pt-4 border-t border-united-border">
      <div className="rounded-xl bg-united-dark/[0.03] p-3 mb-3 text-sm font-bold flex flex-wrap gap-x-4 gap-y-1">
        <span>{t("admin.users.effective.role-label")}<span className="text-united-green">{rl[data.user.role]}</span></span>
        <span>{t("admin.users.effective.summary-prefix")}{effectiveCount} {locale === "en" ? "of" : "من"} {data.permissions.length}</span>
        <span>{overrides.length ? t("admin.users.exceptions-summary-prefix") + " " + overrides.map((o) => (o.override === "grant" ? "+" : "\u2212") + permissionText(o.key, locale).label).join(locale === "en" ? ", " : "\u066c ") : t("admin.users.effective.no-overrides")}</span>
      </div>
      {data.absoluteRole && (
        <p className="text-xs font-bold text-united-muted mb-3">
          {t("admin.users.admin-full-perms-notice")}
        </p>
      )}
      {groups.map((group) => (
        <div key={group} className="mb-3">
          <h4 className="text-xs font-extrabold text-united-green mb-1">{gl[group as keyof typeof gl]}</h4>
          <ul className="flex flex-col gap-1">
            {data.permissions
              .filter((p) => p.group === group)
              .map((p) => (
                <li key={p.key} className="flex items-center justify-between gap-2 py-1">
                  <div className="min-w-0" title={p.key}>
                    <div className="text-sm font-bold text-united-dark">
                      {permissionText(p.key, locale).label}
                      {p.override && (
                        <span
                          className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded ms-2 ${
                            p.override === "grant"
                              ? "bg-united-green/10 text-united-green"
                              : "bg-united-danger/10 text-united-danger"
                          }`}
                        >
                          {p.override === "grant" ? t("admin.users.override-granted") : t("admin.users.override-revoked")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-united-muted">{permissionText(p.key, locale).description}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-xs font-extrabold ${p.effective ? "text-united-green" : "text-united-danger/60"}`}
                      title={p.override ? t("admin.users.manage-toggle-title") : t("admin.users.from-role-title")}
                    >
                      {p.effective ? "✓" : "✗"} {p.override ? t("admin.users.override-tag-granted") : p.fromRole ? t("admin.users.override-tag-role") : ""}
                    </span>
                    {canManage && (
                      <select
                        value={p.override ?? "role"}
                        disabled={busyKey === p.key}
                        onChange={async (e) => {
                          const next = e.target.value === "role" ? null : (e.target.value as "grant" | "revoke");
                          const question =
                            next === null
                              ? t("admin.users.reset-to-role-confirm", { label: permissionText(p.key, locale).label })
                              : next === "grant"
                              ? t("admin.users.grant-override-confirm", { label: permissionText(p.key, locale).label })
                              : t("admin.users.revoke-override-confirm", { label: permissionText(p.key, locale).label });
                          if (!(await dialogs.confirm({ title: question, tone: next === "revoke" ? "danger" : "primary" }))) return;
                          setOverride(p.key, next);
                        }}
                        className="rounded-lg border-2 border-united-dark/10 px-2 py-1 text-xs font-bold bg-white disabled:opacity-40"
                        aria-label={t("admin.users.override-select-aria", { key: p.key })}
                      >
                        <option value="role">{t("admin.users.select-role-default")} ({p.fromRole ? t("admin.users.select-permitted") : t("admin.users.select-denied")})</option>
                        <option value="grant">{t("admin.users.select-grant")}</option>
                        <option value="revoke">{t("admin.users.select-revoke")}</option>
                      </select>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
