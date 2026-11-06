"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale } from "@/lib/locale";
import type { Role } from "@/lib/types";
import type { SessionUserDTO } from "@/lib/use-session";
import { rememberShellShape, shellShapeFor } from "@/lib/hooks/shellHint";
import { returnPath } from "@/lib/hooks/urlQuery";

type LoginResponse = {
  user?: { role: Role; mustChangePassword?: boolean };
  token?: string;
  mfa_required?: boolean;
  mfa_token?: string;
  mfa_enrollment_required?: boolean;
};

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // WS6 two-step sign-in: after a correct password an enrolled account gets a short-lived
  // pre-authentication token, and the form asks for the authenticator code instead.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useLocale();

  // A session that is held until two-step sign-in is set up belongs on /mfa/setup.
  useEffect(() => {
    apiFetch<{ mfa_enrollment_required?: boolean }>("/api/auth/me")
      .then((r) => {
        if (r?.mfa_enrollment_required) router.replace("/mfa/setup");
      })
      .catch(() => {});
  }, [router]);

  async function finish(r: LoginResponse) {
    // Store the Bearer token in sessionStorage (tab-scoped) for independent
    // multi-tab sessions. The server also sets the httpOnly cookie for backward
    // compatibility; subsequent requests send the Bearer header automatically
    // via apiFetch().
    if (r.token && typeof window !== "undefined") {
      window.sessionStorage.setItem("united_token", r.token);
    }
    if (r.mfa_enrollment_required) {
      await qc.invalidateQueries({ queryKey: ["session"] });
      // A role that must use two-step sign-in sets it up first.
      router.push("/mfa/setup");
      return;
    }
    // The session is read once here, into the cache the next page's header uses, so that page
    // shows its shell at once; and its shape (sidebar or tabs) is remembered before the page
    // opens, so a first sign-in on this browser, or another person's on a shared one, does not
    // jump when the header arrives.
    try {
      const s = await qc.fetchQuery({ queryKey: ["session"], queryFn: () => apiFetch<{ user: SessionUserDTO | null }>("/api/auth/me"), staleTime: 0 });
      if (s?.user) rememberShellShape(shellShapeFor(s.user.permissions));
    } catch {
      // The next page asks for the session itself.
      qc.removeQueries({ queryKey: ["session"] });
    }
    // Back to the page that sent the visitor here; otherwise "/" resolves the landing page
    // from the user's actual permissions on the server.
    router.push(returnPath(new URLSearchParams(window.location.search).get("next"), window.location.origin) ?? "/");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      if (mfaToken) {
        const second = useRecovery ? { mfa_token: mfaToken, recovery_code: code.trim() } : { mfa_token: mfaToken, code: code.trim() };
        const r = await apiPost<LoginResponse>("/api/auth/login", second);
        setPassword("");
        await finish(r);
        return;
      }
      const r = await apiPost<LoginResponse>("/api/auth/login", { username, password });
      if (r.mfa_required && r.mfa_token) {
        setMfaToken(r.mfa_token);
        setCode("");
        return;
      }
      await finish(r);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("error.generic"));
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setMfaToken(null);
    setCode("");
    setUseRecovery(false);
    setError(null);
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-b from-united-bg to-white">
      <form onSubmit={onSubmit} className="card p-8 w-full max-w-sm flex flex-col gap-5 shadow-card-hover border-united-border/60">
        <div className="flex flex-col items-center gap-3 mb-1">
          {/* The brand lockup (mark, UNITED, Fruits & Vegetables) cropped from public/logo-united.png. */}
          <Image src="/brand/united-lockup.webp" alt="" width={160} height={166} priority />
          <h1 className="sr-only">UNITED</h1>
          <p className="text-sm font-bold text-united-green">{t("ui.login.subtitle")}</p>
        </div>

        {!mfaToken ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="font-bold">{t("ui.login.username")}</span>
              <input
                className="field text-lg"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                required
                autoComplete="username"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-bold">{t("ui.login.password")}</span>
              <input
                type="password"
                className="field text-lg"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
              />
            </label>
          </>
        ) : (
          <>
            <p className="text-sm text-united-dark">{useRecovery ? t("mfa.login.recovery-prompt") : t("mfa.login.prompt")}</p>
            <label className="flex flex-col gap-1">
              <span className="font-bold">{useRecovery ? t("mfa.recovery.label") : t("mfa.code.label")}</span>
              <input
                className="field text-lg tabular-nums"
                dir="ltr"
                inputMode={useRecovery ? "text" : "numeric"}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={useRecovery ? 16 : 7}
                autoFocus
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
              />
            </label>
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode("");
                }}
              >
                {useRecovery ? t("mfa.login.use-code") : t("mfa.login.use-recovery")}
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={backToPassword}>
                {t("mfa.login.back")}
              </button>
            </div>
          </>
        )}

        {/* Announced when it appears (focus stays in the field), and tied to the fields below. */}
        {error && (
          <div id="login-error" role="alert" className="bg-united-danger/10 text-united-danger font-bold text-sm text-center rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary text-lg"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              {t("ui.login.logging-in")}
            </span>
          ) : mfaToken ? t("mfa.login.verify") : t("ui.login.button")}
        </button>
      </form>
    </main>
  );
}
