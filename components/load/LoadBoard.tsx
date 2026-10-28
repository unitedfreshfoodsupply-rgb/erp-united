"use client";

import { useState } from "react";
import { CheckCircle2, Truck } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import type { OrderDTO } from "@/lib/client-types";
import { OrderCard } from "@/components/OrderCard";
import { EmptyState, ErrorState } from "@/components/States";
import { BoardSkeleton } from "@/components/Skeleton";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { useToast } from "@/components/ui/Toast";
import { orderUrgency } from "@/lib/orderPresentation";
import { invalidateDerivedOrderData } from "@/lib/queryInvalidation";
import { applyOrderToCache } from "@/lib/orderCache";
import { useReadyForLoadingAlert } from "@/lib/liveAlerts";
import { useOperationalSettings } from "@/lib/use-operational-settings";
import { useLocale } from "@/lib/locale/useLocale";
import { useDialogs } from "@/components/ui/Dialog";

const URGENCY_RANK = { late: 0, soon: 1, ok: 2, none: 3 } as const;

export function LoadBoard() {
  const dialogs = useDialogs();
  const ops = useOperationalSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const [vehicle, setVehicle] = useState("");
  const [driverName, setDriverName] = useState("");
  const [crateCounts, setCrateCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch every non-final order so a brand-new order is visible here the instant it
  // arrives (read-only until it's actually ready to load), not just once it reaches
  // ready_for_loading — the loader tablet should show the same live picture as everyone else.
  const { data, isLoading, isError, error: queryError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["orders", "load"],
    queryFn: () =>
      apiFetch<{ orders: OrderDTO[] }>(
        "/api/orders?status=new,preparing,ready_for_loading,loading,loaded"
      ),
    refetchInterval: 3000,
  });

  useReadyForLoadingAlert(data?.orders);

  const orders = data?.orders ?? [];
  const upcoming = [...orders].filter((o) => o.status === "new" || o.status === "preparing");
  const active = [...orders]
    .filter((o) => o.status === "ready_for_loading" || o.status === "loading")
    .sort((a, b) => {
      const ua = URGENCY_RANK[orderUrgency(a.status, a.deliveryDate, a.deliveryTime, ops.deliverySoonMinutes)];
      const ub = URGENCY_RANK[orderUrgency(b.status, b.deliveryDate, b.deliveryTime, ops.deliverySoonMinutes)];
      return ua - ub;
    });
  const readyToDispatch = orders.filter((o) => o.status === "loaded");
  const canDispatch =
    vehicle.trim() &&
    driverName.trim() &&
    readyToDispatch.length > 0 &&
    readyToDispatch.every((o) => Number(crateCounts[o.id]) > 0);

  async function dispatchAll() {
    if (busy) return;
    const ok = await dialogs.confirm({
      title: t("orders.load-board.confirm-text", {
        vehicle: vehicle.trim(),
        driver: driverName.trim(),
        count: String(readyToDispatch.length),
      }),
    });
    if (!ok) return;
    setError(null);
    setBusy(true);
    try {
      for (const o of readyToDispatch) {
        const { order } = await apiPost<{ order: OrderDTO }>(`/api/orders/${o.id}/status`, {
          to: "dispatched",
          expected_version: o.version,
          vehicle: vehicle.trim(),
          driver_name: driverName.trim(),
          crate_count: Number(crateCounts[o.id]),
        });
        // Each dispatch is applied as it returns, so the board empties order by order
        // instead of sitting still until the whole run finishes and then reloading.
        applyOrderToCache(qc, order);
      }
      invalidateDerivedOrderData(qc);
      toast.show(t("orders.load-board.toast-success", { count: String(readyToDispatch.length) }), "success");
      setVehicle("");
      setDriverName("");
      setCrateCounts({});
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("orders.load-board.error");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-floor">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold text-united-dark">{t("orders.load-board-title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>

      {isLoading && <BoardSkeleton />}
      {isError && <ErrorState message={errorMessage(queryError)} onRetry={() => refetch()} />}
      {!isLoading &&
        !isError &&
        active.length === 0 &&
        readyToDispatch.length === 0 &&
        upcoming.length === 0 && <EmptyState icon="👍" title={t("orders.load-board.empty")} />}

      {active.length > 0 && (
        <div className="mt-3">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-united-muted"><span aria-hidden className="h-2 w-2 rounded-full bg-united-green" />{t("orders.load-board.active-header")} <span className="font-normal">({active.length})</span></h2>
          <div className="flex flex-col gap-3">
            {active.map((o) => (
              <OrderCard key={o.id} order={o} />
            ))}
          </div>
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-extrabold text-united-muted mb-2">{t("orders.load-board.upcoming-header")}</h2>
          <div className="flex flex-col gap-3 opacity-80">
            {upcoming.map((o) => (
              <OrderCard key={o.id} order={o} />
            ))}
          </div>
        </div>
      )}

      {readyToDispatch.length > 0 && (
        <div className="mt-8 card p-5">
          <h2 className="section-title mb-3 flex items-center gap-2"><Truck size={20} className="text-united-green" aria-hidden />{t("orders.load-board.vehicle-section")}</h2>
          <ul className="flex flex-col gap-2 mb-4">
            {readyToDispatch.map((o) => (
              <li key={o.id} className="flex items-center gap-2">
                <CheckCircle2 size={20} className="shrink-0 text-united-green" aria-hidden />
                <span className="font-bold flex-1 min-w-0 truncate">{o.customerName}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder={t("orders.load-board.crate-count-placeholder")}
                  value={crateCounts[o.id] ?? ""}
                  onChange={(e) => setCrateCounts((c) => ({ ...c, [o.id]: e.target.value }))}
                  className="w-20 tap-target border-2 border-united-dark/10 rounded-lg px-2 text-center focus:border-united-green outline-none shrink-0"
                />
              </li>
            ))}
          </ul>
          <p className="mb-3 font-bold text-united-dark">{t("orders.load-board.total-orders")}: {readyToDispatch.length}</p>
          <input
            placeholder={t("orders.load-board.driver-placeholder")}
            value={driverName}
            onChange={(e) => setDriverName(e.target.value)}
            className="field mb-3"
          />
          <input
            placeholder={t("orders.load-board.vehicle-placeholder")}
            value={vehicle}
            onChange={(e) => setVehicle(e.target.value)}
            className="field mb-3"
          />
          {error && <p className="text-united-danger font-bold mb-2">{error}</p>}
          <button disabled={busy || !canDispatch} onClick={dispatchAll} className="btn-dark w-full text-xl">
            {t("orders.load-board.dispatch-btn")}
          </button>
        </div>
      )}
    </div>
  );
}
