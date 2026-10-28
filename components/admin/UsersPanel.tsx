"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { usePermissions, useSession } from "@/lib/use-session";
import { ROLES, ROLE_LABEL, ROLE_LABEL_EN, type Role } from "@/lib/types";
import { LoadingState, EmptyState } from "@/components/States";
import { GROUP_LABEL, GROUP_LABEL_EN, type AdminUser, type UserPermissionDetail } from "@/lib/admin-client-types";
import { useLocale } from "@/lib/locale";
import { useDialogs } from "@/components/ui/Dialog";

export function UsersPanel({ users }: { users: AdminUser[] }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const activeSuperAdmins = users.filter((u) => u.role === "SUPER_ADMIN" && u.active).length;

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

      {users.map((u) => (
        <UserCard
          key={u.id}
          user={u}
          expanded={openId === u.id}
          onToggle={() => setOpenId(openId === u.id ? null : u.id)}
          isLastActiveSuperAdmin={u.role === "SUPER_ADMIN" && u.active && activeSuperAdmins <= 1}
        />
      ))}
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

  return (
    <div className={`card p-4 ${user.active ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold text-united-dark">{user.name}</span>
            <span className="text-[11px] font-extrabold bg-united-green/10 text-united-green px-2 py-0.5 rounded-full">
              {rl[user.role]}
            </span>
            {!user.active && (
              <span className="text-[11px] font-extrabold bg-united-danger/10 text-united-danger px-2 py-0.5 rounded-full">
                {t("admin.users.suspended-badge")}
              </span>
            )}
            {isLastActiveSuperAdmin && (
              <span className="text-[11px] font-extrabold bg-united-warn/10 text-united-warn px-2 py-0.5 rounded-full">
                {t("admin.users.last-admin-badge")}
              </span>
            )}
            {user.overrideCount > 0 && (
              <span className="text-[11px] font-extrabold bg-united-info/10 text-united-info px-2 py-0.5 rounded-full">
                {t("admin.users.exception-badge", { count: user.overrideCount })}
              </span>
            )}
          </div>
          <div dir="ltr" className="text-xs font-bold text-united-muted text-right">
            {user.username}
          </div>
        </div>
        <button onClick={onToggle} className="btn-secondary text-xs px-3">
          {expanded ? t("admin.users.expanded-btn-expanded") : t("admin.users.expanded-btn-collapsed")}
        </button>
      </div>

      {error && <p className="text-united-danger font-bold text-sm mt-2">{error}</p>}

      <div className="flex flex-wrap gap-2 mt-3">
        {can("users.change_role") && mayManage && !isSelf && (
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
            className="tap-target rounded-xl border-2 border-united-dark/10 px-3 font-bold text-sm bg-white disabled:opacity-40"
            aria-label={t("ui.profile.role")}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {rl[r]}
              </option>
            ))}
          </select>
        )}
        {can("users.disable") && mayManage && (
          <button
            onClick={async () => {
              if (!(await dialogs.confirm({ title: t("admin.users.revoke-sessions-confirm", { name: user.name }), tone: "danger" }))) return;
              try {
                await apiPost(`/api/admin/users/${user.id}/sessions/revoke`);
                await qc.invalidateQueries({ queryKey: ["admin"] });
                toast.show(t("admin.users.sessions-revoked-toast"), "success");
              } catch (err) {
                toast.show(err instanceof ApiClientError ? err.message : t("admin.users.patch-error-toast"), "error");
              }
            }}
            disabled={busy || !user.active}
            className="btn-secondary text-sm px-4 disabled:opacity-40"
          >
            {t("ui.logout")}
          </button>
        )}
        {can("users.disable") && mayManage && (
          <button
            onClick={async () => {
              const question = user.active
                ? t("admin.users.deactivate-confirm", { name: user.name })
                : t("admin.users.activate-confirm", { name: user.name });
              if (!(await dialogs.confirm({ title: question, tone: user.active ? "danger" : "primary" }))) return;
              patch(
                { active: !user.active },
                user.active ? t("admin.users.deactivated-toast") : t("admin.users.activated-toast")
              );
            }}
            disabled={busy || (user.active && isLastActiveSuperAdmin)}
            className={`${user.active ? "btn-danger" : "btn-primary"} text-sm px-4 disabled:opacity-40`}
          >
            {user.active ? t("admin.users.disable-action") : t("admin.users.enable-action")}
          </button>
        )}
        {can("users.edit") && mayManage && !editing && (
          <button onClick={() => setEditing(true)} className="btn-secondary text-sm px-4">
            {t("admin.users.edit-action")}
          </button>
        )}
      </div>

      {isLastActiveSuperAdmin && (
        <p className="text-[11px] font-bold text-united-warn mt-2">
          {t("admin.users.last-admin-warning")}
        </p>
      )}

      {editing && (
        <div className="flex flex-col gap-2 mt-3">
          <input value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder={t("admin.users.edit-name-placeholder")} />
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field"
            placeholder={t("admin.users.new-password-placeholder")}
          />
          {password && (
            <label className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" className="w-5 h-5" checked={forceChange} onChange={(e) => setForceChange(e.target.checked)} />
              {t("admin.users.force-change-hint")}
            </label>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => patch(password ? { name, password, must_change_password: forceChange } : { name }, t("admin.users.save-changed-toast"))}
              disabled={busy}
              className="btn-primary flex-1 text-sm"
            >
              {t("admin.users.edit-save-action")}
            </button>
            <button onClick={() => setEditing(false)} className="btn-secondary flex-1 text-sm">
              {t("admin.users.back-action")}
            </button>
          </div>
        </div>
      )}

      {expanded && <EffectivePermissions userId={user.id} isSelf={isSelf} locale={locale} />}
    </div>
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
        <span>{overrides.length ? t("admin.users.exceptions-summary-prefix") + " " + overrides.map((o) => (o.override === "grant" ? "+" : "\u2212") + o.label).join(locale === "en" ? ", " : "\u066c ") : t("admin.users.effective.no-overrides")}</span>
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
                      {p.label}
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
                    <div className="text-xs text-united-muted">{p.description}</div>
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
                              ? t("admin.users.reset-to-role-confirm", { label: p.label })
                              : next === "grant"
                              ? t("admin.users.grant-override-confirm", { label: p.label })
                              : t("admin.users.revoke-override-confirm", { label: p.label });
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
