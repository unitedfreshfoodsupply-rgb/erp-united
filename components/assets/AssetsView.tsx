"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { DICTIONARY } from "@/lib/locale/dictionary";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { CashAccountSelect } from "@/components/accounting/CashAccountSelect";

/**
 * Fixed assets: the register (cost, accumulated depreciation, book value, where it is and
 * who holds it), asset categories and their policy, the monthly depreciation run, and the
 * roll-forward report. Every amount comes from the register the ledger reconciles to.
 */

type Category = { id: string; code: string; name: string; nameAr: string; depreciable: boolean; method: string; usefulLifeMonths: number; residualPercent: string; decliningRate: string | null; depreciationStart: string; capitalizationThreshold: string; active: boolean; assetAccount: { code: string }; accumulatedAccount: { code: string } | null; _count: { assets: number } };
type Named = { id: string; code?: string; name: string; nameAr?: string | null };
type Asset = { id: string; number: string; name: string; nameAr: string | null; status: "draft" | "in_service" | "disposed"; category: Named & { depreciable: boolean }; acquisitionDate: string; inServiceDate: string | null; cost: string; accumulated: string; bookValue: string; residualValue: string; usefulLifeMonths: number; method: string; location: string | null; warehouse: Named | null; custodian: Named | null; vehicle: { id: string; code: string; plate: string } | null; plateNumber: string | null; serialNumber: string | null; fullyDepreciated: boolean; version: number; disposedDate: string | null };
type AssetDetail = Asset & { events: { id: string; type: string; date: string; costDelta: string; accumulatedDelta: string; proceeds: string | null; gainLoss: string | null; reason: string | null; createdBy: string; entry: { number: string } | null }[]; depreciation: { period: string; amount: string; accumulatedAfter: string }[]; schedule: { period: string; amount: string; bookValue: string }[] };
type Tab = "register" | "categories" | "depreciation" | "reports";

export function AssetsView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("register");
  return (
    <div className="page-container">
      <h1 className="page-title">{t("assets.title")}</h1>
      <Tabs value={tab} onChange={setTab} items={[{ key: "register", label: t("assets.tab.register") }, { key: "categories", label: t("assets.tab.categories") }, { key: "depreciation", label: t("assets.tab.depreciation") }, { key: "reports", label: t("assets.tab.reports") }]} />
      {tab === "register" ? <Register /> : tab === "categories" ? <Categories /> : tab === "depreciation" ? <Depreciation /> : <Reports />}
    </div>
  );
}

const useCategories = () => useQuery({ queryKey: ["assets", "categories"], queryFn: () => apiFetch<{ categories: Category[] }>("/api/assets/categories").then((r) => r.categories) });

function statusTone(s: string) { return s === "in_service" ? "success" : s === "draft" ? "warn" : "neutral"; }

function Register() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const cats = useCategories();
  const [filter, setFilter] = useState({ status: "", category_id: "", q: "" });
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ["assets", "list", qs], queryFn: () => apiFetch<{ assets: Asset[]; totals: { cost: string; accumulated: string; bookValue: string; count: number } }>(`/api/assets${qs ? `?${qs}` : ""}`) });
  return (
    <div className="flex flex-col gap-3">
      {q.data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="card p-3"><div className="text-xs font-bold text-united-muted">{t("assets.tile.count")}</div><div className="text-xl font-extrabold">{q.data.totals.count}</div></div>
          <div className="card p-3"><div className="text-xs font-bold text-united-muted">{t("assets.col.cost")}</div><div className="text-xl font-extrabold" dir="ltr">{fmtMoney(q.data.totals.cost)}</div></div>
          <div className="card p-3"><div className="text-xs font-bold text-united-muted">{t("assets.col.accumulated")}</div><div className="text-xl font-extrabold" dir="ltr">{fmtMoney(q.data.totals.accumulated)}</div></div>
          <div className="card p-3"><div className="text-xs font-bold text-united-muted">{t("assets.col.book-value")}</div><div className="text-xl font-extrabold" dir="ltr">{fmtMoney(q.data.totals.bookValue)}</div></div>
        </div>
      )}
      <div className="card p-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <Field label={t("assets.filter.search")}><input className="field" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} /></Field>
        <Field label={t("assets.col.category")}><select className="field" value={filter.category_id} onChange={(e) => setFilter({ ...filter, category_id: e.target.value })}><option value="">{t("assets.filter.all")}</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{localName(c, locale)}</option>)}</select></Field>
        <Field label={t("treasury.col.status")}><select className="field" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">{t("assets.filter.all")}</option>{(["draft", "in_service", "disposed"] as const).map((s) => <option key={s} value={s}>{t(`assets.status.${s}`)}</option>)}</select></Field>
        {can("assets.manage") && <div className="self-end"><button type="button" className="btn-primary" onClick={() => setAdding((x) => !x)}>{t("assets.buy-cash")}</button></div>}
      </div>
      {adding && <BuyForm categories={cats.data ?? []} onDone={() => setAdding(false)} />}
      {open && <AssetPanel id={open} onClose={() => setOpen(null)} />}
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data?.assets.length ? <EmptyState icon="🚚" title={t("assets.empty")} /> : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("treasury.col.number")}</th><th>{t("assets.col.name")}</th><th>{t("assets.col.category")}</th><th>{t("treasury.col.status")}</th><th className="num">{t("assets.col.cost")}</th><th className="num">{t("assets.col.book-value")}</th><th>{t("assets.col.location")}</th></tr></thead>
            <tbody>
              {q.data.assets.map((a) => (
                <tr key={a.id} className="cursor-pointer" onClick={() => setOpen(a.id)}>
                  <td><button type="button" className="font-bold text-united-green underline-offset-2 hover:underline" onClick={() => setOpen(a.id)}><bdi dir="ltr">{a.number}</bdi></button></td>
                  <td>{localName(a, locale)}{a.plateNumber ? <span className="block text-xs text-united-muted">{a.plateNumber}</span> : null}</td>
                  <td>{localName(a.category, locale)}</td>
                  <td><StatusPill tone={statusTone(a.status)}>{t(`assets.status.${a.status}`)}</StatusPill>{a.fullyDepreciated && <span className="block text-xs text-united-muted">{t("assets.fully-depreciated")}</span>}</td>
                  <td className="num" dir="ltr">{fmtMoney(a.cost)}</td>
                  <td className="num" dir="ltr">{fmtMoney(a.bookValue)}</td>
                  <td>{a.warehouse ? localName(a.warehouse, locale) : ""}{a.location ? ` · ${a.location}` : ""}{a.custodian ? ` · ${localName(a.custodian, locale)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BuyForm({ categories, onDone }: { categories: Category[]; onDone: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ category_id: categories[0]?.id ?? "", name: "", cost: "", acquisition_date: todayLocalISO(), in_service_date: "", cash_account_id: "bank_main", location: "", plate_number: "", serial_number: "" });
  const [busy, setBusy] = useState(false);
  return (
    <form className="card p-4 grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      try { await apiPost("/api/assets", { ...f, ...(f.in_service_date ? {} : { in_service_date: undefined }) }); toast.show(t("assets.toast-created"), "success"); void qc.invalidateQueries({ queryKey: ["assets"] }); onDone(); }
      catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
      finally { setBusy(false); }
    }}>
      <p className="sm:col-span-3 text-sm text-united-muted">{t("assets.buy-cash-hint")}</p>
      <Field label={t("assets.col.category")} required><select className="field" required value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>{categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{localName(c, locale)}</option>)}</select></Field>
      <Field label={t("assets.col.name")} required><input className="field" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={t("assets.col.cost")} required><input className="field" dir="ltr" inputMode="decimal" required value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
      <Field label={t("assets.field.acquired")} required><input type="date" className="field" required value={f.acquisition_date} onChange={(e) => setF({ ...f, acquisition_date: e.target.value })} /></Field>
      <Field label={t("assets.field.in-service")} hint={t("assets.field.in-service-hint")}><input type="date" className="field" value={f.in_service_date} onChange={(e) => setF({ ...f, in_service_date: e.target.value })} /></Field>
      <Field label={t("accounting.form.account.label")} required><CashAccountSelect value={f.cash_account_id} onChange={(id) => setF({ ...f, cash_account_id: id })} /></Field>
      <Field label={t("assets.col.location")}><input className="field" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      <Field label={t("assets.field.plate")}><input className="field" value={f.plate_number} onChange={(e) => setF({ ...f, plate_number: e.target.value })} /></Field>
      <Field label={t("assets.field.serial")}><input className="field" dir="ltr" value={f.serial_number} onChange={(e) => setF({ ...f, serial_number: e.target.value })} /></Field>
      <div className="flex gap-2 self-end"><button type="submit" className="btn-primary" disabled={busy || !categories.length}>{t("assets.save")}</button><button type="button" className="btn-secondary" onClick={onDone}>{t("ui.cancel")}</button></div>
    </form>
  );
}

type Action = null | "service" | "transfer" | "improve" | "dispose" | "estimate";

function AssetPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const [action, setAction] = useState<Action>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ["assets", "detail", id], queryFn: () => apiFetch<{ asset: AssetDetail }>(`/api/assets/${id}`).then((r) => r.asset) });
  const a = q.data;
  if (!a) return q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : <LoadingState />;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (path: string, body: Record<string, unknown>) => {
    try { await apiPost(`/api/assets/${id}/${path}`, body); toast.show(t("assets.toast-saved"), "success"); setAction(null); setF({}); void qc.invalidateQueries({ queryKey: ["assets"] }); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  const open = (x: Action, init: Record<string, string> = {}) => { setAction(x); setF(init); };
  const manage = can("assets.manage") && a.status !== "disposed";
  return (
    <section className="card overflow-hidden" aria-labelledby="asset-panel">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="asset-panel" className="section-title"><bdi dir="ltr">{a.number}</bdi> · {localName(a, locale)}</h2>
          <p className="text-sm text-united-muted">{localName(a.category, locale)} · <StatusPill tone={statusTone(a.status)}>{t(`assets.status.${a.status}`)}</StatusPill></p>
        </div>
        <button type="button" className="btn-secondary btn-sm shrink-0" onClick={onClose}>{t("accounting.button.close")}</button>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {([["assets.col.cost", fmtMoney(a.cost)], ["assets.col.accumulated", fmtMoney(a.accumulated)], ["assets.col.book-value", fmtMoney(a.bookValue)], ["assets.field.residual", fmtMoney(a.residualValue)], ["assets.field.acquired", a.acquisitionDate], ["assets.field.in-service", a.inServiceDate ?? "—"], ["assets.field.life", t("assets.months", { n: String(a.usefulLifeMonths) })], ["assets.field.method", t(`assets.method.${a.method}`)]] as const).map(([k, v]) => (
            <div key={k}><dt className="font-bold text-united-muted">{t(k)}</dt><dd className="font-extrabold" dir="auto">{v}</dd></div>
          ))}
        </dl>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {a.status === "draft" && <button type="button" className="btn-primary btn-sm" onClick={() => open("service", { in_service_date: todayLocalISO() })}>{t("assets.action.place")}</button>}
            <button type="button" className="btn-secondary btn-sm" onClick={() => open("transfer", { location: a.location ?? "" })}>{t("assets.action.transfer")}</button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => open("improve", { date: todayLocalISO(), cash_account_id: "bank_main" })}>{t("assets.action.improve")}</button>
            {a.status === "in_service" && <button type="button" className="btn-secondary btn-sm" onClick={() => open("estimate", { useful_life_months: String(a.usefulLifeMonths), residual_value: a.residualValue })}>{t("assets.action.estimate")}</button>}
            <button type="button" className="btn-danger btn-sm" onClick={() => open("dispose", { kind: "sale", date: todayLocalISO(), cash_account_id: "bank_main", tax_code: "" })}>{t("assets.action.dispose")}</button>
          </div>
        )}
        {action === "service" && (
          <form className="grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void submit("place-in-service", { in_service_date: f.in_service_date, location: f.location, plate_number: f.plate_number, version: a.version }); }}>
            <Field label={t("assets.field.in-service")} required><input type="date" className="field" required value={f.in_service_date ?? ""} onChange={set("in_service_date")} /></Field>
            <Field label={t("assets.col.location")}><input className="field" value={f.location ?? ""} onChange={set("location")} /></Field>
            <Field label={t("assets.field.plate")}><input className="field" value={f.plate_number ?? ""} onChange={set("plate_number")} /></Field>
            <div className="flex gap-2"><button type="submit" className="btn-primary">{t("assets.action.place")}</button><button type="button" className="btn-secondary" onClick={() => setAction(null)}>{t("ui.cancel")}</button></div>
          </form>
        )}
        {action === "transfer" && (
          <form className="grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void submit("transfer", { location: f.location, reason: f.reason, version: a.version }); }}>
            <Field label={t("assets.col.location")} required><input className="field" required value={f.location ?? ""} onChange={set("location")} /></Field>
            <Field label={t("ui.reason-label")} required><input className="field" required value={f.reason ?? ""} onChange={set("reason")} /></Field>
            <div className="flex gap-2 self-end"><button type="submit" className="btn-primary">{t("assets.action.transfer")}</button><button type="button" className="btn-secondary" onClick={() => setAction(null)}>{t("ui.cancel")}</button></div>
          </form>
        )}
        {action === "improve" && (
          <form className="grid grid-cols-1 gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void submit("improve", { amount: f.amount, date: f.date, cash_account_id: f.cash_account_id, description: f.description }); }}>
            <Field label={t("treasury.field.amount")} required><input className="field" dir="ltr" inputMode="decimal" required value={f.amount ?? ""} onChange={set("amount")} /></Field>
            <Field label={t("treasury.field.date")} required><input type="date" className="field" required value={f.date ?? ""} onChange={set("date")} /></Field>
            <Field label={t("accounting.form.account.label")} required><CashAccountSelect value={f.cash_account_id ?? ""} onChange={(v) => setF({ ...f, cash_account_id: v })} /></Field>
            <Field label={t("accounting.description")} required><input className="field" required value={f.description ?? ""} onChange={set("description")} /></Field>
            <p className="sm:col-span-4 text-xs text-united-muted">{t("assets.improve-hint")}</p>
            <div className="flex gap-2"><button type="submit" className="btn-primary">{t("assets.action.improve")}</button><button type="button" className="btn-secondary" onClick={() => setAction(null)}>{t("ui.cancel")}</button></div>
          </form>
        )}
        {action === "estimate" && (
          <form className="grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void submit("estimate", { useful_life_months: Number(f.useful_life_months), residual_value: f.residual_value, reason: f.reason, version: a.version }); }}>
            <Field label={t("assets.field.life-months")} required><input className="field" dir="ltr" inputMode="numeric" required value={f.useful_life_months ?? ""} onChange={set("useful_life_months")} /></Field>
            <Field label={t("assets.field.residual")}><input className="field" dir="ltr" inputMode="decimal" value={f.residual_value ?? ""} onChange={set("residual_value")} /></Field>
            <Field label={t("ui.reason-label")} required><input className="field" required value={f.reason ?? ""} onChange={set("reason")} /></Field>
            <div className="flex gap-2"><button type="submit" className="btn-primary">{t("ui.save")}</button><button type="button" className="btn-secondary" onClick={() => setAction(null)}>{t("ui.cancel")}</button></div>
          </form>
        )}
        {action === "dispose" && (
          <form className="grid grid-cols-1 gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void submit("dispose", { kind: f.kind, date: f.date, reason: f.reason, version: a.version, ...(f.kind === "sale" ? { proceeds: f.proceeds, cash_account_id: f.cash_account_id, ...(f.tax_code ? { tax_code: f.tax_code } : {}) } : {}) }); }}>
            <Field label={t("assets.field.dispose-kind")} required><select className="field" value={f.kind} onChange={set("kind")}><option value="sale">{t("assets.dispose.sale")}</option><option value="scrap">{t("assets.dispose.scrap")}</option></select></Field>
            <Field label={t("treasury.field.date")} required><input type="date" className="field" required value={f.date ?? ""} onChange={set("date")} /></Field>
            {f.kind === "sale" && <Field label={t("assets.field.proceeds")} required><input className="field" dir="ltr" inputMode="decimal" required value={f.proceeds ?? ""} onChange={set("proceeds")} /></Field>}
            {f.kind === "sale" && <Field label={t("accounting.form.account.label")} required><CashAccountSelect value={f.cash_account_id ?? ""} onChange={(v) => setF({ ...f, cash_account_id: v })} /></Field>}
            {f.kind === "sale" && <Field label={t("assets.field.vat")}><select className="field" value={f.tax_code} onChange={set("tax_code")}><option value="">{t("assets.vat.none")}</option><option value="VAT14">{t("assets.vat.14")}</option></select></Field>}
            <Field label={t("ui.reason-label")} required><input className="field" required value={f.reason ?? ""} onChange={set("reason")} /></Field>
            <p className="sm:col-span-3 text-xs text-united-muted">{t("assets.dispose-hint")}</p>
            <div className="flex gap-2"><button type="submit" className="btn-danger">{t("assets.action.dispose")}</button><button type="button" className="btn-secondary" onClick={() => setAction(null)}>{t("ui.cancel")}</button></div>
          </form>
        )}
        <h3 className="font-extrabold">{t("assets.history")}</h3>
        <ul className="flex flex-col divide-y divide-united-border text-sm">
          {a.events.map((e) => (
            <li key={e.id} className="py-1.5 flex flex-wrap justify-between gap-2">
              <span><bdi dir="ltr">{e.date}</bdi> · {t(`assets.event.${e.type}`)}{e.reason ? ` — ${e.reason}` : ""}{e.entry ? <> · <bdi dir="ltr">{e.entry.number}</bdi></> : null}</span>
              <span dir="ltr" className="font-bold">{Number(e.costDelta) ? fmtMoney(e.costDelta) : ""}{e.gainLoss ? ` (${fmtMoney(e.gainLoss)})` : ""}</span>
            </li>
          ))}
        </ul>
        {(a.depreciation.length > 0 || a.schedule.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <h3 className="font-extrabold">{t("assets.depreciated")}</h3>
              <table className="data-table"><thead><tr><th>{t("assets.col.month")}</th><th className="num">{t("treasury.field.amount")}</th><th className="num">{t("assets.col.accumulated")}</th></tr></thead>
                <tbody>{a.depreciation.slice(-12).map((l) => <tr key={l.period}><td dir="ltr">{l.period}</td><td className="num" dir="ltr">{fmtMoney(l.amount)}</td><td className="num" dir="ltr">{fmtMoney(l.accumulatedAfter)}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h3 className="font-extrabold">{t("assets.schedule")}</h3>
              <table className="data-table"><thead><tr><th>{t("assets.col.month")}</th><th className="num">{t("treasury.field.amount")}</th><th className="num">{t("assets.col.book-value")}</th></tr></thead>
                <tbody>{a.schedule.slice(0, 12).map((l) => <tr key={l.period}><td dir="ltr">{l.period}</td><td className="num" dir="ltr">{fmtMoney(l.amount)}</td><td className="num" dir="ltr">{fmtMoney(l.bookValue)}</td></tr>)}</tbody></table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Starting points only: the accountant confirms every value with the auditor before saving. */
const SUGGESTIONS = [
  { key: "vehicles", code: "VEH", life: 60, residual: 10 },
  { key: "refrigeration", code: "REF", life: 84, residual: 5 },
  { key: "cold-rooms", code: "CLD", life: 120, residual: 5 },
  { key: "scales", code: "SCL", life: 60, residual: 0 },
  { key: "it", code: "IT", life: 36, residual: 0 },
  { key: "furniture", code: "FUR", life: 60, residual: 0 },
] as const;

function Categories() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useCategories();
  const blank = { code: "", name: "", name_ar: "", depreciable: true, method: "straight_line", useful_life_months: "", residual_percent: "0", declining_rate: "", depreciation_start: "", capitalization_threshold: "" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {can("assets.manage") && (
        <form className="card p-4 flex flex-col gap-2" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true);
          try {
            await apiPost("/api/assets/categories", { code: f.code, name: f.name, name_ar: f.name_ar, depreciable: f.depreciable, method: f.method, useful_life_months: Number(f.useful_life_months || 1), residual_percent: Number(f.residual_percent || 0), ...(f.method === "declining_balance" ? { declining_rate: Number(f.declining_rate) } : {}), depreciation_start: f.depreciation_start, capitalization_threshold: Number(f.capitalization_threshold || 0) });
            toast.show(t("assets.toast-category"), "success"); setF(blank); void qc.invalidateQueries({ queryKey: ["assets"] });
          } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
          finally { setBusy(false); }
        }}>
          <h2 className="section-title">{t("assets.new-category")}</h2>
          <div className="flex flex-wrap gap-1 text-sm"><span className="font-bold text-united-muted">{t("assets.suggestions")}</span>
            {SUGGESTIONS.map((s) => <button key={s.key} type="button" className="btn-secondary btn-sm" onClick={() => { const d = DICTIONARY[`assets.suggest.${s.key}` as keyof typeof DICTIONARY]; setF({ ...f, code: s.code, name: d?.en ?? "", name_ar: d?.ar ?? "", useful_life_months: String(s.life), residual_percent: String(s.residual) }); }}>{t(`assets.suggest.${s.key}`)}</button>)}
          </div>
          <p className="text-xs text-united-warn font-bold">{t("assets.suggestions-note")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <Field label={t("chart.col.code")} required><input className="field" dir="ltr" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label={t("treasury.field.name-ar")} required><input className="field" required value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
            <Field label={t("treasury.field.name-en")} required><input className="field" dir="ltr" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label={t("assets.field.depreciable")}><select className="field" value={f.depreciable ? "1" : "0"} onChange={(e) => setF({ ...f, depreciable: e.target.value === "1" })}><option value="1">{t("assets.yes")}</option><option value="0">{t("assets.no-land")}</option></select></Field>
            {f.depreciable && <Field label={t("assets.field.method")} required><select className="field" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="straight_line">{t("assets.method.straight_line")}</option><option value="declining_balance">{t("assets.method.declining_balance")}</option></select></Field>}
            {f.depreciable && <Field label={t("assets.field.life-months")} required><input className="field" dir="ltr" inputMode="numeric" required value={f.useful_life_months} onChange={(e) => setF({ ...f, useful_life_months: e.target.value })} /></Field>}
            {f.depreciable && <Field label={t("assets.field.residual-pct")}><input className="field" dir="ltr" inputMode="decimal" value={f.residual_percent} onChange={(e) => setF({ ...f, residual_percent: e.target.value })} /></Field>}
            {f.depreciable && f.method === "declining_balance" && <Field label={t("assets.field.declining-rate")} required><input className="field" dir="ltr" inputMode="decimal" required value={f.declining_rate} onChange={(e) => setF({ ...f, declining_rate: e.target.value })} /></Field>}
            <Field label={t("assets.field.start")} required><select className="field" required value={f.depreciation_start} onChange={(e) => setF({ ...f, depreciation_start: e.target.value })}><option value="" disabled>{t("assets.choose")}</option><option value="same_month">{t("assets.start.same_month")}</option><option value="next_month">{t("assets.start.next_month")}</option></select></Field>
            <Field label={t("assets.field.threshold")} hint={t("assets.field.threshold-hint")}><input className="field" dir="ltr" inputMode="decimal" value={f.capitalization_threshold} onChange={(e) => setF({ ...f, capitalization_threshold: e.target.value })} /></Field>
          </div>
          <div><button type="submit" className="btn-primary" disabled={busy}>{t("assets.save-category")}</button></div>
        </form>
      )}
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState icon="🗂️" title={t("assets.no-categories")} /> : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("chart.col.code")}</th><th>{t("assets.col.category")}</th><th>{t("assets.field.method")}</th><th>{t("assets.field.life")}</th><th className="num">{t("assets.field.residual-pct")}</th><th className="num">{t("assets.field.threshold")}</th><th>{t("assets.col.accounts")}</th><th className="num">{t("assets.tile.count")}</th></tr></thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id}>
                  <td><bdi dir="ltr">{c.code}</bdi></td>
                  <td>{localName(c, locale)}</td>
                  <td>{c.depreciable ? t(`assets.method.${c.method}`) : t("assets.not-depreciated")}</td>
                  <td>{c.depreciable ? `${t("assets.months", { n: String(c.usefulLifeMonths) })} · ${t(`assets.start.${c.depreciationStart}`)}` : "—"}</td>
                  <td className="num" dir="ltr">{c.residualPercent}%</td>
                  <td className="num" dir="ltr">{fmtMoney(c.capitalizationThreshold)}</td>
                  <td><bdi dir="ltr">{c.assetAccount.code}{c.accumulatedAccount ? ` / ${c.accumulatedAccount.code}` : ""}</bdi></td>
                  <td className="num">{c._count.assets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Depreciation() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(todayLocalISO().slice(0, 7));
  const pv = useQuery({ queryKey: ["assets", "dep-preview", period], queryFn: () => apiFetch<{ preview: { rows: { assetId: string; number: string; name: string; nameAr: string | null; months: string[]; amount: string }[]; total: string; runs: string[] } }>(`/api/assets/depreciation?period=${period}`).then((r) => r.preview), enabled: /^\d{4}-\d{2}$/.test(period) });
  const runs = useQuery({ queryKey: ["assets", "runs"], queryFn: () => apiFetch<{ runs: { id: string; number: string; period: string; date: string; total: string; lineCount: number; entry: { number: string } }[] }>("/api/assets/depreciation/runs").then((r) => r.runs) });
  return (
    <div className="flex flex-col gap-3">
      <div className="card p-4 flex flex-col gap-2">
        <p className="text-sm text-united-muted">{t("assets.dep-explain")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("assets.col.month")}><input type="month" className="field" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
          {can("assets.manage") && <button type="button" className="btn-primary" disabled={!pv.data?.rows.length} onClick={async () => {
            if (!(await dialogs.confirm({ title: t("assets.confirm-run", { period }), body: t("assets.confirm-run-body", { total: fmtMoney(pv.data?.total ?? "0") }), confirmLabel: t("assets.run") }))) return;
            try { await apiPost("/api/assets/depreciation", { period }); toast.show(t("assets.toast-run"), "success"); void qc.invalidateQueries({ queryKey: ["assets"] }); }
            catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
          }}>{t("assets.run")}</button>}
        </div>
        {pv.isLoading ? <LoadingState /> : !pv.data?.rows.length ? <EmptyState icon="✅" title={t("assets.nothing-due")} /> : (
          <table className="data-table">
            <thead><tr><th>{t("treasury.col.number")}</th><th>{t("assets.col.name")}</th><th>{t("assets.col.months")}</th><th className="num">{t("treasury.field.amount")}</th></tr></thead>
            <tbody>
              {pv.data.rows.map((r) => <tr key={r.assetId}><td><bdi dir="ltr">{r.number}</bdi></td><td>{localName(r, locale)}</td><td dir="ltr">{r.months.join(", ")}</td><td className="num" dir="ltr">{fmtMoney(r.amount)}</td></tr>)}
              <tr className="font-extrabold"><td colSpan={3}>{t("mgmt.cf.table.row.total")}</td><td className="num" dir="ltr">{fmtMoney(pv.data.total)}</td></tr>
            </tbody>
          </table>
        )}
      </div>
      <h2 className="section-title">{t("assets.runs")}</h2>
      {!runs.data?.length ? <EmptyState icon="📅" title={t("assets.no-runs")} /> : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("treasury.col.number")}</th><th>{t("assets.col.month")}</th><th className="num">{t("treasury.field.amount")}</th><th className="num">{t("assets.col.lines")}</th><th>{t("assets.col.entry")}</th></tr></thead>
            <tbody>{runs.data.map((r) => <tr key={r.id}><td><bdi dir="ltr">{r.number}</bdi></td><td dir="ltr">{r.period}</td><td className="num" dir="ltr">{fmtMoney(r.total)}</td><td className="num">{r.lineCount}</td><td><bdi dir="ltr">{r.entry.number}</bdi></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Reports() {
  const { t, locale } = useLocale();
  const [range, setRange] = useState({ from: `${todayLocalISO().slice(0, 4)}-01-01`, to: todayLocalISO() });
  const q = useQuery({ queryKey: ["assets", "roll-forward", range], queryFn: () => apiFetch<{ report: { rows: { categoryId: string; code: string; name: string; nameAr: string; openingBookValue: string; additions: string; openingDepreciation: string; depreciation: string; disposals: string; closingBookValue: string; ties: boolean }[] } }>(`/api/assets/reports/roll-forward?from=${range.from}&to=${range.to}`).then((r) => r.report) });
  return (
    <div className="flex flex-col gap-3">
      <div className="card p-3 flex flex-wrap gap-2 items-end">
        <Field label={t("vat.period-from")}><input type="date" className="field" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label={t("vat.period-to")}><input type="date" className="field" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      <h2 className="section-title">{t("assets.roll-forward")}</h2>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data?.rows.length ? <EmptyState icon="📊" title={t("assets.no-categories")} /> : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("assets.col.category")}</th><th className="num">{t("assets.rf.opening")}</th><th className="num">{t("assets.rf.additions")}</th><th className="num">{t("assets.rf.depreciation")}</th><th className="num">{t("assets.rf.disposals")}</th><th className="num">{t("assets.rf.closing")}</th><th>{t("assets.rf.ties")}</th></tr></thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.categoryId}>
                  <td>{localName(r, locale)}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.openingBookValue)}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.additions)}</td>
                  <td className="num" dir="ltr">{fmtMoney((Number(r.depreciation) + Number(r.openingDepreciation)).toFixed(2))}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.disposals)}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.closingBookValue)}</td>
                  <td><StatusPill tone={r.ties ? "success" : "danger"}>{t(r.ties ? "assets.rf.ok" : "assets.rf.diff")}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
