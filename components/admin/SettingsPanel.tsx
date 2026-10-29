"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, ApiClientError, errorMessage } from "@/lib/api-client";
import { LoadingState, ErrorState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { SETTING_CHOICES, SETTING_EN, SETTING_GROUP_LABEL, SETTING_GROUP_LABEL_EN, SETTING_UNIT_EN, type SettingGroup, type SettingKey } from "@/lib/core/settings-registry";
import type { SettingDTO } from "@/lib/admin-client-types";
import { useLocale } from "@/lib/locale";

/**
 * System settings: every operational policy number, its current value, where that
 * value came from, and who last changed it. Editing requires a reason, and the save
 * carries the version the editor saw, so two admins cannot silently overwrite each
 * other.
 */
export function SettingsPanel() {
  const { t, isEN } = useLocale();
  const q = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => apiFetch<{ settings: SettingDTO[] }>("/api/admin/settings"),
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const settings = q.data?.settings ?? [];
  const groups = [...new Set(settings.map((s) => s.group))];

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group} className="card p-4">
          <h2 className="text-lg font-extrabold text-united-dark mb-1">
            {(isEN ? SETTING_GROUP_LABEL_EN : SETTING_GROUP_LABEL)[group as SettingGroup] ?? group}
          </h2>
          <p className="text-xs font-bold text-united-muted mb-3">
            {t("admin.settings.subtitle")}
          </p>
          <ul className="flex flex-col divide-y divide-united-border">
            {settings
              .filter((s) => s.group === group)
              .map((s) => (
                <SettingRow key={s.key} setting={s} />
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SettingRow({ setting }: { setting: SettingDTO }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, isEN } = useLocale();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(setting.value));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBool = typeof setting.defaultValue === "boolean";
  const isText = typeof setting.defaultValue === "string";
  const choices = SETTING_CHOICES[setting.key as SettingKey];
  const show = (v: unknown) => {
    if (isBool) return v ? t("admin.settings.toggled-on") : t("admin.settings.toggled-off");
    const c = choices?.[String(v)];
    return c ? (isEN ? c.en : c.ar) : String(v);
  };

  async function save(next: number | boolean | string | null) {
    if (busy) return;
    if (!reason.trim()) {
      setError(t("admin.settings.enter-reason"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/admin/settings/${encodeURIComponent(setting.key)}`, {
        value: next,
        reason,
        expected_version: setting.version,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin"] }),
        qc.invalidateQueries({ queryKey: ["settings"] }),
      ]);
      toast.show(
        next === null ? t("admin.settings.toast-reset") : t("admin.settings.toast-save"),
        "success"
      );
      setEditing(false);
      setReason("");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("admin.settings.toast-error"));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isBool) {
      save(value === "true");
      return;
    }
    if (isText) {
      save(value.trim() as never);
      return;
    }
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n)) {
      setError(t("admin.settings.numeric-value"));
      return;
    }
    save(n);
  }

  // The registry carries Arabic; English comes from SETTING_EN (complete by type).
  const en = isEN ? SETTING_EN[setting.key as SettingKey] : undefined;
  const label = en?.label ?? setting.label;
  const description = en?.description ?? setting.description;
  const unit = isEN ? SETTING_UNIT_EN[setting.unit] ?? setting.unit : setting.unit;
  const unitSuffix = unit ? ` (${unit})` : "";

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="font-extrabold text-united-dark">{label}</div>
          <p className="text-xs font-bold text-united-muted mt-0.5">{description}</p>
        </div>
        <div className="text-end shrink-0">
          <div className="text-2xl font-extrabold text-united-dark tabular-nums">
            <bdi>{show(setting.value)}</bdi>{" "}
            <span className="text-sm text-united-muted">{unit}</span>
          </div>
          <div className="text-[11px] font-bold text-united-muted">
            {setting.isDefault ? (
              t("admin.settings.default-value")
            ) : (
              <>
                {t("admin.settings.is-default").replace("{value}", show(setting.defaultValue!)).replace("{user}", setting.updatedBy || "—")}
              </>
            )}
          </div>
        </div>
      </div>

      {!editing ? (
        <button type="button" className="btn-secondary mt-2 text-sm" onClick={() => setEditing(true)}>
          {t("admin.settings.edit")}
        </button>
      ) : (
        <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr]">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-united-muted">
              {t("admin.settings.new-value").replace("{unitSuffix}", unitSuffix)}
            </span>
            {isBool ? (
              <select className="field" value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
                <option value="true">{t("admin.settings.toggled-on")}</option>
                <option value="false">{t("admin.settings.toggled-off")}</option>
              </select>
            ) : choices ? (
              <select className="field" value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
                {Object.entries(choices).map(([k, c]) => (
                  <option key={k} value={k}>{isEN ? c.en : c.ar}</option>
                ))}
              </select>
            ) : (
              <input
                className="field tabular-nums"
                inputMode={isText ? undefined : "decimal"}
                dir="ltr"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
              />
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-united-muted">
              {t("admin.settings.reason-required")}
            </span>
            <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p className="sm:col-span-2 text-sm font-bold text-united-danger">{error}</p>}
          <div className="sm:col-span-2 flex gap-2 flex-wrap">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t("admin.settings.save")}
            </button>
            {!setting.isDefault && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => save(null)}>
                {t("admin.settings.reset")}
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
                setValue(String(setting.value));
              }}
            >
              {t("admin.settings.cancel")}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
