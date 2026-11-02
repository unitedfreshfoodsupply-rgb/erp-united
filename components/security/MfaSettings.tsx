"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { RecoveryCodes } from "@/components/security/RecoveryCodes";

type Status = { enabled: boolean; enabledAt: string | null; required: boolean; recoveryCodesRemaining: number };

/**
 * The user's own two-step sign-in (WS6), on the profile page: status, set up, new
 * recovery codes, turn off. Every change needs the current password AND a current
 * code — a session left open on a shared tablet is not enough to remove the factor.
 */
export function MfaSettings() {
  const { t } = useLocale();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["mfa-status"], queryFn: () => apiFetch<{ mfa: Status }>("/api/auth/mfa") });
  const [mode, setMode] = useState<"none" | "disable" | "regenerate">("none");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = data?.mfa;

  function reset() {
    setMode("none");
    setPassword("");
    setCode("");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // A recovery code has letters; a TOTP code is digits only.
    const factor = /^[\d\s]+$/.test(code.trim()) ? { code: code.trim() } : { recovery_code: code.trim() };
    try {
      if (mode === "disable") {
        await apiPost("/api/auth/mfa/disable", { password, ...factor });
      } else {
        const r = await apiPost<{ recovery_codes: string[] }>("/api/auth/mfa/recovery-codes", { password, ...factor });
        setCodes(r.recovery_codes);
      }
      reset();
      await qc.invalidateQueries({ queryKey: ["mfa-status"] });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-3 p-5" aria-label={t("mfa.profile.title")}>
      <h2 className="section-title inline-flex items-center gap-2"><ShieldCheck size={16} aria-hidden /> {t("mfa.profile.title")}</h2>
      {isLoading && <p className="text-sm text-united-muted">{t("mfa.setup.loading")}</p>}
      {status && (
        <>
          <p className={`text-sm font-medium ${status.enabled ? "text-united-green" : "text-united-warn"}`}>
            {status.enabled ? t("mfa.profile.enabled", { n: String(status.recoveryCodesRemaining) }) : t("mfa.profile.disabled")}
          </p>
          {status.required && <p className="text-xs text-united-muted">{t("mfa.profile.required")}</p>}

          {!status.enabled && (
            <Link href="/mfa/setup" className="btn-primary btn-sm self-start">{t("mfa.setup.start")}</Link>
          )}

          {status.enabled && mode === "none" && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary btn-sm" onClick={() => { setCodes(null); setMode("regenerate"); }}>{t("mfa.profile.regenerate")}</button>
              {!status.required && (
                <button type="button" className="btn-ghost btn-sm text-united-danger" onClick={() => { setCodes(null); setMode("disable"); }}>{t("mfa.profile.disable")}</button>
              )}
            </div>
          )}

          {mode !== "none" && (
            <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-united-muted">{t("mfa.profile.current-password")}</span>
                <input type="password" className="field" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-united-muted">{t("mfa.profile.code-or-recovery")}</span>
                <input className="field tabular-nums" dir="ltr" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
              </label>
              <div className="sm:col-span-2 flex gap-2">
                <button type="submit" className={mode === "disable" ? "btn-danger btn-sm" : "btn-primary btn-sm"} disabled={busy}>
                  {mode === "disable" ? t("mfa.profile.disable") : t("mfa.profile.regenerate")}
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={reset}>{t("admin.btn-cancel")}</button>
              </div>
            </form>
          )}

          {codes && <RecoveryCodes codes={codes} />}
          {error && <p role="alert" className="text-sm font-bold text-united-danger">{error}</p>}
        </>
      )}
    </section>
  );
}
