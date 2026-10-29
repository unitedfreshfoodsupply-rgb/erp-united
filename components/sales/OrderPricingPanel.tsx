"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

type Amounts = { gross: string; discount: string; net: string; tax: string; total: string };
type Pricing = {
  creditStatus?: string | null;
  creditNote?: string | null;
  priceList: { code: string; name: string } | null;
  customer: { code: string; name: string; nameAr: string | null } | null;
  lines: {
    itemId: string; productName: string; unit: string; mapped: boolean; quantity: string; quantityBasis: "loaded" | "prepared" | "required";
    price: { unitPrice: string; discountPct: string; taxCode: string; taxRate: string; source: string; reason: string | null; setBy: string; version: number } | null;
    amounts: Amounts | null;
  }[];
  totals: Amounts;
  unpricedLines: number;
  commercial?: { delivery: { trip: string; status: string } | null; invoice: { id: string; number: string | null; status: string; total: string; open: string | null } | null };
};
// Status maps hold dictionary keys, translated at render.
const DELIVERY: Record<string, string> = { pending: "pricing.delivery.pending", delivered: "pricing.delivery.delivered", partial: "pricing.delivery.partial", failed: "pricing.delivery.failed" };

const CREDIT: Record<string, string> = { warning: "pricing.credit.warning", pending_approval: "pricing.credit.pending_approval", approved: "pricing.credit.approved", rejected: "pricing.credit.rejected" };
const BASIS: Record<string, string> = { loaded: "pricing.basis.loaded", prepared: "pricing.basis.prepared", required: "pricing.basis.required" };
const SOURCE: Record<string, string> = { list: "pricing.source.list", manual: "pricing.source.manual", quotation: "pricing.source.quotation" };

/** The commercial side of an order, for people who may see prices. The floor screens
 * never load this. */
export function OrderPricingPanel({ orderId }: { orderId: string }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ price: "", discount: "", reason: "" });
  const q = useQuery({
    queryKey: ["orders", orderId, "pricing"],
    queryFn: () => apiFetch<Pricing>(`/api/orders/${orderId}/pricing`),
    enabled: can("sales.pricing.view"),
    refetchInterval: 30_000,
  });
  if (!can("sales.pricing.view") || !q.data) return null;
  const p = q.data;
  const canOverride = can("sales.price_override");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["orders", orderId, "pricing"] });
  return (
    <section className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-extrabold text-united-dark">{t("pricing.title")}</h3>
        <span className="text-xs font-bold text-united-muted">{p.customer ? `${localName(p.customer, locale)} · ` : t("pricing.unlinked-customer")}{p.priceList ? p.priceList.name : t("pricing.no-price-list")}</span>
      </div>
      {p.creditStatus && p.creditStatus !== "not_applicable" && p.creditStatus !== "ok" && (
        <p className={`text-sm font-extrabold ${p.creditStatus === "approved" ? "text-united-green" : "text-united-danger"}`}>
          {t("pricing.credit", { status: CREDIT[p.creditStatus] ? t(CREDIT[p.creditStatus]) : p.creditStatus })}{p.creditNote ? ` — ${p.creditNote}` : ""}
        </p>
      )}
      {p.commercial && (p.commercial.delivery || p.commercial.invoice) && (
        <div className="flex flex-wrap gap-2 text-sm font-extrabold">
          {p.commercial.delivery && <span className="rounded-full px-3 py-1 bg-blue-50 text-blue-700">{DELIVERY[p.commercial.delivery.status] ? t(DELIVERY[p.commercial.delivery.status]) : p.commercial.delivery.status} · <span dir="ltr">{p.commercial.delivery.trip}</span></span>}
          {p.commercial.invoice ? (
            <span className={`rounded-full px-3 py-1 ${p.commercial.invoice.open === "0.00" ? "bg-united-green/10 text-united-green" : "bg-united-warn/10 text-united-warn"}`}>
              {p.commercial.invoice.status === "draft" ? t("pricing.invoice-draft") : <>{t("pricing.invoice")} <span dir="ltr">{p.commercial.invoice.number}</span></>} · {p.commercial.invoice.open === "0.00" ? t("pricing.paid") : p.commercial.invoice.open ? <>{t("pricing.left")} <span dir="ltr">{fmtMoney(p.commercial.invoice.open)}</span></> : <span dir="ltr">{fmtMoney(p.commercial.invoice.total)}</span>}
            </span>
          ) : (
            <span className="rounded-full px-3 py-1 bg-united-dark/5">{t("pricing.not-invoiced")}</span>
          )}
        </div>
      )}
      {p.unpricedLines > 0 && <p className="text-sm font-extrabold text-united-warn">{t("pricing.unpriced", { count: p.unpricedLines })}</p>}
      <ul className="flex flex-col divide-y divide-united-dark/5">
        {p.lines.map((l) => (
          <li key={l.itemId} className="py-2 flex flex-col gap-1">
            <div className="flex justify-between gap-2 text-sm">
              <span className="font-extrabold">{l.productName}</span>
              <span dir="ltr" className="font-extrabold">{l.amounts ? fmtMoney(l.amounts.total) : "—"}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs font-bold text-united-muted">
              <span>
                <span dir="ltr">{fmtQty(l.quantity, l.unit)}</span> ({BASIS[l.quantityBasis] ? t(BASIS[l.quantityBasis]) : l.quantityBasis})
                {l.price && <> × <span dir="ltr">{l.price.unitPrice}</span>{Number(l.price.discountPct) > 0 ? ` − ${l.price.discountPct}%` : ""}{Number(l.price.taxRate) > 0 ? ` + ${t("pricing.tax-short")} ${l.price.taxRate}%` : ""} · {SOURCE[l.price.source] ? t(SOURCE[l.price.source]) : l.price.source}{l.price.reason ? ` (${l.price.reason})` : ""}</>}
              </span>
              {canOverride && l.mapped && (
                <button type="button" className="text-united-green underline font-extrabold" onClick={() => { setEditing(editing === l.itemId ? null : l.itemId); setForm({ price: l.price?.unitPrice ?? "", discount: l.price?.discountPct ?? "0", reason: "" }); }}>
                  {t("pricing.edit-price")}
                </button>
              )}
            </div>
            {editing === l.itemId && (
              <form
                className="grid grid-cols-3 gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await apiPatch(`/api/orders/${orderId}/items/${l.itemId}/price`, { unit_price: form.price, discount_pct: form.discount || 0, reason: form.reason, expected_version: l.price?.version });
                    setEditing(null);
                    refresh();
                    toast.show(t("pricing.toast-changed"), "success");
                  } catch (err) {
                    toast.show(err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic"), "error");
                  }
                }}
              >
                <input className="field" inputMode="decimal" dir="ltr" placeholder={t("pricing.price")} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
                <input className="field" inputMode="decimal" dir="ltr" placeholder={t("pricing.discount")} value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />
                <input className="field" placeholder={t("pricing.reason")} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                <button className="btn-primary col-span-3">{t("pricing.save-price")}</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-sm font-bold">
        {[["pricing.gross", p.totals.gross], ["pricing.discount-total", p.totals.discount], ["pricing.tax", p.totals.tax], ["pricing.total", p.totals.total]].map(([k, v]) => (
          <div key={k} className={`rounded-xl p-2 ${k === "pricing.total" ? "bg-united-green/10 text-united-green" : "bg-united-dark/[0.03]"}`}>
            <dt className="text-xs text-united-muted">{t(k)}</dt>
            <dd dir="ltr" className="font-extrabold">{fmtMoney(v)}</dd>
          </div>
        ))}
      </dl>
      {canOverride && (
        <button
          type="button"
          className="btn-secondary self-start"
          onClick={async () => {
            try {
              const r = await apiPost<{ priced: number }>(`/api/orders/${orderId}/reprice`, {});
              refresh();
              toast.show(r.priced ? t("pricing.repriced", { count: r.priced }) : t("pricing.up-to-date"), "success");
            } catch (err) {
              toast.show(err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic"), "error");
            }
          }}
        >
          {t("pricing.reprice")}
        </button>
      )}
    </section>
  );
}
