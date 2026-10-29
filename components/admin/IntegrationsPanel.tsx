"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useLocale } from "@/lib/locale";
import { intlLocale } from "@/lib/format";

/** Integration keys (shown once at creation), revocation, and the recent call log. */
type Row = { id: string; code: string; name: string; keyPrefix: string; scopes: string[]; active: boolean; lastUsedAt: string | null; createdBy: string; revokedAt: string | null };
type Log = { id: string; caller: string; method: string; path: string; status: number; externalId: string | null; result: string | null; error: string | null; durationMs: number; createdAt: string };

export function IntegrationsPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["admin", "integrations"], queryFn: () => apiFetch<{ integrations: Row[]; logs: Log[] }>("/api/admin/integrations") });
  const [f, setF] = useState({ code: "", name: "", create: true, status: true, attendance: false });
  const [key, setKey] = useState<string | null>(null);
  const fail = (err: unknown) => toast.show(err instanceof ApiClientError ? err.message : t("ui.error"), "error");
  if (q.isLoading) return <LoadingState />;
  return (
    <div className="flex flex-col gap-3">
      <section className="card p-4 grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
        <input className="field" dir="ltr" placeholder={t("admin.integrations.code-placeholder")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input className="field" placeholder={t("admin.integrations.name-placeholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label className="flex gap-2 font-bold text-sm"><input type="checkbox" checked={f.create} onChange={(e) => setF({ ...f, create: e.target.checked })} />{t("admin.integrations.create-orders")}</label>
        <label className="flex gap-2 font-bold text-sm"><input type="checkbox" checked={f.status} onChange={(e) => setF({ ...f, status: e.target.checked })} />{t("admin.integrations.track-status")}</label>
        <label className="flex gap-2 font-bold text-sm"><input type="checkbox" checked={f.attendance} onChange={(e) => setF({ ...f, attendance: e.target.checked })} />{t("admin.integrations.attendance-ingest")}</label>
        <button type="button" className="btn-primary" onClick={async () => {
          try {
            const r = await apiPost<{ key: string }>("/api/admin/integrations", { code: f.code, name: f.name, scopes: [...(f.create ? ["orders.create"] : []), ...(f.status ? ["orders.status"] : []), ...(f.attendance ? ["attendance.ingest"] : [])] });
            setKey(r.key);
            setF({ code: "", name: "", create: true, status: true, attendance: false });
            void qc.invalidateQueries({ queryKey: ["admin", "integrations"] });
          } catch (err) { fail(err); }
        }}>{t("admin.integrations.add-key")}</button>
      </section>
      {key && (
        <section className="card p-4 bg-united-warn/10 flex flex-col gap-2">
          <p className="font-extrabold">{t("admin.integrations.key-copy-warning")}</p>
          <code dir="ltr" className="break-all font-bold select-all">{key}</code>
          <button type="button" className="btn-secondary self-start" onClick={() => setKey(null)}>{t("admin.integrations.copy-key")}</button>
        </section>
      )}
      <ul className="flex flex-col gap-2">
        {q.data?.integrations.map((i) => (
          <li key={i.id} className={`card p-3 flex justify-between items-center gap-2 text-sm font-bold ${i.active ? "" : "opacity-60"}`}>
            <span><span dir="ltr">{i.code}</span> · {i.name} · <span dir="ltr">{i.keyPrefix}…</span> · {i.scopes.join(t("admin.integrations.sep-scope"))}{i.lastUsedAt ? ` · ${t("admin.integrations.last-used")} ${new Date(i.lastUsedAt).toLocaleString(intlLocale(locale))}` : ""}{i.active ? "" : ` · ${t("admin.integrations.revoked")}`}</span>
            {i.active && <button type="button" className="btn-danger" onClick={async () => {
              try { await apiPost(`/api/admin/integrations/${i.id}/revoke`, {}); void qc.invalidateQueries({ queryKey: ["admin", "integrations"] }); } catch (err) { fail(err); }
            }}>{t("admin.integrations.revoke-key")}</button>}
          </li>
        ))}
      </ul>
      <section className="card p-3 overflow-x-auto">
        <h3 className="font-extrabold mb-2">{t("admin.integrations.recent-calls")}</h3>
        <table className="w-full text-xs font-bold">
          <tbody>
            {q.data?.logs.map((l) => (
              <tr key={l.id} className="border-t border-united-dark/5">
                <td className="p-1" dir="ltr">{new Date(l.createdAt).toLocaleString("en-GB")}</td>
                <td className="p-1" dir="ltr">{l.caller}</td>
                <td className="p-1" dir="ltr">{l.method} {l.path}</td>
                <td className={`p-1 ${l.status >= 400 ? "text-united-danger" : "text-united-green"}`} dir="ltr">{l.status}</td>
                <td className="p-1" dir="ltr">{l.externalId ?? ""} {l.result ? `→ ${l.result}` : ""}</td>
                <td className="p-1">{l.error ?? ""}</td>
                <td className="p-1" dir="ltr">{l.durationMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
