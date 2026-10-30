"use client";

import { unitLabel } from "@/lib/format";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field } from "@/components/stock/inventory/shared";
import { localName } from "@/lib/locale/names";
import { useLocale } from "@/lib/locale";
import { useDialogs } from "@/components/ui/Dialog";

/**
 * Price lists and the daily price update. Prices are dated: entering today's prices
 * adds rows from today; yesterday's stay as they were. The grid shows each product's
 * price as of the chosen date next to the box for the new one, so a sales person can
 * run down the list in the morning and change only what moved.
 */

type ListRow = { id: string; code: string; name: string; isDefault: boolean; active: boolean; version: number; _count: { customers: number; items: number } };
type Detail = {
  priceList: ListRow;
  date: string;
  current: { id: string; productId: string; uomCode: string; unitPrice: string; validFrom: string; product: { name: string; nameAr: string | null; unit: string } }[];
  history: { id: string; productId: string; uomCode: string; unitPrice: string; validFrom: string; createdBy: string; product: { name: string; nameAr: string | null } }[];
  products: { id: string; name: string; nameAr: string | null; unit: string; salesTaxCode: string; packagings: { uomCode: string; qtyInBaseUnit: string }[] }[];
};

const fail = (toast: ReturnType<typeof useToast>, err: unknown, t: (key: string) => string) =>
  toast.show(err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic"), "error");

export function PriceListsView() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [newList, setNewList] = useState({ code: "", name: "" });
  const lists = useQuery({ queryKey: ["sales", "price-lists"], queryFn: () => apiFetch<{ priceLists: ListRow[] }>("/api/sales/price-lists") });
  if (lists.isLoading) return <LoadingState />;
  if (lists.isError) return <ErrorState message={errorMessage(lists.error)} onRetry={() => lists.refetch()} />;
  const rows = lists.data?.priceLists ?? [];
  const current = selected ?? rows.find((r) => r.isDefault)?.id ?? rows[0]?.id ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {rows.map((l) => (
          <button key={l.id} type="button" onClick={() => setSelected(l.id)} className={`tap-target shrink-0 rounded-xl px-4 font-extrabold text-sm ${current === l.id ? "bg-united-dark text-white" : "bg-united-dark/5"} ${l.active ? "" : "opacity-50"}`}>
            {l.name}{l.isDefault ? " ★" : ""} <span className="text-xs opacity-70">{t("pricelists.customers", { count: l._count.customers })}</span>
          </button>
        ))}
      </div>
      {can("sales.pricing.manage") && (
        <form
          className="card p-3 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await apiPost<{ priceList: ListRow }>("/api/sales/price-lists", { ...newList, is_default: rows.length === 0 });
              setNewList({ code: "", name: "" });
              void qc.invalidateQueries({ queryKey: ["sales", "price-lists"] });
              setSelected(r.priceList.id);
            } catch (err) { fail(toast, err, t); }
          }}
        >
          <input className="field flex-1" dir="ltr" placeholder={t("pricelists.code-placeholder")} value={newList.code} onChange={(e) => setNewList({ ...newList, code: e.target.value })}  aria-label={t("pricelists.code-placeholder")}/>
          <input className="field flex-[2]" placeholder={t("pricelists.name-placeholder")} value={newList.name} onChange={(e) => setNewList({ ...newList, name: e.target.value })}  aria-label={t("pricelists.name-placeholder")}/>
          <button className="btn-secondary shrink-0">{t("pricelists.add")}</button>
        </form>
      )}
      {current ? <ListDetail id={current} /> : <EmptyState icon="🏷️" title={t("pricelists.empty")} />}
    </div>
  );
}

function ListDetail({ id }: { id: string }) {
  const dialogs = useDialogs();
  const { locale, t } = useLocale();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(todayLocalISO());
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["sales", "price-list", id, date], queryFn: () => apiFetch<Detail>(`/api/sales/price-lists/${id}?date=${date}`) });
  const taxes = useQuery({ queryKey: ["sales", "tax-rates"], queryFn: () => apiFetch<{ taxRates: { code: string; name: string; nameAr: string }[] }>("/api/sales/tax-rates"), staleTime: 300_000 });
  const priceOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of q.data?.current ?? []) m.set(`${c.productId}|${c.uomCode}`, c.unitPrice);
    return m;
  }, [q.data]);
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const d = q.data;
  const canManage = can("sales.pricing.manage");
  const f = filter.trim().toLowerCase();
  const products = d.products.filter((p) => !f || p.name.toLowerCase().includes(f) || (p.nameAr ?? "").includes(f));
  const changed = Object.entries(draft).filter(([, v]) => v.trim() !== "");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["sales"] });

  return (
    <div className="flex flex-col gap-3">
      <div className="card p-3 flex flex-wrap items-end gap-3">
        <Field label={t("pricelists.from")}><input type="date" className="field" value={date} onChange={(e) => { setDate(e.target.value || todayLocalISO()); setDraft({}); }} /></Field>
        <input className="field flex-1" placeholder={t("pricelists.search")} value={filter} onChange={(e) => setFilter(e.target.value)}  aria-label={t("pricelists.search")}/>
        {canManage && (
          <div className="flex gap-2">
            {!d.priceList.isDefault && d.priceList.active && (
              <button type="button" className="btn-secondary" onClick={async () => { try { await apiPatch(`/api/sales/price-lists/${id}`, { is_default: true, expected_version: d.priceList.version }); refresh(); } catch (err) { fail(toast, err, t); } }}>
                {t("pricelists.make-default")}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-united-muted">
              <th className="p-2 text-start">{t("pricelists.col.product")}</th><th className="p-2">{t("pricelists.col.unit")}</th><th className="p-2">{t("pricelists.col.price-on", { date })}</th>{canManage && <th className="p-2">{t("pricelists.col.new-price", { date })}</th>}<th className="p-2">{t("pricelists.col.tax")}</th>
            </tr>
          </thead>
          <tbody>
            {products.flatMap((p) =>
              [p.unit, ...p.packagings.map((x) => x.uomCode)].map((uom, idx) => {
                const key = `${p.id}|${uom}`;
                return (
                  <tr key={key} className="border-t border-united-dark/5 font-bold">
                    <td className="p-2">{idx === 0 ? localName(p, locale) : ""}</td>
                    <td className="p-2 text-center" >{unitLabel(uom)}{idx > 0 ? ` (${Number(p.packagings[idx - 1].qtyInBaseUnit)} ${unitLabel(p.unit)})` : ""}</td>
                    <td className="p-2 text-center" dir="ltr">{priceOf.get(key) ?? (idx > 0 && priceOf.get(`${p.id}|${p.unit}`) ? `≈ ${(Number(priceOf.get(`${p.id}|${p.unit}`)) * Number(p.packagings[idx - 1].qtyInBaseUnit)).toFixed(2)}` : "—")}</td>
                    {canManage && (
                      <td className="p-2"><input className="field text-center" inputMode="decimal" dir="ltr" value={draft[key] ?? ""} onChange={(e) => setDraft({ ...draft, [key]: e.target.value.replace(",", ".") })} /></td>
                    )}
                    <td className="p-2 text-center">
                      {idx === 0 && (can("sales.tax.manage") ? (
                        <select className="field text-xs" value={p.salesTaxCode} onChange={async (e) => {
                          const taxCode = e.target.value;
                          const reason = await dialogs.prompt({ title: t("pricelists.tax-reason"), label: t("ui.reason-label"), required: true, multiline: true });
                          if (!reason) return;
                          try { await apiPatch(`/api/sales/products/${p.id}/tax`, { tax_code: taxCode, reason }); refresh(); } catch (err) { fail(toast, err, t); }
                        }}>
                          {(taxes.data?.taxRates ?? []).map((t) => <option key={t.code} value={t.code}>{localName(t, locale)}</option>)}
                        </select>
                      ) : p.salesTaxCode)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {canManage && (
        <button
          type="button"
          className="btn-primary text-lg sticky bottom-3"
          disabled={busy || changed.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await apiPost<{ created: number; replaced: number }>(`/api/sales/price-lists/${id}/prices`, {
                valid_from: date,
                prices: changed.map(([key, v]) => { const [product_id, uom] = key.split("|"); return { product_id, uom, unit_price: v.trim() }; }),
              });
              toast.show(r.replaced ? t("pricelists.saved-replaced", { count: r.created, replaced: r.replaced }) : t("pricelists.saved", { count: r.created }), "success");
              setDraft({});
              refresh();
            } catch (err) { fail(toast, err, t); } finally { setBusy(false); }
          }}
        >
          {busy ? t("pricelists.saving") : t("pricelists.save", { count: changed.length, date })}
        </button>
      )}
      <details className="card p-3">
        <summary className="font-extrabold cursor-pointer">{t("pricelists.history")}</summary>
        <ul className="text-sm mt-2 flex flex-col gap-1">
          {d.history.map((h) => (
            <li key={h.id} className="flex justify-between border-b border-united-dark/5 py-1 font-bold">
              <span>{localName(h.product, locale)} · {h.uomCode}</span>
              <span dir="ltr">{h.unitPrice} · {h.validFrom} · {h.createdBy}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
