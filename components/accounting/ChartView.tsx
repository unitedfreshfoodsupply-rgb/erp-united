"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, errorMessage } from "@/lib/api-client";
import { ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { Field } from "@/components/stock/inventory/shared";

/**
 * The chart of accounts as a tree: what each account is, its cash-flow section, and
 * whether it is a system or subledger account (which move only through their documents).
 * Accountants add sub-accounts under a header, rename, classify and retire empty ones.
 */

type Account = { id: string; code: string; name: string; nameAr: string; type: string; parentId: string | null; postable: boolean; systemKey: string | null; active: boolean; version: number; cashFlowCategory: string | null; controlledBy: string | null };
const CF = ["operating", "investing", "financing"] as const;

export function ChartView() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const manage = can("accounting.manage");
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ["acc", "accounts"], queryFn: () => apiFetch<{ accounts: Account[] }>("/api/accounting/accounts").then((r) => r.accounts) });
  const cashQ = useQuery({ queryKey: ["cash-accounts"], queryFn: () => apiFetch<{ cashAccounts: { glAccount?: { id: string } }[] }>("/api/accounting/cash-accounts").then((r) => r.cashAccounts) });
  const cashIds = useMemo(() => new Set((cashQ.data ?? []).map((c) => c.glAccount?.id).filter(Boolean)), [cashQ.data]);
  const tree = useMemo(() => {
    const rows = q.data ?? [];
    const kids = new Map<string | null, Account[]>();
    for (const a of rows) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    for (const list of kids.values()) list.sort((a, b) => a.code.localeCompare(b.code));
    const out: { a: Account; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => { for (const a of kids.get(parent) ?? []) { out.push({ a, depth }); walk(a.id, depth + 1); } };
    walk(null, 0);
    return out;
  }, [q.data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["acc"] });
  const patch = async (a: Account, body: Record<string, unknown>, done: string) => {
    try { await apiPatch(`/api/accounting/accounts/${a.id}`, { ...body, version: a.version }); toast.show(done, "success"); refresh(); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const name = (a: Account) => (locale === "en" ? a.name : a.nameAr);
  return (
    <div className="flex flex-col gap-3">
      {manage && (
        <div className="flex justify-end"><button type="button" className="btn-primary btn-sm" onClick={() => setAdding((x) => !x)}>{t("chart.add")}</button></div>
      )}
      {adding && <NewAccount accounts={q.data} onDone={() => { setAdding(false); refresh(); }} />}
      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead><tr><th>{t("chart.col.code")}</th><th>{t("chart.col.name")}</th><th>{t("chart.col.type")}</th><th>{t("chart.col.cash-flow")}</th><th>{t("chart.col.kind")}</th>{manage && <th><span className="sr-only">{t("treasury.col.actions")}</span></th>}</tr></thead>
          <tbody>
            {tree.map(({ a, depth }) => {
              const isCash = cashIds.has(a.id);
              const pl = a.type === "revenue" || a.type === "expense";
              const locked = !!a.systemKey || !!a.controlledBy || isCash;
              return (
                <tr key={a.id} className={a.active ? "" : "opacity-60"}>
                  <td><bdi dir="ltr" className={a.postable ? "" : "font-extrabold"}>{a.code}</bdi></td>
                  <td><span style={{ paddingInlineStart: `${depth * 1.25}rem` }} className={a.postable ? "" : "font-extrabold"}>{name(a)}</span></td>
                  <td>{t(`chart.type.${a.type}`)}</td>
                  <td>
                    {pl ? <span className="text-united-muted">{t("chart.cf.net-income")}</span> : isCash ? <span className="text-united-muted">{t("chart.cf.cash")}</span> : manage ? (
                      <select className="field field-sm" aria-label={t("chart.col.cash-flow")} value={a.cashFlowCategory ?? ""} onChange={(e) => patch(a, { cash_flow_category: e.target.value || null }, t("chart.toast-classified"))}>
                        {!a.cashFlowCategory && <option value="">{t("chart.cf.none")}</option>}
                        {CF.map((c) => <option key={c} value={c}>{t(`chart.cf.${c}`)}</option>)}
                      </select>
                    ) : a.cashFlowCategory ? t(`chart.cf.${a.cashFlowCategory}`) : <StatusPill tone="warn">{t("chart.cf.none")}</StatusPill>}
                  </td>
                  <td className="whitespace-nowrap">
                    {!a.postable ? <StatusPill tone="neutral">{t("chart.kind.header")}</StatusPill> : a.controlledBy ? <StatusPill tone="info">{t("chart.kind.assets")}</StatusPill> : isCash ? <StatusPill tone="info">{t("chart.kind.cash")}</StatusPill> : a.systemKey ? <StatusPill tone="info">{t("chart.kind.system")}</StatusPill> : null}
                    {!a.active && <StatusPill tone="neutral">{t("treasury.inactive")}</StatusPill>}
                  </td>
                  {manage && (
                    <td className="whitespace-nowrap">
                      <button type="button" className="btn-secondary btn-sm" onClick={async () => {
                        const v = await dialogs.prompt({ title: t("chart.rename", { code: a.code }), label: t(locale === "en" ? "treasury.field.name-en" : "treasury.field.name-ar"), required: true, initialValue: name(a) });
                        if (v) await patch(a, locale === "en" ? { name: v } : { name_ar: v }, t("treasury.toast-saved"));
                      }}>{t("ui.edit")}</button>
                      {!locked && a.active && <button type="button" className="btn-danger btn-sm ms-1" onClick={async () => {
                        if (await dialogs.confirm({ title: t("chart.confirm-retire", { code: a.code }), body: t("chart.retire-body"), tone: "danger", confirmLabel: t("chart.retire") })) await patch(a, { active: false }, t("chart.toast-retired"));
                      }}>{t("chart.retire")}</button>}
                      {!locked && !a.active && <button type="button" className="btn-secondary btn-sm ms-1" onClick={() => patch(a, { active: true }, t("treasury.toast-activated"))}>{t("treasury.activate")}</button>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewAccount({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  // Fixed-asset accounts come from asset categories; every other active header may take children.
  const headers = accounts.filter((a) => !a.postable && a.active && a.id !== "acc_1700").sort((a, b) => a.code.localeCompare(b.code));
  const [f, setF] = useState({ parent_id: headers[0]?.id ?? "", code: "", name: "", name_ar: "", cash_flow_category: "" });
  const parent = headers.find((h) => h.id === f.parent_id);
  const pl = parent?.type === "revenue" || parent?.type === "expense";
  const [busy, setBusy] = useState(false);
  return (
    <form className="card p-4 grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try { await apiPost("/api/accounting/accounts", { parent_id: f.parent_id, code: f.code, name: f.name, name_ar: f.name_ar, ...(!pl && f.cash_flow_category ? { cash_flow_category: f.cash_flow_category } : {}) }); toast.show(t("chart.toast-created"), "success"); onDone(); }
      catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
      finally { setBusy(false); }
    }}>
      <Field label={t("chart.field.parent")} required>
        <select className="field" value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}>
          {headers.map((h) => <option key={h.id} value={h.id}>{h.code} · {locale === "en" ? h.name : h.nameAr}</option>)}
        </select>
      </Field>
      <Field label={t("chart.col.code")} required hint={t("chart.code-hint")}><input className="field" dir="ltr" inputMode="numeric" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
      <Field label={t("treasury.field.name-ar")} required><input className="field" required value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
      <Field label={t("treasury.field.name-en")} required><input className="field" dir="ltr" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      {!pl && (
        <Field label={t("chart.col.cash-flow")} hint={t("chart.cf-hint")}>
          <select className="field" value={f.cash_flow_category} onChange={(e) => setF({ ...f, cash_flow_category: e.target.value })}>
            <option value="">{t("chart.cf.inherit")}</option>
            {CF.map((c) => <option key={c} value={c}>{t(`chart.cf.${c}`)}</option>)}
          </select>
        </Field>
      )}
      <div className="flex gap-2 self-end">
        <button type="submit" className="btn-primary" disabled={busy}>{t("chart.add")}</button>
        <button type="button" className="btn-secondary" onClick={onDone}>{t("ui.cancel")}</button>
      </div>
    </form>
  );
}
