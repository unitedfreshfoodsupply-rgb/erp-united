"use client";

import Link from "next/link";
import { useLocale } from "@/lib/locale";
import { PERMISSION_DEFS } from "@/lib/permissions";
import { ROLE_LABEL, ROLE_DESC, ROLE_LABEL_EN, ROLE_DESC_EN, type Role } from "@/lib/types";
import { GROUP_LABEL } from "@/lib/admin-client-types";

export type ProfileUser = {
  id: string;
  name: string;
  username: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  permissions: string[];
};

/**
 * The read-only profile, rendered from the user the server already resolved (see
 * app/profile/page.tsx). It used to fetch /api/auth/me itself and render nothing until
 * then — a blank page while loading, an empty server render, and a redirect to the login
 * screen on any failure, even a dropped connection.
 */
export function ProfileView({ user }: { user: ProfileUser }) {
  const { t, dir, isRTL } = useLocale();
  const permissions = [...user.permissions]
    .map((key) => PERMISSION_DEFS.find((d) => d.key === key))
    .filter((d): d is (typeof PERMISSION_DEFS)[number] => !!d)
    .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label, "ar") : a.group.localeCompare(b.group)));

  const permCount = permissions.length;
  const byGroup: Record<string, (typeof PERMISSION_DEFS)[number][]> = {};
  for (const p of permissions) {
    if (!byGroup[p.group]) byGroup[p.group] = [];
    byGroup[p.group].push(p);
  }

  const groupOrder = Object.keys(GROUP_LABEL);
  const orderedGroups = groupOrder.filter((g) => byGroup[g]);

  const displayRoleLabel = isRTL
    ? (ROLE_LABEL[user.role] ?? "")
    : (ROLE_LABEL_EN[user.role] ?? "");
  const displayRoleDesc = isRTL
    ? (ROLE_DESC[user.role] ?? "")
    : (ROLE_DESC_EN[user.role] ?? "");

  return (
    <main className="min-h-screen flex flex-col items-center page-container" style={{ direction: dir }}>
      <div className="w-full max-w-2xl flex flex-col gap-4">
        <header className="card p-4 flex items-center justify-between">
          <h1 className="text-2xl font-extrabold text-united-dark">{t("ui.profile.title")}</h1>
          <Link href="/" className="btn-secondary text-sm font-bold">{t("ui.profile.back-home")}</Link>
        </header>

        <section className="card p-4 bg-united-warning/10 border-united-warning/30 flex flex-col gap-2" role="note">
          <p className="font-extrabold text-united-dark">
            🔒 {t("ui.profile.readonly-notice-title")}
          </p>
          <p className="text-sm font-bold text-united-muted">
            {t("ui.profile.readonly-notice-body")}
          </p>
        </section>

        <section className="card p-4 flex flex-col gap-3">
          <h2 className="font-extrabold text-united-dark">{t("ui.profile.account-data")}</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm font-bold">
            <div className="flex flex-col gap-1"><dt className="text-xs text-united-muted">{t("ui.profile.name")}</dt><dd className="text-united-dark">{user.name}</dd></div>
            <div className="flex flex-col gap-1"><dt className="text-xs text-united-muted">{t("ui.profile.username")}</dt><dd className="text-united-dark"><span dir={isRTL ? "rtl" : "ltr"}>{user.username}</span></dd></div>
            <div className="flex flex-col gap-1"><dt className="text-xs text-united-muted">{t("role.admin")}</dt><dd className="text-united-dark">{displayRoleLabel}</dd></div>
            <div className="flex flex-col gap-1"><dt className="text-xs text-united-muted">{t("ui.profile.status")}</dt><dd className={user.active ? "text-united-green" : "text-united-danger"}>{user.active ? t("ui.profile.active") : t("ui.profile.inactive")}</dd></div>
            <div className="flex flex-col gap-1 sm:col-span-2"><dt className="text-xs text-united-muted">{t("ui.profile.role-desc")}</dt><dd className="text-united-dark">{displayRoleDesc}</dd></div>
          </dl>
          {user.mustChangePassword && (
            <p className="text-sm font-extrabold text-united-warning bg-united-warning/10 rounded-lg p-2">
              {t("ui.profile.must-change-pw")}
            </p>
          )}
        </section>

        <section className="card p-4 flex flex-col gap-3">
          <h2 className="font-extrabold text-united-dark">{t("ui.profile.permissions", { n: String(permCount) })}</h2>
          {orderedGroups.length === 0 && <p className="text-sm font-bold text-united-muted">{t("ui.profile.no-perms")}</p>}
          {orderedGroups.map((group) => (
            <div key={group} className="flex flex-col gap-1">
              <h3 className="text-xs font-extrabold text-united-muted">{(GROUP_LABEL as Record<string, string>)[group]}</h3>
              <ul className="flex flex-col gap-1">
                {(byGroup[group] ?? []).map((p) => (
                  <li key={p.key} className="text-sm font-bold text-united-dark flex items-center gap-2">
                    <span className="text-united-green">✓</span>
                    <span title={p.key}>{p.label}</span>
                    <span className="text-xs font-normal text-united-muted">— {p.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
