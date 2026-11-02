"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { ShieldCheck } from "lucide-react";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { RecoveryCodes } from "@/components/security/RecoveryCodes";

type Status = { enabled: boolean; required: boolean; mustEnroll: boolean; recoveryCodesRemaining: number };

/**
 * Two-step sign-in enrolment (WS6). Reachable with a session that is held at enrolment
 * — a user in a required role lands here straight after the password and can go
 * nowhere else until it is done (or sign out).
 *
 * The secret is rendered as a QR code IN THE BROWSER (no third-party QR service ever
 * sees it) and shown once; leaving the page before confirming simply discards it.
 */
export default function MfaSetupPage() {
  const { t } = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ mfa: Status }>("/api/auth/mfa")
      .then((r) => setStatus(r.mfa))
      .catch(() => router.replace("/login"));
  }, [router]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ secret: string; otpauth_uri: string }>("/api/auth/mfa/enroll");
      const qr = await QRCode.toDataURL(r.otpauth_uri, { margin: 1, width: 220 });
      setEnroll({ secret: r.secret, uri: r.otpauth_uri, qr });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ recovery_codes: string[]; token: string }>("/api/auth/mfa/enroll/confirm", { code: code.trim() });
      // Every other session ended; this tab carries on under the re-issued token.
      if (r.token) window.sessionStorage.setItem("united_token", r.token);
      setEnroll(null);
      setCodes(r.recovery_codes);
      await qc.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await apiPost("/api/auth/logout");
    } finally {
      window.sessionStorage.removeItem("united_token");
      qc.clear();
      router.replace("/login");
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-b from-united-bg to-white">
      <div className="card p-8 w-full max-w-md flex flex-col gap-4 shadow-card-hover border-united-border/60">
        <h1 className="section-title inline-flex items-center gap-2"><ShieldCheck size={20} aria-hidden /> {t("mfa.setup.title")}</h1>

        {!status && !codes && <p className="text-sm text-united-muted">{t("mfa.setup.loading")}</p>}

        {status?.mustEnroll && !codes && <p className="rounded-lg bg-united-info/10 p-3 text-sm font-medium text-united-info">{t("mfa.setup.required-notice")}</p>}

        {status && status.enabled && !codes && (
          <>
            <p className="text-sm text-united-dark">{t("mfa.setup.already-enabled")}</p>
            <button type="button" className="btn-primary" onClick={() => router.push("/profile")}>{t("mfa.setup.to-profile")}</button>
          </>
        )}

        {status && !status.enabled && !enroll && !codes && (
          <>
            <p className="text-sm text-united-dark">{t("mfa.setup.intro")}</p>
            <button type="button" className="btn-primary" disabled={busy} onClick={start}>{t("mfa.setup.start")}</button>
          </>
        )}

        {enroll && (
          <form onSubmit={confirm} className="flex flex-col gap-3">
            <p className="text-sm text-united-dark">{t("mfa.setup.scan")}</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL made in this browser */}
            <img src={enroll.qr} alt={t("mfa.setup.qr-alt")} width={220} height={220} className="self-center rounded-lg border border-united-border" />
            <details className="text-sm">
              <summary className="cursor-pointer text-united-muted">{t("mfa.setup.manual")}</summary>
              <code className="mt-2 block break-all rounded bg-united-subtle p-2 font-mono text-xs" dir="ltr">{enroll.secret}</code>
            </details>
            <label className="flex flex-col gap-1">
              <span className="font-bold">{t("mfa.code.label")}</span>
              <input className="field text-lg tabular-nums" dir="ltr" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </label>
            <button type="submit" className="btn-primary" disabled={busy}>{t("mfa.setup.confirm")}</button>
          </form>
        )}

        {codes && (
          <>
            <p className="text-sm font-bold text-united-green">{t("mfa.setup.done")}</p>
            <RecoveryCodes codes={codes} />
            <button type="button" className="btn-primary" onClick={() => router.push("/")}>{t("mfa.setup.continue")}</button>
          </>
        )}

        {error && <div role="alert" className="bg-united-danger/10 text-united-danger font-bold text-sm text-center rounded-xl px-4 py-3">{error}</div>}

        {!codes && <button type="button" className="btn-ghost btn-sm self-center" onClick={signOut}>{t("mfa.setup.sign-out")}</button>}
      </div>
    </main>
  );
}
