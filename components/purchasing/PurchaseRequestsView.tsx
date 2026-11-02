"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { unitLabel } from "@/lib/format";
import { ErrorState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { todayLocalISO } from "@/lib/localDate";
import { FilterBar, useListState } from "@/components/ui/DataTable";

/**
 * Purchase requests (remediation 2026-11): customer demand the shelf could not cover.
 * Approval happens in the approvals inbox (by someone other than the requester); here
 * an approved request becomes a purchase order, and once its goods are received,
 * graded and sellable, "fulfil" creates the customer's order — stock-checked as usual.
 */

type Req = {
  id: string;
  number: string;
  status: "pending_approval" | "approved" | "rejected" | "cancelled" | "ordered" | "fulfilled";
  quantity: string;
  uomCode: string;
  neededBy: string | null;
  customerReference: string | null;
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  version: number;
  receivedGood: string | null;
  availableNow: string | null;
  product: { id: string; name: string; nameAr: string | null; unit: string };
  customer: { id: string; name: string; nameAr: string | null } | null;
  order: { id: string; orderNumber: string } | null;
  purchaseOrder: { id: string; number: string; status: string; expectedDate: string | null; supplier: { name: string } } | null;
  fulfilledOrder: { id: string; orderNumber: string } | null;
};

const STATUSES = ["pending_approval", "approved", "ordered", "fulfilled", "rejected", "cancelled"] as const;

export function PurchaseRequestsView() {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<string>("");
  // Search (maturity 2026-11): request number, product (either language, SKU), customer.
  const search = useListState([], { prefix: "pr_" });
  const list = useQuery({
    queryKey: ["purchasing", "requests", status, search.q],
    queryFn: () => apiFetch<{ items: Req[] }>(`/api/purchasing/requests?${new URLSearchParams({ ...(status ? { status } : {}), ...(search.q ? { q: search.q } : {}) })}`),
  });
  const suppliers = useQuery({
    queryKey: ["purchasing", "suppliers-lite"],
    queryFn: () => apiFetch<{ suppliers: { id: string; name: string; nameAr?: string | null; active?: boolean }[] }>("/api/purchasing/suppliers"),
    enabled: can("purchasing.orders.manage"),
    staleTime: 60_000,
  });
  const [convert, setConvert] = useState<Record<string, { supplier: string; expected: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, path: string, body: Record<string, unknown>, ok: string) {
    setBusy(id);
    try {
      await apiPost(`/api/purchasing/requests/${id}/${path}`, body);
      toast.show(ok, "success");
      await qc.invalidateQueries({ queryKey: ["purchasing", "requests"] });
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("create.error-generic"), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-united-dark">{t("pr.title")}</h1>
          <p className="text-sm text-united-muted">{t("pr.desc")}</p>
        </div>
        <select className="field w-48" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("pr.filter")}>
          <option value="">{t("pr.all")}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`pr.status.${s}`)}</option>)}
        </select>
      </div>
      <FilterBar list={search} searchLabel={t("pr.search")} searchHint={t("pr.search-hint")} />
      {list.isError && <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />}
      {list.data && list.data.items.length === 0 && <p className="text-united-muted">{search.q ? t("list.empty-filtered") : t("pr.empty")}</p>}
      <div className="flex flex-col gap-3">
        {list.data?.items.map((r) => {
          const c = convert[r.id] ?? { supplier: "", expected: "" };
          const avail = r.availableNow !== null ? Number(r.availableNow) : null;
          return (
            <div key={r.id} className="card p-4 flex flex-col gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-extrabold" dir="ltr">{r.number}</span>
                <span className="rounded-full bg-united-subtle px-3 py-0.5 text-sm font-bold">{t(`pr.status.${r.status}`)}</span>
                <span className="font-bold">{localName(r.product, locale)}</span>
                <span dir="ltr">{r.quantity} {unitLabel(r.uomCode, locale)}</span>
                {r.customer && <span className="text-united-muted">· {localName(r.customer, locale)}</span>}
                {r.neededBy && <span className="text-united-muted">· {t("pr.needed-by", { date: r.neededBy })}</span>}
              </div>
              <div className="text-sm text-united-muted flex gap-3 flex-wrap">
                <span>{t("pr.requested-by", { name: r.requestedBy })}</span>
                {r.decidedBy && <span>{t("pr.decided-by", { name: r.decidedBy })}{r.decisionNote ? ` — ${r.decisionNote}` : ""}</span>}
                {r.order && <span>{t("pr.origin-order", { number: r.order.orderNumber })}</span>}
                {r.purchaseOrder && (
                  <span>
                    {t("pr.po", { number: r.purchaseOrder.number, supplier: r.purchaseOrder.supplier.name })}
                    {r.purchaseOrder.expectedDate ? ` · ${t("pr.expected", { date: r.purchaseOrder.expectedDate })}` : ""}
                  </span>
                )}
                {r.receivedGood !== null && <span>{t("pr.received", { qty: r.receivedGood, unit: unitLabel(r.product.unit, locale) })}</span>}
                {avail !== null && r.status === "ordered" && <span className={avail > 0 ? "text-united-green font-bold" : ""}>{t("pr.available-now", { qty: String(avail), unit: unitLabel(r.product.unit, locale) })}</span>}
                {r.fulfilledOrder && <a className="underline" href={`/orders/${r.fulfilledOrder.id}`}>{t("pr.fulfilled-order", { number: r.fulfilledOrder.orderNumber })}</a>}
              </div>

              {r.status === "pending_approval" && <p className="text-sm text-united-warn">{t("pr.awaiting-approval")}</p>}

              {r.status === "approved" && can("purchasing.orders.manage") && (
                <div className="flex gap-2 flex-wrap items-center">
                  <select className="field w-56" value={c.supplier} onChange={(e) => setConvert((m) => ({ ...m, [r.id]: { ...c, supplier: e.target.value } }))} aria-label={t("pr.supplier")}>
                    <option value="">{t("pr.supplier")}</option>
                    {suppliers.data?.suppliers.filter((s) => s.active !== false).map((s) => <option key={s.id} value={s.id}>{s.nameAr ?? s.name}</option>)}
                  </select>
                  <input type="date" className="field w-44" value={c.expected} onChange={(e) => setConvert((m) => ({ ...m, [r.id]: { ...c, expected: e.target.value } }))} aria-label={t("pr.expected-date")} />
                  <button
                    className="btn-primary text-sm"
                    disabled={!c.supplier || busy === r.id}
                    onClick={() => act(r.id, "convert", { supplier_id: c.supplier, expected_date: c.expected || null, expected_version: r.version }, t("pr.converted"))}
                  >
                    {t("pr.convert")}
                  </button>
                </div>
              )}

              {r.status === "ordered" && r.customer && can("orders.create") && (
                <div className="flex gap-2 flex-wrap items-center">
                  <button
                    className="btn-primary text-sm"
                    disabled={busy === r.id || avail === null || avail <= 0}
                    onClick={() => act(r.id, "fulfil", { delivery_date: r.neededBy && r.neededBy >= todayLocalISO() ? r.neededBy : todayLocalISO(), expected_version: r.version }, t("pr.fulfilled"))}
                  >
                    {t("pr.fulfil")}
                  </button>
                  {(avail === null || avail <= 0) && <span className="text-sm text-united-muted">{t("pr.wait-stock")}</span>}
                </div>
              )}

              {(r.status === "pending_approval" || r.status === "approved") && can("purchasing.requests.create") && (
                <button
                  className="btn-secondary text-sm self-start"
                  disabled={busy === r.id}
                  onClick={() => {
                    const reason = window.prompt(t("pr.cancel-reason"));
                    if (reason && reason.trim()) void act(r.id, "cancel", { reason: reason.trim(), expected_version: r.version }, t("pr.cancelled"));
                  }}
                >
                  {t("pr.cancel")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
