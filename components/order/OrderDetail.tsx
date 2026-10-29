"use client";

import { useState } from "react";
import { AlertTriangle, ArrowLeft, Clock, OctagonAlert, StickyNote } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import type { OrderDTO, OrderItemDTO } from "@/lib/client-types";
import { usePermissions } from "@/lib/use-session";
import { homePathFor } from "@/lib/nav";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import { OrderPricingPanel } from "@/components/sales/OrderPricingPanel";
import { ItemRow } from "@/components/order/ItemRow";
import { DispatchButton } from "@/components/order/DispatchButton";
import { ReasonAction } from "@/components/ReasonAction";
import { CloneOrderAction } from "@/components/order/CloneOrderAction";
import { ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useToast } from "@/components/ui/Toast";
import { orderUrgency, STATUS_LABEL, STATUS_LABEL_EN } from "@/lib/orderPresentation";
import { nextAction, rollUpQuantities, stageOf, STATUS_MEANING, STATUS_MEANING_EN } from "@/lib/orderSummary";
import { deliverySlot, qty as qtyLabel, orDash, unitLabel } from "@/lib/format";
import { ORDER_STATUSES } from "@/lib/types";
import type { OrderStatus } from "@/lib/types";
import { invalidateDerivedOrderData } from "@/lib/queryInvalidation";
import { applyOrderToCache, applyOrderItemToCache, cachedOrderFromLists } from "@/lib/orderCache";
import { OrderDetailSkeleton } from "@/components/order/OrderDetailSkeleton";
import { useOperationalSettings } from "@/lib/use-operational-settings";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

// Map order source → translation key
const SOURCE_TKEY: Record<string, string> = {
  n8n: "orders.source.n8n",
  hermes: "orders.source.hermes",
  manual: "orders.source.manual",
  system: "orders.source.system",
  user: "orders.source.user",
};

export function OrderDetail({ orderId }: { orderId: string }) {
  const { t, locale } = useLocale();
  const ops = useOperationalSettings();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, permissions } = usePermissions();
  const [error, setError] = useState<string | null>(null);
  // A SET of in-flight action ids, not a single one. The old single-slot version meant
  // confirming item A also disabled item B — on a six-line order that serialises the
  // whole screen behind one request. A repeat of the SAME id is still ignored, which is
  // what actually guards against a double-tap.
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const isBusy = (id: string) => busyIds.has(id);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    customer_account_id: "",
    customer_name: "",
    delivery_date: "",
    delivery_time: "",
    notes: "",
    reason: "",
  });
  const [overrideTo, setOverrideTo] = useState<OrderStatus | "">("");
  const [overrideReason, setOverrideReason] = useState("");

  // The board the user just tapped through from already holds this order in full, so
  // render it immediately instead of showing a spinner for data we have. Marking it as
  // stale (updatedAt 0) means the real fetch still runs in the background and replaces
  // it — this removes the spinner, not the refresh.
  const seeded = cachedOrderFromLists(qc, orderId);

  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => apiFetch<{ order: OrderDTO }>(`/api/orders/${orderId}`),
    refetchInterval: 5000,
    ...(seeded ? { initialData: { order: seeded }, initialDataUpdatedAt: 0 } : {}),
  });
  const order = data?.order;
  const customerCards = useQuery({
    queryKey: ["sales", "customers", "", true],
    queryFn: () => apiFetch<{ customers: { id: string; code: string; name: string; nameAr: string | null; active: boolean }[] }>("/api/sales/customers?q=&include_inactive=1"),
    enabled: can("sales.customers.view"),
    staleTime: 60_000,
  });

  /**
   * Run one action and apply its result.
   *
   * The endpoints already return the updated order (or item), so the screen is brought
   * up to date from that response — no refetch, no spinner, and the data is the
   * server's, not an optimistic guess. Only the derived views (production totals, the
   * report, the timeline) are marked stale afterwards, and that is not awaited.
   */
  async function run(
    id: string,
    fn: () => Promise<{ order?: OrderDTO; item?: OrderItemDTO } | void>,
    successMsg?: string
  ): Promise<void> {
    if (busyIds.has(id)) return; // same action already in flight — ignore the double tap
    setError(null);
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const result = await fn();
      if (result && "order" in result && result.order) {
        applyOrderToCache(qc, result.order);
      } else if (result && "item" in result && result.item) {
        applyOrderItemToCache(qc, orderId, result.item);
      }
      invalidateDerivedOrderData(qc, orderId);
      if (successMsg) toast.show(successMsg, "success");
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("orders.error.generic");
      setError(msg);
      toast.show(msg, "error");
      // The cache may now disagree with the server (a 409 means someone else moved
      // first) — pull the truth rather than leaving a stale screen.
      void qc.invalidateQueries({ queryKey: ["order", orderId] });
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  if (isLoading && !order) return <OrderDetailSkeleton />;
  // Only replace the whole screen when there is truly nothing to show yet. React
  // Query keeps the last-good `order` in cache across a failed poll, and every other
  // board in the app (PrepBoard, LoadBoard, SupervisorBoard...) keeps rendering that
  // stale-but-valid data under an error banner rather than blanking the screen — this
  // is the one place a preparer/loader is actively tapping through item by item, so a
  // brief Wi-Fi blip must not make the action buttons disappear mid-task.
  if (!order) return <ErrorState message={t("orders.error.open_failed")} onRetry={() => refetch()} />;

  // Same landing rule as the header: derived from what this account can reach, so
  // "back" never lands on a page it is about to be refused from.
  const backHref = homePathFor(permissions);
  const urgency = orderUrgency(order.status, order.deliveryDate, order.deliveryTime, ops.deliverySoonMinutes);
  // Affordances follow effective permissions, never the role name — otherwise a role
  // that holds the permission (SUPER_ADMIN) or an account granted it by an override
  // would be shown no controls for something the server would happily accept.
  const canPrep = can("orders.prepare");
  const canLoad = can("orders.load");
  const isSupervisor = can("orders.edit");

  const roll = rollUpQuantities(order.items);
  const stage = stageOf(order.status);
  const action = nextAction(order, locale === "en" ? "en" : "ar");
  const preparedCount = order.items.filter((i) => i.preparationStatus === "done").length;
  const loadedCount = order.items.filter((i) => i.loadingStatus === "done").length;
  const allPrepared = preparedCount === order.items.length;
  const allLoaded = loadedCount === order.items.length;
  const showLoadProgress = ["loading", "loaded", "dispatched"].includes(order.status);

  function startEditing() {
    setEditForm({
      customer_account_id: order!.customerAccountId ?? "",
      customer_name: order!.customerName,
      delivery_date: order!.deliveryDate,
      delivery_time: order!.deliveryTime ?? "",
      notes: order!.notes ?? "",
      reason: "",
    });
    setEditing(true);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editForm.reason.trim()) {
      setError(t("orders.edit.required_reason"));
      return;
    }
    await run(
      "edit",
      () =>
        apiPatch(`/api/orders/${orderId}`, {
          customer_name: editForm.customer_name,
          customer_account_id: editForm.customer_account_id,
          delivery_date: editForm.delivery_date,
          delivery_time: editForm.delivery_time,
          notes: editForm.notes,
          reason: editForm.reason,
          expected_version: order!.version,
        }),
      t("orders.edit.save_success")
    );
    setEditing(false);
  }

  async function submitOverride() {
    if (!overrideTo || !overrideReason.trim()) return;
    await run(
      "override",
      () =>
        apiPost(`/api/orders/${orderId}/status`, {
          to: overrideTo,
          reason: overrideReason,
          expected_version: order!.version,
        }),
      t("orders.status.changed")
    );
    setOverrideTo("");
    setOverrideReason("");
  }

  // Sticky primary action for this stage, if any — kept in one place so it's
  // always in the same spot at the bottom, one-tap reachable on a tablet.
  let stickyAction: React.ReactNode = null;
  if (isSupervisor && order.needsReview) {
    // The supervisor is the one who can actually unblock this order — put the
    // approval control itself in the sticky slot instead of the disabled
    // preparer/loader button, which just says "ask the supervisor" while the
    // supervisor is the one looking at it.
    stickyAction = (
      <ReasonAction
        label={t("orders.approve_team")}
        confirmLabel={t("orders.approve_confirm")}
        className="btn-dark w-full text-xl !bg-united-danger"
        onConfirm={(reason) =>
          run(
            "approve",
            () => apiPost(`/api/orders/${orderId}/approve`, { reason, expected_version: order.version }),
            t("orders.approval.success")
          )
        }
      />
    );
  } else if (canPrep && order.status === "new") {
    stickyAction = (
      <button
        disabled={isBusy("start-prep")}
        onClick={() =>
          run(
            "start-prep",
            () =>
              apiPost(`/api/orders/${orderId}/status`, {
                to: "preparing",
                expected_version: order.version,
              }),
            t("orders.start.prep.success")
          )
        }
        className="btn-primary w-full text-xl"
      >
        {t("orders.start_prep_button")}
      </button>
    );
  } else if (canPrep && order.status === "preparing") {
    stickyAction = (
      <button
        disabled={!allPrepared || order.needsReview || isBusy("finish-prep")}
        onClick={() =>
          run(
            "finish-prep",
            async () => {
              await apiPost(`/api/orders/${orderId}/status`, {
                to: "ready_for_loading",
                expected_version: order.version,
              });
              router.push(backHref);
            },
            t("orders.finish.prep.ready_loading")
          )
        }
        className="btn-dark w-full text-xl"
      >
        {order.needsReview
          ? t("orders.needs_supervisor_review")
          : !allPrepared
          ? t("orders.remaining_items", { count: order.items.length - preparedCount })
          : t("orders.finish_prep_checkmark")}
      </button>
    );
  } else if (canLoad && order.status === "ready_for_loading") {
    stickyAction = (
      <button
        disabled={isBusy("start-load")}
        onClick={() =>
          run(
            "start-load",
            () =>
              apiPost(`/api/orders/${orderId}/status`, {
                to: "loading",
                expected_version: order.version,
              }),
            t("orders.load.started")
          )
        }
        className="btn-primary w-full text-xl"
      >
        {t("orders.start_load_button")}
      </button>
    );
  } else if (canLoad && order.status === "loading") {
    stickyAction = (
      <button
        disabled={!allLoaded || order.needsReview || isBusy("finish-load")}
        onClick={() =>
          run(
            "finish-load",
            () => apiPost(`/api/orders/${orderId}/status`, { to: "loaded", expected_version: order.version }),
            t("orders.loaded")
          )
        }
        className="btn-dark w-full text-xl"
      >
        {order.needsReview
          ? t("orders.needs_supervisor_review")
          : !allLoaded
          ? t("orders.remaining_items", { count: order.items.length - loadedCount })
          : t("orders.finish_load_checkmark")}
      </button>
    );
  } else if (canLoad && order.status === "loaded") {
    stickyAction = (
      <DispatchButton
        busy={isBusy("dispatch")}
        onConfirm={({ vehicle, driverName, crateCount }) =>
          run(
            "dispatch",
            () =>
              apiPost(`/api/orders/${orderId}/status`, {
                to: "dispatched",
                expected_version: order.version,
                vehicle,
                driver_name: driverName,
                crate_count: crateCount,
              }),
            // Deliberately stay on the order after dispatch — it's the moment the
            // print/dispatch sheet is needed for the driver's signature, and once
            // dispatched this order drops off the loader's own board entirely, so
            // this may be the last easy chance to reach it.
            t("orders.dispatch.success")
          )
        }
      />
    );
  }

  return (
    <div className="page-container max-w-2xl">
      <div className="flex items-center justify-between mb-3">
        <Link
          href={backHref}
          dir="auto"
          className="inline-flex min-h-[44px] items-center gap-1.5 font-medium text-united-muted hover:text-united-dark"
        >
          <ArrowLeft size={16} className="rtl:rotate-180" aria-hidden /> {t("orders.back")}
        </Link>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>

      {isError && (
        <div className="card p-3 mb-3 border-s-4 !border-s-united-warn flex items-center justify-between gap-2" role="alert">
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-united-warn">
            <AlertTriangle size={16} aria-hidden /> {t("orders.error.refresh")}
          </p>
          <button onClick={() => refetch()} className="btn-secondary text-xs px-3 shrink-0">
            {t("orders.action.retry")}
          </button>
        </div>
      )}

      {/* Header / operational record */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h1 className="text-2xl font-extrabold text-united-dark">{order.customerName}</h1>
          <StatusBadge status={order.status} />
        </div>
        {/* What the stage actually means, not just its name. */}
        <p className="text-sm font-bold text-united-muted mb-2">{(locale === "en" ? STATUS_MEANING_EN : STATUS_MEANING)[order.status]}</p>

        <p className="text-united-green font-bold mb-2">
          {t("orders.delivery_slot")} {deliverySlot(order.deliveryDate, order.deliveryTime, locale === "en" ? "en" : "ar")}
        </p>

        {/* Reference data: identifiers are secondary to the operational facts above. */}
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-united-muted mb-3">
          <div className="flex gap-1">
            <dt>{t("orders.reference.number")}</dt>
            <dd dir="ltr" className="font-bold text-united-dark/70">{order.orderNumber}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t("orders.reference.external")}</dt>
            <dd dir="ltr" className="font-bold text-united-dark/70">{orDash(order.externalId, t("orders.empty"))}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t("orders.reference.source")}</dt>
            <dd className="font-bold text-united-dark/70">{SOURCE_TKEY[order.source] ? t(SOURCE_TKEY[order.source] as Parameters<typeof t>[0]) : order.source}</dd>
          </div>
        </dl>

        {/* The three numbers that matter, rolled up across every line. */}
        <div className="grid grid-cols-3 gap-2 text-center mb-3">
          <SummaryFigure label={t("orders.label.required")} value={qtyLabel(roll.required)} unit={roll.singleUnit} />
          <SummaryFigure label={t("orders.label.prepared")} value={qtyLabel(roll.prepared)} unit={roll.singleUnit} tone="green" />
          <SummaryFigure
            label={stage === "load" || stage === "done" ? t("orders.load") : t("orders.label.remaining_prep")}
            value={qtyLabel(stage === "load" || stage === "done" ? roll.loaded : roll.remainingToPrepare)}
            unit={roll.singleUnit}
            tone={stage === "load" || stage === "done" ? "green" : roll.remainingToPrepare > 0 ? "warn" : "green"}
          />
        </div>

        {/* What has to happen next, stated once, at the top. */}
        <div className="rounded-xl bg-united-dark/[0.04] px-4 py-3 mb-3">
          <div className="text-[11px] font-extrabold text-united-muted">{t("orders.now")}</div>
          <div
            className={`font-extrabold ${
              action.tone === "blocked" ? "text-united-danger" : "text-united-dark"
            }`}
          >
            {action.label}
            {action.owner !== "—" && (
              <span className="text-xs font-bold text-united-muted"> · {action.owner}</span>
            )}
          </div>
        </div>

        {order.notes && <p className="mb-1 flex items-start gap-1.5 text-sm text-united-dark/80"><StickyNote size={15} className="mt-0.5 shrink-0 text-united-muted" aria-hidden />{order.notes}</p>}
        {order.vehicle && (
          <p className="text-united-dark/70 text-sm mb-1">
            {/* Vehicle and driver are typed data in either script; <bdi> keeps each value in
                place inside the sentence instead of letting it reorder its neighbours. */}
            {t("orders.vehicle_label")} <bdi>{order.vehicle}</bdi>
            {order.driverName && <>{` ${t("orders.driver_label")} `}<bdi>{order.driverName}</bdi></>}
            {order.crateCount != null && ` ${t("orders.crates_label", { count: order.crateCount })}`}
          </p>
        )}

        <div className="flex flex-col gap-2 mt-3">
          <ProgressBar label={t("orders.prep_bar")} done={preparedCount} total={order.items.length} />
          {showLoadProgress && (
            <ProgressBar label={t("orders.load")} done={loadedCount} total={order.items.length} tone="orange" />
          )}
        </div>

        <div className="flex flex-wrap gap-2 mt-3 border-t border-united-border pt-3">
          {isSupervisor && (
            <a
              href={`/orders/${orderId}/print/delivery${locale === "en" ? "?lang=en" : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-sm px-3 py-2"
            >
              {t("orders.print.delivery_doc")}
            </a>
          )}
          {canPrep && (
            <a
              href={`/orders/${orderId}/print/picking${locale === "en" ? "?lang=en" : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-sm px-3 py-2"
            >
              {t("orders.print.picking")}
            </a>
          )}
          {canLoad && (
            <a
              href={`/orders/${orderId}/print/dispatch${locale === "en" ? "?lang=en" : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-sm px-3 py-2"
            >
              {t("orders.print.dispatch_sheet")}
            </a>
          )}
        </div>
      </div>

      {(urgency === "late" || urgency === "soon") && (
        <p
          className={`mt-3 flex items-center gap-2 rounded-lg border p-3 font-semibold ${
            urgency === "late" ? "border-[#F5C6C1] bg-[#FFF7F6] text-united-danger" : "border-[#F3D9AE] bg-[#FFFBF3] text-united-warn"
          }`}
        >
          <Clock size={18} aria-hidden />
          {urgency === "late" ? t("order.past-due") : t("order.due-soon")}
        </p>
      )}

      {order.needsReview && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-[#F5C6C1] bg-[#FFF7F6] p-3 font-semibold text-united-danger" role="alert">
          <OctagonAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          {t("orders.review_needed")}
        </p>
      )}

      {error && <p className="bg-red-50 text-united-danger font-bold rounded-xl p-3 mt-3">{error}</p>}

      {/* Items */}
      <div className="mt-4">
        <h2 className="font-extrabold text-united-dark mb-2">
          {t("orders.items_title")} <span className="text-united-muted font-bold">({order.items.length})</span>
        </h2>
        <div className="flex flex-col gap-3">
          {order.items.map((item) => {
            let mode: "display" | "prepare" | "load" = "display";
            if (canPrep && order.status === "preparing") mode = "prepare";
            if (canLoad && order.status === "loading") mode = "load";

            return (
              <ItemRow
                key={item.id}
                item={item}
                mode={mode}
                busy={isBusy(item.id)}
                onConfirm={async (qty) => {
                  await run(item.id, () =>
                    apiPost(
                      `/api/orders/${orderId}/items/${item.id}/${mode === "prepare" ? "prepare" : "load"}`,
                      { quantity: qty, mark_done: true, expected_version: item.version }
                    )
                  );
                }}
                supervisorEdit={
                  isSupervisor
                    ? {
                        onSave: (qty, reason) =>
                          run(`req-${item.id}`, () =>
                            apiPost(`/api/orders/${orderId}/items/${item.id}/required`, {
                              quantity: qty,
                              reason,
                              expected_version: item.version,
                            })
                          ),
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>

      {/* Supervisor panel */}
      {isSupervisor && (
        <div className="card p-5 mt-4 flex flex-col gap-3">
          <h2 className="font-extrabold text-united-dark">{t("orders.supervisor_actions")}</h2>

          {!editing ? (
            <button onClick={startEditing} className="btn-secondary self-start text-sm">
              {t("orders.edit_btn")}
            </button>
          ) : (
            <form onSubmit={saveEdit} className="flex flex-col gap-2 bg-united-dark/5 rounded-xl p-3">
              <select
                value={editForm.customer_account_id}
                onChange={(e) => {
                  const customer = customerCards.data?.customers.find((c) => c.id === e.target.value);
                  setEditForm((f) => ({
                    ...f,
                    customer_account_id: e.target.value,
                    customer_name: customer?.nameAr ?? customer?.name ?? "",
                  }));
                }}
                className="field"
              >
                <option value="">{t("orders.customer.choose")}</option>
                {customerCards.data?.customers.map((c) => (
                  <option key={c.id} value={c.id}>{localName(c, locale)}{!c.active ? ` ${t("orders.customer.inactive")}` : ""}</option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2">
                <input
                  type="date"
                  value={editForm.delivery_date}
                  onChange={(e) => setEditForm((f) => ({ ...f, delivery_date: e.target.value }))}
                  className="field flex-1"
                />
                <input
                  type="time"
                  value={editForm.delivery_time}
                  onChange={(e) => setEditForm((f) => ({ ...f, delivery_time: e.target.value }))}
                  className="field flex-1"
                />
              </div>
              <input
                value={editForm.notes}
                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder={t("orders.edit.notes_placeholder")}
                className="field"
              />
              <input
                value={editForm.reason}
                onChange={(e) => setEditForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder={t("orders.edit.reason_placeholder")}
                className="field"
              />
              <div className="flex gap-2">
                <button disabled={isBusy("edit")} className="btn-primary flex-1">
                  {t("orders.edit.save")}
                </button>
                <button type="button" onClick={() => setEditing(false)} className="btn-secondary">
                  {t("orders.edit.cancel")}
                </button>
              </div>
            </form>
          )}

          {/* Approval itself lives in the sticky bar below (it's the primary action
              when needed) — this row only holds the less urgent supervisor actions. */}
          <div className="flex flex-wrap gap-2">
            {order.status !== "cancelled" && order.status !== "dispatched" && (
              <ReasonAction
                label={t("orders.cancel_btn")}
                className="btn-danger text-sm px-4 py-2"
                onConfirm={(reason) =>
                  run(
                    "cancel",
                    () => apiPost(`/api/orders/${orderId}/cancel`, { reason, expected_version: order.version }),
                    t("orders.loaded")
                  )
                }
              />
            )}
            {(order.status === "cancelled" || order.status === "loaded" || order.status === "dispatched") && (
              <ReasonAction
                label={t("orders.reopen_btn")}
                className="btn-secondary text-sm px-4 py-2"
                onConfirm={(reason) =>
                  run(
                    "reopen",
                    () =>
                      apiPost(`/api/orders/${orderId}/reopen`, {
                        to: "preparing",
                        reason,
                        expected_version: order.version,
                      }),
                    t("orders.reopened")
                  )
                }
              />
            )}
            <CloneOrderAction orderId={orderId} />
          </div>

          <details className="border-t border-united-border pt-3">
            <summary className="text-sm font-bold text-united-muted cursor-pointer">
              {t("orders.override_header")}
            </summary>
            <div className="flex flex-col gap-2 mt-2">
              <select
                value={overrideTo}
                onChange={(e) => setOverrideTo(e.target.value as OrderStatus)}
                className="field"
              >
                <option value="">{t("orders.override_choose_status")}</option>
                {ORDER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {(locale === "en" ? STATUS_LABEL_EN : STATUS_LABEL)[s]}
                  </option>
                ))}
              </select>
              <input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder={t("orders.override_reason_placeholder")}
                className="field"
              />
              <button
                disabled={!overrideTo || !overrideReason.trim() || isBusy("override")}
                onClick={submitOverride}
                className="btn-dark"
              >
                {t("orders.override_execute")}
              </button>
            </div>
          </details>
        </div>
      )}

      <div className="card p-5 mt-4">
        <h2 className="font-extrabold mb-2 text-united-dark">{t("orders.documents")}</h2>
        <OrderPricingPanel orderId={orderId} />
        <AttachmentsPanel entityType="order" entityId={orderId} canManage={isSupervisor} />
      </div>

      <div className="card p-5 mt-4">
        <h2 className="font-extrabold mb-2 text-united-dark">{t("orders.timeline")}</h2>
        <Timeline orderId={orderId} />
      </div>

      {stickyAction && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t-2 border-united-green/20 p-4 z-10">
          <div className="max-w-2xl mx-auto">{stickyAction}</div>
        </div>
      )}
    </div>
  );
}

/** One rolled-up figure in the order header. */
function SummaryFigure({
  label,
  value,
  unit,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit: string | null;
  tone?: "neutral" | "green" | "warn";
}) {
  const toneClass = { neutral: "text-united-dark", green: "text-united-green", warn: "text-united-warn" }[tone];
  return (
    <div className="rounded-xl bg-united-dark/[0.03] py-2">
      <div className="text-[11px] font-bold text-united-muted">{label}</div>
      <div dir="ltr" className={`text-xl font-extrabold ${toneClass}`}>
        {value}
        {unit && <span className="text-[10px] font-bold text-united-dark/40"> {unitLabel(unit)}</span>}
      </div>
    </div>
  );
}
