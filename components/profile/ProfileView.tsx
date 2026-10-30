"use client";

import Link from "next/link";
import { Check, ChevronDown, Lock } from "lucide-react";
import { Nav } from "@/components/Nav";
import { PageHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { useLocale } from "@/lib/locale";
import { PERMISSION_DEFS, permissionText } from "@/lib/permissions";
import { ROLE_LABEL, ROLE_DESC, ROLE_LABEL_EN, ROLE_DESC_EN, type Role } from "@/lib/types";
import { GROUP_LABEL, GROUP_LABEL_EN } from "@/lib/admin-client-types";

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
  const { t, dir, isRTL, locale } = useLocale();
  const permissions = [...user.permissions]
    .map((key) => PERMISSION_DEFS.find((d) => d.key === key))
    .filter((d): d is (typeof PERMISSION_DEFS)[number] => !!d)
    .sort((a, b) => (a.group === b.group ? permissionText(a.key, locale).label.localeCompare(permissionText(b.key, locale).label, locale) : a.group.localeCompare(b.group)));

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

  const groupLabels = (locale === "en" ? GROUP_LABEL_EN : GROUP_LABEL) as Record<string, string>;
  return (
    <main className="min-h-screen" style={{ direction: dir }}>
      <Nav />
      <div className="page-narrow">
        <PageHeader
          title={t("ui.profile.title")}
          actions={<Link href="/" className="btn-secondary btn-sm">{t("ui.profile.back-home")}</Link>}
        />

        {/* Identity: who is signed in, at a glance. */}
        <section className="card flex flex-wrap items-center gap-4 p-5" aria-label={t("ui.profile.account-data")}>
          <Avatar name={user.name} seed={user.id} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold text-united-dark">{user.name}</p>
            <p className="text-sm text-united-muted"><span dir="ltr">@{user.username}</span></p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-united-green/10 px-2.5 py-0.5 text-xs font-semibold text-united-green">{displayRoleLabel}</span>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${user.active ? "bg-united-subtle text-united-dark" : "bg-united-danger/10 text-united-danger"}`}>
                {user.active ? t("ui.profile.active") : t("ui.profile.inactive")}
              </span>
            </div>
          </div>
        </section>

        <section className="card flex flex-col gap-3 p-5">
          <h2 className="section-title">{t("ui.profile.account-data")}</h2>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-0.5"><dt className="text-xs text-united-muted">{t("ui.profile.name")}</dt><dd className="font-medium text-united-dark">{user.name}</dd></div>
            <div className="flex flex-col gap-0.5"><dt className="text-xs text-united-muted">{t("ui.profile.username")}</dt><dd className="font-medium text-united-dark"><span dir="ltr">{user.username}</span></dd></div>
            <div className="flex flex-col gap-0.5"><dt className="text-xs text-united-muted">{t("role.admin")}</dt><dd className="font-medium text-united-dark">{displayRoleLabel}</dd></div>
            <div className="flex flex-col gap-0.5"><dt className="text-xs text-united-muted">{t("ui.profile.status")}</dt><dd className={`font-medium ${user.active ? "text-united-green" : "text-united-danger"}`}>{user.active ? t("ui.profile.active") : t("ui.profile.inactive")}</dd></div>
            <div className="flex flex-col gap-0.5 sm:col-span-2"><dt className="text-xs text-united-muted">{t("ui.profile.role-desc")}</dt><dd className="text-united-dark">{displayRoleDesc}</dd></div>
          </dl>
        </section>

        {/* Security: what the user can and cannot do about their own account. */}
        <section className="card flex flex-col gap-3 p-5" role="note">
          <h2 className="section-title inline-flex items-center gap-2"><Lock size={16} aria-hidden /> {t("ui.profile.security")}</h2>
          <p className="font-medium text-united-dark">{t("ui.profile.readonly-notice-title")}</p>
          <p className="text-sm text-united-muted">{t("ui.profile.readonly-notice-body")}</p>
          {user.mustChangePassword && (
            <p className="rounded-lg border border-[#F3D9AE] bg-[#FFFBF3] p-3 text-sm font-medium text-united-warn">{t("ui.profile.must-change-pw")}</p>
          )}
        </section>

        <section className="card flex flex-col gap-2 p-5">
          <h2 className="section-title">{t("ui.profile.permissions", { n: String(permCount) })}</h2>
          {orderedGroups.length === 0 && <p className="text-sm text-united-muted">{t("ui.profile.no-perms")}</p>}
          <div className="flex flex-col divide-y divide-united-border">
            {orderedGroups.map((group) => (
              <details key={group} className="group py-2">
                <summary className="flex min-h-[40px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-1 text-sm font-semibold text-united-dark hover:bg-united-subtle">
                  <span>{groupLabels[group]}</span>
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-united-muted">
                    {byGroup[group].length}
                    <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" />
                  </span>
                </summary>
                <ul className="mt-1 flex flex-col gap-2 ps-1">
                  {byGroup[group].map((p) => (
                    <li key={p.key} className="flex items-start gap-2 text-sm">
                      <Check size={15} className="mt-0.5 shrink-0 text-united-green" aria-hidden />
                      <span>
                        <span className="font-medium text-united-dark">{permissionText(p.key, locale).label}</span>
                        <span className="block text-xs text-united-muted">{permissionText(p.key, locale).description}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
