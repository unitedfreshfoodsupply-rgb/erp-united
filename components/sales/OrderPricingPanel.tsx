"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { Field } from "@/components/ui/Field";
import { StatusPill, docTone } from "@/components/ui/StatusPill";
import { useBusy } from "@/components/ui/useBusy";

type Amounts = { gross: string; discount: string; net: string; tax: string; total: string };
type Pricing = {
  creditStatus?: string | null;
  creditNote?: string | null;
  priceList: { code: string; name: string } | null;
  customer: { code: string; name: string; nameAr: string | null } | null;
  lines: {
    itemId: string; productName: string; productNameEn?: string | null; productNameAr?: string | null; unit: string; mapped: boolean; quantity: string; quantityBasis: "loaded" | "prepared" | "required";
    price: { unitPrice: string; discountPct: string; taxCode: string; taxRate: string; source: string; reason: string | null; setBy: string; version: number } | null;
    amounts: Amounts | null;
  }[];
  totals: Amounts;
  unpricedLines: number;
  commercial?: { delivery: { trip: string; status: string } | null; invoice: { id: string; number: string | null; status: string; total: string; open: string | null; credited?: string } | null };
};
// Status maps hold dictionary keys, translated at render.
const DELIVERY: Record<string, string> = { pending: "pricing.delivery.pending", delivered: "pricing.delivery.delivered", partial: "pricing.delivery.partial", failed: "pricing.delivery.failed" };

const CREDIT: Record<string, string> = { warning: "pricing.credit.warning", pending_approval: "pricing.credit.pending_approval", approved: "pricing.credit.approved", rejected: "pricing.credit.rejected" };
const BASIS: Record<string, string> = { loaded: "pricing.basis.loaded", prepared: "pricing.basis.prepared", required: "pricing.basis.required" };
const SOURCE: Record<string, string> = { list: "pricing.source.list", manual: "pricing.source.manual", quotation: "pricing.source.quotation" };

/** The commercial side of an order, for people who may see prices. The floor screens
 * never load this. `orderStatus` (the order screen knows it) lets the panel stop offering
 * price changes the server refuses on a cancelled order. */
export function OrderPricingPanel({ orderId, orderStatus }: { orderId: string; orderStatus?: string }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ price: "", discount: "", reason: "" });
  const { busy, run } = useBusy();
  const q = useQuery({
    queryKey: ["orders", orderId, "pricing"],
    queryFn: () => apiFetch<Pricing>(`/api/orders/${orderId}/pricing`),
    enabled: can("sales.pricing.view"),
    refetchInterval: 30_000,
  });
  if (!can("sales.pricing.view") || !q.data) return null;
  const p = q.data;
  // Prices change on the order only while no invoice holds them and the order is live — the
  // same rule the server refuses with (lib/sales/pricing.ts assertNotInvoiced, overrideLinePrice,
  // repriceOrder). Then the actions are not offered and one line says why (ORD-06).
  const inv = p.commercial?.invoice ?? null;
  const locked =
    orderStatus === "cancelled"
      ? t("pricing.locked.cancelled")
      : inv?.status === "issued"
        ? t("pricing.locked.issued", { number: inv.number ?? "" })
        : inv?.status === "draft"
          ? t("pricing.locked.draft")
          : null;
  const canOverride = can("sales.price_override") && !locked;
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
          {p.commercial.delivery && <StatusPill tone={docTone(p.commercial.delivery.status)} size="md">{DELIVERY[p.commercial.delivery.status] ? t(DELIVERY[p.commercial.delivery.status]) : p.commercial.delivery.status} · <span dir="ltr">{p.commercial.delivery.trip}</span></StatusPill>}
          {p.commercial.invoice ? (
            <StatusPill tone={p.commercial.invoice.open === "0.00" ? "success" : "warn"} size="md">
              {p.commercial.invoice.status === "draft" ? t("pricing.invoice-draft") : <>{t("pricing.invoice")} <span dir="ltr">{p.commercial.invoice.number}</span></>} · {p.commercial.invoice.open === "0.00" ? (Number(p.commercial.invoice.credited ?? 0) > 0 && Number(p.commercial.invoice.credited) >= Number(p.commercial.invoice.total) ? t("pricing.credited-full") : t("pricing.paid")) : p.commercial.invoice.open ? <>{t("pricing.left")} <span dir="ltr">{fmtMoney(p.commercial.invoice.open)}</span></> : <span dir="ltr">{fmtMoney(p.commercial.invoice.total)}</span>}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral" size="md">{t("pricing.not-invoiced")}</StatusPill>
          )}
        </div>
      )}
      {p.unpricedLines > 0 && <p className="text-sm font-extrabold text-united-warn">{t("pricing.unpriced", { count: p.unpricedLines })}</p>}
      <ul className="flex flex-col divide-y divide-united-dark/5">
        {p.lines.map((l) => (
          <li key={l.itemId} className="py-2 flex flex-col gap-1">
            <div className="flex justify-between gap-2 text-sm">
              <span className="font-extrabold">{l.productNameEn ? localName({ name: l.productNameEn, nameAr: l.productNameAr ?? null }, locale) : l.productName}</span>
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
            {editing === l.itemId && canOverride && (
              <form
                className="grid grid-cols-3 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("price", async () => {
                    try {
                      await apiPatch(`/api/orders/${orderId}/items/${l.itemId}/price`, { unit_price: form.price, discount_pct: form.discount || 0, reason: form.reason, expected_version: l.price?.version });
                      setEditing(null);
                      refresh();
                      toast.show(t("pricing.toast-changed"), "success");
                    } catch (err) {
                      toast.show(err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic"), "error");
                    }
                  });
                }}
              >
                <Field label={t("pricing.price")}><input className="field" inputMode="decimal" dir="ltr" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
                <Field label={t("pricing.discount")}><input className="field" inputMode="decimal" dir="ltr" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} /></Field>
                <Field label={t("pricing.reason")}><input className="field" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
                <button className="btn-primary col-span-3" disabled={!!busy} aria-busy={busy === "price" || undefined}>{busy === "price" ? t("ui.saving") : t("pricing.save-price")}</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {/* 2 × 2: the panel lives in the order page's side column on desk screens (UX-01). */}
      <dl className="grid grid-cols-2 gap-2 text-center text-sm font-bold">
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
          disabled={!!busy}
          aria-busy={busy === "reprice" || undefined}
          onClick={() =>
            void run("reprice", async () => {
              try {
                const r = await apiPost<{ priced: number }>(`/api/orders/${orderId}/reprice`, {});
                refresh();
                toast.show(r.priced ? t("pricing.repriced", { count: r.priced }) : t("pricing.up-to-date"), "success");
              } catch (err) {
                toast.show(err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic"), "error");
              }
            })
          }
        >
          {busy === "reprice" ? t("ui.working") : t("pricing.reprice")}
        </button>
      )}
      {locked && can("sales.price_override") && <p className="text-sm text-united-muted" data-testid="pricing-locked">{locked}</p>}
    </section>
  );
}
