"use client";

import Link from "next/link";
import { PackageX } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import type { OrderDTO } from "@/lib/client-types";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { useToast } from "@/components/ui/Toast";
import { unitLabel } from "@/lib/format";
import { applyOrderToCache } from "@/lib/orderCache";
import { invalidateDerivedOrderData } from "@/lib/queryInvalidation";
import { useState } from "react";

/**
 * An order waiting for stock (Nov 2026): per line what was asked, what is available now, what
 * is covered and what is still short; the procurement suggestions raised for it (purchasing
 * sees them, server-gated); and "re-check stock and release" for whoever may edit orders.
 * Reads only — the release is the one action, and the server decides it.
 */

type StockLine = { itemId: string; line: number; productName: string; unit: string; baseUnit: string; requested: string; requestedBase: string; available: string; covered: string; shortage: string };
type Suggestion = {
  id: string;
  number: string;
  status: string;
  quantity: string;
  uomCode: string;
  orderItem: { id: string; productName: string } | null;
  purchaseOrder: { id: string; number: string; status: string } | null;
};
type StockView = { stockStatus: string; status: string; version: number; lines: StockLine[]; releasable: boolean; suggestions: Suggestion[] | null };

export function StockHoldPanel({ order }: { order: OrderDTO }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const held = order.stockStatus === "awaiting_stock" && order.status === "new";
  // Asked only when the panel can show something: the order is held, or this account may
  // see purchase suggestions (the floor never asks). Not on every focus within 15 s either.
  const view = useQuery({
    queryKey: ["order", order.id, "stock"],
    queryFn: () => apiFetch<StockView>(`/api/orders/${order.id}/stock`),
    enabled: held || can("purchasing.requests.view"),
    refetchInterval: held ? 15_000 : false,
    staleTime: 15_000,
  });
  const suggestions = view.data?.suggestions ?? null;
  if (!held && !(suggestions && suggestions.length > 0)) return null;

  async function release() {
    if (busy) return;
    setBusy(true);
    try {
      const { order: updated } = await apiPost<{ order: OrderDTO }>(`/api/orders/${order.id}/release-stock`, { expected_version: order.version });
      applyOrderToCache(qc, updated);
      invalidateDerivedOrderData(qc, order.id);
      await qc.invalidateQueries({ queryKey: ["order", order.id, "stock"] });
      toast.show(t("hold.released"), "success");
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("orders.error.generic"), "error");
      await qc.invalidateQueries({ queryKey: ["order", order.id, "stock"] });
      void qc.invalidateQueries({ queryKey: ["order", order.id] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card p-5 mt-4 flex flex-col gap-3 ${held ? "border-s-4 !border-s-united-warn" : ""}`}>
      {held && (
        <div>
          <h2 className="inline-flex items-center gap-2 font-extrabold text-united-warn"><PackageX size={18} aria-hidden />{t("hold.title")}</h2>
          <p className="text-sm text-united-muted">{t("hold.desc")}</p>
        </div>
      )}

      {held && view.data && (
        <div>
          <h3 className="font-bold text-united-dark mb-1">{t("hold.stock-title")}</h3>
          {/* One block per line (not a table): it stays readable in the narrow column. */}
          <ul className="flex flex-col divide-y divide-united-border text-sm">
            {view.data.lines.map((l) => {
              const short = Number(l.shortage) > 0;
              return (
                <li key={l.itemId} className="py-2 flex flex-col gap-1">
                  <span className="font-bold">{l.productName}</span>
                  <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-united-muted">
                    <div className="flex gap-1"><dt>{t("hold.col.requested")}</dt><dd dir="ltr" className="font-bold text-united-dark">{l.requested} {unitLabel(l.unit, locale)}</dd></div>
                    <div className="flex gap-1"><dt>{t("hold.col.available")}</dt><dd dir="ltr" className="font-bold text-united-dark">{l.available} {unitLabel(l.baseUnit, locale)}</dd></div>
                    <div className="flex gap-1"><dt>{t("hold.col.covered")}</dt><dd dir="ltr" className="font-bold text-united-dark">{l.covered} {unitLabel(l.baseUnit, locale)}</dd></div>
                    <div className="flex gap-1">
                      <dt>{t("hold.col.short")}</dt>
                      <dd className={`font-bold ${short ? "text-united-danger" : "text-united-green"}`}>
                        {short ? <span dir="ltr">{l.shortage} {unitLabel(l.baseUnit, locale)}</span> : t("hold.line-ok")}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {suggestions && (
        <div>
          <h3 className="font-bold text-united-dark mb-1">{t("hold.suggestions")}</h3>
          {suggestions.length === 0 ? (
            <p className="text-sm text-united-muted">{t("hold.no-suggestions")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {suggestions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <Link className="font-bold underline" dir="ltr" href={`/purchasing/requests?pr_q=${encodeURIComponent(s.number)}`}>{s.number}</Link>
                  <span className="rounded-full bg-united-subtle px-2 py-0.5 text-xs font-bold">{t(`pr.status.${s.status}`)}</span>
                  <span dir="ltr">{s.quantity} {unitLabel(s.uomCode, locale)}</span>
                  {s.orderItem && <span className="text-united-muted">{t("hold.suggestion-line", { product: s.orderItem.productName })}</span>}
                  {s.purchaseOrder && <span className="text-united-muted" dir="ltr">{s.purchaseOrder.number}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {held && can("orders.edit") && (
        <div className="flex flex-wrap items-center gap-3 border-t border-united-border pt-3">
          <button className="btn-primary" disabled={busy} onClick={release}>{t("hold.release")}</button>
          {view.data && <span className={`text-sm font-bold ${view.data.releasable ? "text-united-green" : "text-united-muted"}`}>{view.data.releasable ? t("hold.ready") : t("hold.not-ready")}</span>}
        </div>
      )}
    </div>
  );
}
