"use client";

import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiPost, ApiClientError } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale } from "@/lib/locale";
import type { Role } from "@/lib/types";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useLocale();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const { token } = await apiPost<{ user: { role: Role; mustChangePassword?: boolean }; token?: string }>("/api/auth/login", {
        username,
        password,
      });
      // Store the Bearer token in sessionStorage (tab-scoped) for independent
      // multi-tab sessions. The server also sets the httpOnly cookie for backward
      // compatibility; subsequent requests send the Bearer header automatically
      // via apiFetch().
      if (token && typeof window !== "undefined") {
        window.sessionStorage.setItem("united_token", token);
      }
      await qc.invalidateQueries({ queryKey: ["session"] });
      // "/" resolves the landing page from the user's actual permissions on the server.
      router.push("/");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("error.generic"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-b from-united-bg to-white">
      <form onSubmit={onSubmit} className="card p-8 w-full max-w-sm flex flex-col gap-5 shadow-card-hover border-united-border/60">
        <div className="flex flex-col items-center gap-3 mb-1">
          {/* The brand lockup (mark, UNITED, Fruits & Vegetables) cropped from public/logo-united.png. */}
          <Image src="/brand/united-lockup.png" alt="" width={160} height={166} priority />
          <h1 className="sr-only">UNITED</h1>
          <p className="text-sm font-bold text-united-green">{t("ui.login.subtitle")}</p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-bold">{t("ui.login.username")}</span>
          <input
            className="field text-lg"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
            autoComplete="username"
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
          />
        </label>

        {error && (
          <div className="bg-united-danger/10 text-united-danger font-bold text-sm text-center rounded-xl px-4 py-3">
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
          ) : t("ui.login.button")}
        </button>
      </form>
    </main>
  );
}
