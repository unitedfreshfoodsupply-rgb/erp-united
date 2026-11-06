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
import { orderCustomerName } from "@/lib/locale/names";
import { Field } from "@/components/ui/Field";
import { deliverySlot } from "@/lib/format";

const URGENCY_RANK = { late: 0, soon: 1, ok: 2, none: 3 } as const;

export function LoadBoard() {
  const dialogs = useDialogs();
  const ops = useOperationalSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const [vehicle, setVehicle] = useState("");
  const [driverName, setDriverName] = useState("");
  const [crateCounts, setCrateCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Dispatch-all runs the orders one after another (PC-7): which one is going out now.
  const [progress, setProgress] = useState<{ current: number; total: number; order: string } | null>(null);
  const progressText = progress ? t("orders.load-board.dispatch-progress", { current: String(progress.current), total: String(progress.total), order: progress.order }) : null;
  // The same text for the button, with the order number kept on one line (FLOOR-4).
  const progressParts = progress ? t("orders.load-board.dispatch-progress", { current: String(progress.current), total: String(progress.total), order: "\u0001" }).split("\u0001") : null;

  // Fetch every non-final order so a brand-new order is visible here the instant it
  // arrives (read-only until it's actually ready to load), not just once it reaches
  // ready_for_loading — the loader tablet should show the same live picture as everyone else.
  const { data, isLoading, isError, error: queryError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["orders", "load"],
    queryFn: () =>
      apiFetch<{ orders: OrderDTO[] }>(
        "/api/orders?status=new,preparing,ready_for_loading,loading,loaded&stock=ok"
      ),
    refetchInterval: 3000,
    // A wall screen that chimes: keeps polling while its tab is hidden (app/providers.tsx).
    refetchIntervalInBackground: true,
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
  const missingCrates = readyToDispatch.filter((o) => !(Number(crateCounts[o.id]) > 0)).length;
  const canDispatch =
    vehicle.trim() &&
    driverName.trim() &&
    readyToDispatch.length > 0 &&
    missingCrates === 0;
  // Why "vehicle ready" is still grey (FLOOR-9), as the grading form says it (UXO-11).
  const blockedBy = busy
    ? []
    : [
        missingCrates > 0 ? t("orders.load-board.needs-crates", { count: String(missingCrates) }) : null,
        !driverName.trim() ? t("orders.load-board.needs-driver") : null,
        !vehicle.trim() ? t("orders.load-board.needs-vehicle") : null,
      ].filter((x): x is string => !!x);

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
    const total = readyToDispatch.length;
    let done = 0;
    let current: OrderDTO | null = null;
    try {
      for (const o of readyToDispatch) {
        current = o;
        setProgress({ current: done + 1, total, order: o.orderNumber });
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
        done++;
      }
      invalidateDerivedOrderData(qc);
      toast.show(t("orders.load-board.toast-success", { count: String(total) }), "success");
      setVehicle("");
      setDriverName("");
      setCrateCounts({});
    } catch (err) {
      // The run stops at the first refusal, as before; the message now says which order
      // stopped it and how many had already left. Vehicle, driver and crates stay filled.
      // The server's version number is for the log, not for the loader (FLOOR-4).
      const reason = err instanceof ApiClientError ? err.message.replace(/\s*\((?:نسخة الطلب|request version): \d+\)\s*$/, "") : t("orders.load-board.error");
      const msg = current
        ? t("orders.load-board.dispatch-failed", {
            order: current.orderNumber,
            customer: orderCustomerName(current, locale === "en" ? "en" : "ar"),
            done: String(done),
            total: String(total),
            reason,
          })
        : reason;
      setError(msg);
      if (done > 0) {
        invalidateDerivedOrderData(qc);
        toast.show(t("orders.load-board.toast-partial", { done: String(done), total: String(total) }), "error");
      } else {
        toast.show(msg, "error");
      }
      // A refusal usually means the board is behind (another tablet moved the order): fetch now
      // instead of waiting for the next poll, so a retry sends the current versions.
      void refetch();
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="page-floor">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold text-united-dark">{t("orders.load-board-title")}</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} stale={isError && !!data} />
      </div>

      {isLoading && <BoardSkeleton />}
      {/* A failed background poll keeps the list it had (PM-4); the error shows only when
          there is nothing to show. */}
      {isError && !data && <ErrorState message={errorMessage(queryError)} onRetry={() => refetch()} />}
      {data &&
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
          {/* "Not ready yet" is a muted panel around full-contrast cards, not dimmed text
              (FLOOR-7: opacity took the cards' text below 4.5:1). */}
          <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-united-border-strong bg-united-subtle p-2 sm:p-3">
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
            {readyToDispatch.map((o) => {
              const customer = orderCustomerName(o, locale === "en" ? "en" : "ar");
              return (
                <li key={o.id} className="flex items-center gap-2">
                  <CheckCircle2 size={20} className="shrink-0 text-united-green" aria-hidden />
                  {/* The order number and time tell one customer's orders apart (FLOOR-4). */}
                  <span className="flex-1 min-w-0">
                    <span className="block font-bold truncate">{customer}</span>
                    <span className="block text-xs text-united-muted truncate">
                      <span dir="ltr" className="whitespace-nowrap">{o.orderNumber}</span>
                      {" · "}
                      {deliverySlot(o.deliveryDate, o.deliveryTime, locale === "en" ? "en" : "ar")}
                    </span>
                  </span>
                  <label className="flex shrink-0 items-center gap-1 text-xs font-semibold text-united-muted">
                    <input
                      type="number"
                      inputMode="numeric"
                      value={crateCounts[o.id] ?? ""}
                      onChange={(e) => setCrateCounts((c) => ({ ...c, [o.id]: e.target.value }))}
                      aria-label={t("orders.load-board.crate-count-for", { order: o.orderNumber, customer })}
                      className="w-20 tap-target border-2 border-united-field rounded-lg px-2 text-center focus:border-united-green focus:ring-2 focus:ring-united-green/25 outline-none"
                    />
                    <span aria-hidden>{t("orders.load-board.crate-count-placeholder")}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mb-3 font-bold text-united-dark">{t("orders.load-board.total-orders")}: {readyToDispatch.length}</p>
          <Field label={t("orders.load-board.driver-placeholder")} className="mb-3">
            <input value={driverName} onChange={(e) => setDriverName(e.target.value)} className="field" autoComplete="off" />
          </Field>
          <Field label={t("orders.load-board.vehicle-placeholder")} className="mb-3">
            <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} className="field" autoComplete="off" />
          </Field>
          {error && <p role="alert" className="text-united-danger font-bold mb-2">{error}</p>}
          <button disabled={busy || !canDispatch} onClick={dispatchAll} aria-describedby={blockedBy.length > 0 ? "dispatch-blocked-hint" : undefined} className="btn-dark w-full text-xl">
            {progressParts ? (
              <span>
                {progressParts[0]}
                <span dir="ltr" className="whitespace-nowrap">{progress?.order}</span>
                {progressParts[1]}
              </span>
            ) : (
              t("orders.load-board.dispatch-btn")
            )}
          </button>
          {blockedBy.length > 0 && (
            <ul id="dispatch-blocked-hint" className="mt-2 text-xs font-bold text-united-muted">
              {blockedBy.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          {/* Announced from a status region beside the button, not from the control itself. */}
          <span role="status" className="sr-only">{progressText ?? ""}</span>
        </div>
      )}
    </div>
  );
}
