"use client";

import { useEffect, useState } from "react";
import { systemText } from "@/lib/locale/system-text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtQty } from "@/components/stock/inventory/shared";
import { Segmented } from "@/components/ui/Segmented";
import { Snowflake } from "lucide-react";
import { useLocale } from "@/lib/locale";

/**
 * Distribution: trips (plan → load → dispatch → deliver), delivery results, the
 * exception list and the fleet. Quantities only — no prices anywhere on this screen.
 * Each action is shown to whoever may take it; the server enforces the same.
 */

type Tab = "trips" | "exceptions" | "fleet";
// Hooks cannot run at module scope (doing so crashed this page with a 500): callers
// pass their own `t`, and the maps below hold dictionary keys translated at render.
const fail = (toast: ReturnType<typeof useToast>, err: unknown, t: (key: string) => string) =>
  toast.show(err instanceof ApiClientError && err.message ? err.message : t("ui.error"), "error");
const fallbackKey = (key: string) => key;

const TRIP_STATUS: Record<string, { label: string; cls: string }> = {
  planned: { label: fallbackKey("ops.trip.status.planned"), cls: "bg-united-dark/5" },
  loading: { label: fallbackKey("ops.trip.status.loading"), cls: "bg-united-warn/10 text-united-warn" },
  loaded: { label: fallbackKey("ops.trip.status.loaded"), cls: "bg-blue-50 text-blue-700" },
  dispatched: { label: fallbackKey("ops.trip.status.dispatched"), cls: "bg-blue-50 text-blue-700" },
  in_transit: { label: fallbackKey("ops.trip.status.in_transit"), cls: "bg-blue-50 text-blue-700" },
  completed: { label: fallbackKey("ops.trip.status.completed"), cls: "bg-united-green/10 text-united-green" },
  cancelled: { label: fallbackKey("ops.trip.status.cancelled"), cls: "bg-united-danger/10 text-united-danger" },
};
const STOP_STATUS: Record<string, string> = { pending: fallbackKey("ops.stop.pending"), delivered: fallbackKey("ops.stop.delivered"), partial: fallbackKey("ops.stop.partial"), failed: fallbackKey("ops.stop.failed") };
const EX_TYPE: Record<string, string> = { shortage: fallbackKey("ops.exception.shortage"), damage: fallbackKey("ops.exception.damage"), rejection: fallbackKey("ops.exception.rejection"), delivery_failure: fallbackKey("ops.exception.delivery_failure"), loading_discrepancy: fallbackKey("ops.exception.loading_discrepancy") };

type Fleet = { vehicles: { id: string; code: string; plate: string; type: string; capacityKg: string | null; refrigerated: boolean; active: boolean; version: number }[]; drivers: { id: string; name: string; phone: string | null; active: boolean; version: number }[] };
type TripRow = { id: string; number: string; status: string; tripDate: string; vehicle: { code: string; plate: string; refrigerated: boolean }; driver: { name: string }; stops: number; delivered: number };
type Item = { id: string; productName: string; unit: string; requiredQuantity: number; preparedQuantity: number | null; loadedQuantity: number | null; shippedQty: string };
type Stop = { id: string; sequence: number; orderId: string; status: string; crateCount: number | null; receiverName: string | null; failureReason: string | null; recordedBy: string | null; lines: { orderItemId: string; deliveredQty: string; shortageQty: string; damagedQty: string; rejectedQty: string }[]; order: { id: string; orderNumber: string; customerName: string; status: string; crateCount: number | null; items: Item[] } };
type TripDetail = { id: string; number: string; status: string; tripDate: string; notes: string | null; cancelReason: string | null; version: number; vehicle: Fleet["vehicles"][number]; driver: Fleet["drivers"][number]; stops: Stop[] };

export function OperationsView() {
  const { can } = usePermissions();
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("trips");
  useEffect(() => {
    const t2 = new URLSearchParams(window.location.search).get("tab");
    if (t2 === "exceptions" || t2 === "fleet") setTab(t2 as Tab);
  }, []);
  return (
    <div className="page-container">
      <h1 className="page-title">{t("ops.title")}</h1>
      <Tabs value={tab} onChange={(v: string) => setTab(v as Tab)} items={((): Array<{ key: string; label: string }> => [
        { key: "trips", label: t("ops.trips") },
        { key: "exceptions", label: t("ops.tab.exceptions") },
        ...(can("operations.trips.manage") ? [{ key: "fleet" as Tab, label: t("ops.tab.fleet") }] : []),
      ])()} />
      {tab === "trips" ? <Trips /> : tab === "exceptions" ? <Exceptions /> : <FleetView />}
    </div>
  );
}

const useFleet = () => useQuery({ queryKey: ["ops", "fleet"], queryFn: () => apiFetch<Fleet>("/api/operations/fleet") });

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

function Trips() {
  const { can } = usePermissions();
  const { t } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ["ops", "trips", all], queryFn: () => apiFetch<{ trips: TripRow[] }>(`/api/operations/trips${all ? "" : "?open=1"}`) });
  if (open) return <TripView id={open} onClose={() => setOpen(null)} />;
  if (creating) return <NewTrip onDone={(id) => { setCreating(false); if (id) setOpen(id); }} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <div className="flex-1"><Segmented value={all ? "all" : "open"} onChange={(v) => setAll(v === "all")} items={[{ key: "open", label: t("ops.tab.open") }, { key: "all", label: t("ops.tab.all") }]} /></div>
        {can("operations.trips.manage") && <button type="button" className="btn-primary shrink-0" onClick={() => setCreating(true)}>{t("ops.btn.new-trip")}</button>}
      </div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && q.data.trips.length === 0 && <EmptyState icon="🚚" title={t("ops.trip.empty")} />}
      <ul className="flex flex-col gap-2">
        {q.data?.trips.map((t2) => (
          <li key={t2.id}>
            <button type="button" className="card p-3 w-full text-start flex justify-between gap-2" onClick={() => setOpen(t2.id)}>
              <div>
                <div className="font-extrabold"><span dir="ltr">{t2.number}</span> · {t2.vehicle.code}{t2.vehicle.refrigerated && <Snowflake size={14} className="ms-1 inline text-united-info" aria-label={t("ops.fleet.refrigerated")} />} · {t2.driver.name}</div>
                <div className="text-xs font-bold text-united-muted">{t2.tripDate} · {t2.stops} {t("ops.trips.orders-label")} · {t("ops.trips.delivered-count")} {t2.delivered}</div>
              </div>
              <span className={`self-start rounded-full px-2 text-xs font-extrabold ${TRIP_STATUS[t2.status]?.cls}`}>{TRIP_STATUS[t2.status] ? t(TRIP_STATUS[t2.status].label) : t2.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewTrip({ onDone }: { onDone: (id?: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const fleet = useFleet();
  const { t } = useLocale();
  const [date, setDate] = useState(todayLocalISO());
  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const orders = useQuery({ queryKey: ["ops", "plannable", date], queryFn: () => apiFetch<{ orders: { id: string; orderNumber: string; customerName: string; status: string; deliveryTime: string | null }[] }>(`/api/operations/trips/plannable?date=${date}`) });
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><h2 className="text-xl font-extrabold">{t("ops.new.title")}</h2><button type="button" className="btn-secondary" onClick={() => onDone()}>{t("ops.new.back")}</button></div>
      <section className="card p-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Field label={t("ops.new.date-label")}><input type="date" className="field" value={date} onChange={(e) => { setDate(e.target.value); setPicked([]); }} /></Field>
        <Field label={t("ops.new.vehicle-label")}>
          <select className="field font-bold" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">{t("ops.new.select-option")}</option>
            {fleet.data?.vehicles.filter((v) => v.active).map((v) => <option key={v.id} value={v.id}>{v.code} · {v.plate}{v.refrigerated ? ` · ${t("ops.fleet.refrigerated")}` : ""}{v.capacityKg ? ` · ${Number(v.capacityKg)} ${t("ops.new.capacity-unit")}` : ""}</option>)}
          </select>
        </Field>
        <Field label={t("ops.new.driver-label")}>
          <select className="field font-bold" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">{t("ops.new.select-option")}</option>
            {fleet.data?.drivers.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </section>
      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("ops.new.orders-heading")}</h3>
        {orders.data?.orders.length === 0 && <p className="text-sm font-bold text-united-muted">{t("ops.new.no-orders", { date })}</p>}
        {orders.data?.orders.map((o) => {
          const n = picked.indexOf(o.id);
          return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)} aria-pressed={n >= 0} className={`tap-target rounded-xl px-3 text-start font-bold flex justify-between ${n >= 0 ? "bg-united-green text-white" : "bg-united-dark/5"}`}>
              <span>{n >= 0 ? `${n + 1}. ` : ""}<span dir="ltr">{o.orderNumber}</span> · {o.customerName}{o.deliveryTime ? ` · ${o.deliveryTime}` : ""}</span>
              <span className="text-xs">{o.status}</span>
            </button>
          );
        })}
        <button type="button" className="btn-primary" disabled={!vehicleId || !driverId || picked.length === 0} onClick={async () => {
          try {
            const r = await apiPost<{ trip: { id: string; number: string } }>("/api/operations/trips", { trip_date: date, vehicle_id: vehicleId, driver_id: driverId, order_ids: picked });
            toast.show(t("ops.new.created-toast", { number: r.trip.number }), "success");
            void qc.invalidateQueries({ queryKey: ["ops"] });
            onDone(r.trip.id);
          } catch (err) { fail(toast, err, t); }
        }}>{t("ops.new.create-btn")}</button>
      </section>
    </div>
  );
}

function TripView({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const { t } = useLocale();
  const [crates, setCrates] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [pod, setPod] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["ops", "trip", id], queryFn: () => apiFetch<{ trip: TripDetail }>(`/api/operations/trips/${id}`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const trip = q.data.trip;
  const act = async (path: string, body: Record<string, unknown> = {}) => {
    try { await apiPost(`/api/operations/trips/${id}/${path}`, body); void qc.invalidateQueries({ queryKey: ["ops"] }); } catch (err) { fail(toast, err, t); }
  };
  const stop = trip.stops.find((s) => s.id === pod);
  if (stop) return <DeliveryForm stop={stop} onDone={() => { setPod(null); void qc.invalidateQueries({ queryKey: ["ops"] }); }} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center gap-2">
        <div>
          <h2 className="text-xl font-extrabold" dir="ltr">{trip.number}</h2>
          <p className="text-sm font-bold text-united-muted">{trip.tripDate} · {trip.vehicle.code} · <span dir="ltr">{trip.vehicle.plate}</span>{trip.vehicle.refrigerated && <Snowflake size={14} className="ms-1 inline text-united-info" aria-label={t("ops.fleet.refrigerated")} />} · {trip.driver.name}{trip.driver.phone ? <> · <span dir="ltr">{trip.driver.phone}</span></> : null}</p>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>{t("ops.detail.back")}</button>
      </div>
      <span className={`self-start rounded-full px-3 py-1 text-sm font-extrabold ${TRIP_STATUS[trip.status]?.cls}`}>{TRIP_STATUS[trip.status] ? t(TRIP_STATUS[trip.status].label) : trip.status}{trip.cancelReason ? ` · ${trip.cancelReason}` : ""}</span>
      <ol className="flex flex-col gap-2">
        {trip.stops.map((s) => (
          <li key={s.id} className="card p-3 flex flex-col gap-2">
            <div className="flex justify-between gap-2">
              <div className="font-extrabold">{s.sequence}. <span dir="ltr">{s.order.orderNumber}</span> · {s.order.customerName}</div>
              <span className="text-xs font-extrabold text-united-muted">{s.order.status} · {STOP_STATUS[s.status] ? t(STOP_STATUS[s.status]) : s.status}</span>
            </div>
            <ul className="text-sm font-bold text-united-muted">
              {s.order.items.map((i) => {
                const l = s.lines.find((x) => x.orderItemId === i.id);
                return (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span>{i.productName}</span>
                    <span dir="ltr">{fmtQty(i.requiredQuantity)} → {fmtQty(i.preparedQuantity)} → {fmtQty(i.loadedQuantity)}{l ? ` → ✓${fmtQty(l.deliveredQty)}` : ""} {i.unit}</span>
                  </li>
                );
              })}
            </ul>
            {s.receiverName && <p className="text-xs font-bold">{t("ops.detail.receiver-line")}: {s.receiverName} · {t("ops.detail.logged-by")}: {s.recordedBy}</p>}
            {s.failureReason && <p className="text-xs font-bold text-united-danger">{s.failureReason}</p>}
            {trip.status === "loaded" && can("orders.dispatch") && (
              <input className="field w-40" dir="ltr" inputMode="numeric" placeholder={t("ops.detail.plan-box")} aria-label={`${t("ops.detail.crate-count")} ${s.order.orderNumber}`} value={crates[s.orderId] ?? (s.order.crateCount ? String(s.order.crateCount) : "")} onChange={(e) => setCrates({ ...crates, [s.orderId]: e.target.value })} />
            )}
            {["dispatched", "in_transit"].includes(trip.status) && s.status === "pending" && can("orders.dispatch") && (
              <button type="button" className="btn-primary self-start" onClick={() => setPod(s.id)}>{t("ops.detail.record-delivery")}</button>
            )}
          </li>
        ))}
      </ol>
      <section className="card p-4 flex flex-wrap gap-2">
        {["planned", "loading"].includes(trip.status) && can("orders.load") && <button type="button" className="btn-primary" onClick={() => act("start-loading")}>{t("ops.detail.start-loading")}</button>}
        {trip.status === "loading" && can("orders.load") && <button type="button" className="btn-primary" onClick={() => act("loaded")}>{t("ops.detail.confirm-loaded")}</button>}
        {trip.status === "loaded" && can("orders.dispatch") && (
          <button type="button" className="btn-primary" onClick={() => act("dispatch", { crates: Object.fromEntries(trip.stops.map((s) => [s.orderId, Number(crates[s.orderId] ?? s.order.crateCount ?? 0)]).filter(([, n]) => Number(n) > 0)) })}>{t("ops.detail.depart-btn")}</button>
        )}
        {trip.status === "dispatched" && can("orders.dispatch") && <button type="button" className="btn-secondary" onClick={() => act("depart")}>{t("ops.detail.en-route")}</button>}
        {["planned", "loading", "loaded"].includes(trip.status) && can("operations.trips.manage") && (
          <>
            <input className="field flex-1 min-w-48" placeholder={t("ops.detail.cancel-placeholder")} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn-danger" onClick={() => act("cancel", { reason })}>{t("ops.detail.cancel-btn")}</button>
          </>
        )}
      </section>
    </div>
  );
}

/** What happened at the customer: by default everything delivered; type what was not. */
function DeliveryForm({ stop, onDone }: { stop: Stop; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { t } = useLocale();
  const [failed, setFailed] = useState(false);
  const [receiver, setReceiver] = useState("");
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState("");
  const [lines, setLines] = useState<Record<string, { shortage_qty: string; damaged_qty: string; rejected_qty: string; reason: string }>>({});
  const [busy, setBusy] = useState(false);
  const set = (id: string, k: "shortage_qty" | "damaged_qty" | "rejected_qty" | "reason", v: string) => setLines({ ...lines, [id]: { ...(lines[id] ?? { shortage_qty: "", damaged_qty: "", rejected_qty: "", reason: "" }), [k]: v } });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><h2 className="text-xl font-extrabold">{t("ops.dlv.title-format", { orderNumber: stop.order.orderNumber, customerName: stop.order.customerName })}</h2><button type="button" className="btn-secondary" onClick={() => onDone()}>{t("ops.new.back")}</button></div>
      <Segmented value={failed ? "failed" : "ok"} onChange={(v) => setFailed(v === "failed")} items={[{ key: "ok", label: t("ops.dlv.delivered-tab") }, { key: "failed", label: t("ops.dlv.failed-tab") }]} />
      {failed ? (
        <section className="card p-4"><Field label={t("ops.dlv.failure-reason-label")}><input className="field" value={failure} onChange={(e) => setFailure(e.target.value)} /></Field></section>
      ) : (
        <>
          <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label={t("ops.dlv.receiver-name-label")}><input className="field" value={receiver} onChange={(e) => setReceiver(e.target.value)} /></Field>
            <Field label={t("ops.dlv.customer-notes-label")}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </section>
          <section className="card p-4 flex flex-col gap-3">
            <p className="text-xs font-bold text-united-muted">{t("ops.dlv.note")}</p>
            {stop.order.items.filter((i) => Number(i.shippedQty) > 0).map((i) => {
              const l = lines[i.id];
              const left = Number(i.shippedQty) - Number(l?.shortage_qty || 0) - Number(l?.damaged_qty || 0) - Number(l?.rejected_qty || 0);
              return (
                <div key={i.id} className="flex flex-col gap-1 border-b border-united-dark/5 pb-2">
                  <div className="flex justify-between font-extrabold text-sm"><span>{i.productName}</span><span dir="ltr">{t("ops.dlv.qty-left-format", { shipped: fmtQty(i.shippedQty, i.unit), left: fmtQty(left, i.unit) })}</span></div>
                  <div className="grid grid-cols-3 gap-2">
                    {(["shortage_qty", "damaged_qty", "rejected_qty"] as const).map((k) => (
                      <input key={k} className="field" dir="ltr" inputMode="decimal" aria-label={`${k} ${i.productName}`} placeholder={k === "shortage_qty" ? t("ops.dlv.shortage-ph") : k === "damaged_qty" ? t("ops.dlv.damaged-ph") : t("ops.dlv.rejected-ph")} value={l?.[k] ?? ""} onChange={(e) => set(i.id, k, e.target.value)} />
                    ))}
                  </div>
                  {l && (l.shortage_qty || l.damaged_qty || l.rejected_qty) && <input className="field" placeholder={t("ops.dlv.reason-ph")} value={l.reason} onChange={(e) => set(i.id, "reason", e.target.value)} />}
                </div>
              );
            })}
          </section>
        </>
      )}
      <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await apiPost(`/api/operations/stops/${stop.id}/delivery`, failed
            ? { result: "failed", failure_reason: failure }
            : { result: "delivered", receiver_name: receiver, customer_notes: notes || undefined, lines: Object.entries(lines).map(([order_item_id, l]) => ({ order_item_id, shortage_qty: l.shortage_qty || 0, damaged_qty: l.damaged_qty || 0, rejected_qty: l.rejected_qty || 0, reason: l.reason || undefined })) });
          toast.show(t("ops.dlv.result-saved-toast"), "success");
          onDone();
          void qc.invalidateQueries({ queryKey: ["ops"] });
        } catch (err) { fail(toast, err, t); } finally { setBusy(false); }
      }}>{t("ops.dlv.record-result-btn")}</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

type Ex = { id: string; type: string; status: string; description: string; productName: string | null; quantity: string | null; ownerName: string | null; resolution: string | null; resolvedBy: string | null; createdBy: string; createdAt: string; version: number; order: { orderNumber: string; customerName: string } | null };

function Exceptions() {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState("open");
  const [text, setText] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ["ops", "exceptions", status], queryFn: () => apiFetch<{ exceptions: Ex[] }>(`/api/operations/exceptions${status ? `?status=${status}` : ""}`) });
  return (
    <div className="flex flex-col gap-3">
      <Segmented value={status} onChange={setStatus} items={[{ key: "open", label: t("ops.exc.open-tab") }, { key: "resolved", label: t("ops.exc.resolved-tab") }, { key: "", label: t("ops.tab.all") }]} />
      {q.isLoading && <LoadingState />}
      {q.data && q.data.exceptions.length === 0 && <EmptyState icon="✅" title={t("ops.exc.none")} />}
      <ul className="flex flex-col gap-2">
        {q.data?.exceptions.map((e) => (
          <li key={e.id} className="card p-3 flex flex-col gap-1">
            <div className="flex justify-between gap-2">
              <span className="font-extrabold">{EX_TYPE[e.type] ? t(EX_TYPE[e.type]) : e.type}{e.productName ? ` · ${e.productName}` : ""}{e.quantity ? <> · <span dir="ltr">{fmtQty(e.quantity)}</span></> : null}</span>
              <span className={`text-xs font-extrabold ${e.status === "open" ? "text-united-warn" : "text-united-green"}`}>{e.status === "open" ? t("ops.exc.open-status") : t("ops.exc.closed-status")}</span>
            </div>
            <p className="text-sm font-bold">{systemText(e.description, locale)}</p>
            <p className="text-xs font-bold text-united-muted">{e.order ? <><span dir="ltr">{e.order.orderNumber}</span> · {e.order.customerName} · </> : null}{t("ops.exc.logged-by-prefix")} {e.createdBy}{e.ownerName ? ` · ${t("ops.exc.responsible-label")} ${e.ownerName}` : ""}{e.resolution ? ` · ${t("ops.exc.resolution-label")}: ${e.resolution} (${e.resolvedBy})` : ""}</p>
            {e.status === "open" && can("orders.approve") && (
              <div className="flex gap-2">
                <input className="field flex-1" placeholder={t("ops.exc.resolution-label")} value={text[e.id] ?? ""} onChange={(ev) => setText({ ...text, [e.id]: ev.target.value })} />
                <button type="button" className="btn-secondary shrink-0" onClick={async () => {
                  try { await apiPost(`/api/operations/exceptions/${e.id}/resolve`, { resolution: text[e.id] ?? "", expected_version: e.version }); void qc.invalidateQueries({ queryKey: ["ops", "exceptions"] }); } catch (err) { fail(toast, err, t); }
                }}>{t("ops.exc.close-btn")}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

function FleetView() {
  const toast = useToast();
  const qc = useQueryClient();
  const { t } = useLocale();
  const q = useFleet();
  const [v, setV] = useState({ code: "", plate: "", type: "truck", capacity_kg: "", refrigerated: false });
  const [d, setD] = useState({ name: "", phone: "" });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["ops", "fleet"] });
  const toggle = async (kind: "vehicles" | "drivers", row: { id: string; active: boolean; version: number } & Record<string, unknown>) => {
    try {
      const body = kind === "vehicles"
        ? { code: row.code, plate: row.plate, type: row.type, capacity_kg: row.capacityKg ? Number(row.capacityKg) : null, refrigerated: row.refrigerated, active: !row.active, expected_version: row.version }
        : { name: row.name, phone: row.phone, active: !row.active, expected_version: row.version };
      await apiPatch(`/api/operations/${kind}/${row.id}`, body);
      refresh();
    } catch (err) { fail(toast, err, t); }
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("ops.fleet.vehicles-title")}</h3>
        <form className="grid grid-cols-2 gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try { await apiPost("/api/operations/vehicles", { ...v, capacity_kg: v.capacity_kg ? Number(v.capacity_kg) : null }); setV({ code: "", plate: "", type: "truck", capacity_kg: "", refrigerated: false }); refresh(); } catch (err) { fail(toast, err, t); }
        }}>
          <input className="field" placeholder={t("ops.fleet.code-ph")} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />
          <input className="field" placeholder={t("ops.fleet.plate-ph")} value={v.plate} onChange={(e) => setV({ ...v, plate: e.target.value })} />
          <select className="field" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}><option value="truck">{t("ops.veh.type.truck")}</option><option value="van">{t("ops.veh.type.van")}</option><option value="pickup">{t("ops.veh.type.pickup")}</option><option value="other">{t("ops.veh.type.other")}</option></select>
          <input className="field" dir="ltr" inputMode="decimal" placeholder={t("ops.fleet.capacity-label")} value={v.capacity_kg} onChange={(e) => setV({ ...v, capacity_kg: e.target.value })} />
          <label className="flex items-center gap-2 font-bold text-sm"><input type="checkbox" checked={v.refrigerated} onChange={(e) => setV({ ...v, refrigerated: e.target.checked })} /> {t("ops.fleet.refrigerated")}</label>
          <button className="btn-secondary">{t("ops.fleet.add-vehicle")}</button>
        </form>
        <ul className="text-sm font-bold divide-y divide-united-dark/5">
          {q.data?.vehicles.map((x) => (
            <li key={x.id} className={`py-1 flex justify-between ${x.active ? "" : "text-united-muted line-through"}`}>
              <span>{x.code} · <span dir="ltr">{x.plate}</span>{x.refrigerated && <Snowflake size={14} className="ms-1 inline text-united-info" aria-label={t("ops.fleet.refrigerated")} />}{x.capacityKg ? ` · ${Number(x.capacityKg)} ${t("ops.veh.weight-unit")}` : ""}</span>
              <button type="button" className="text-xs underline" onClick={() => toggle("vehicles", x)}>{x.active ? t("ops.fleet.disable") : t("ops.fleet.enable")}</button>
            </li>
          ))}
        </ul>
      </section>
      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("ops.fleet.drivers-title")}</h3>
        <form className="grid grid-cols-2 gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try { await apiPost("/api/operations/drivers", { name: d.name, phone: d.phone || null }); setD({ name: "", phone: "" }); refresh(); } catch (err) { fail(toast, err, t); }
        }}>
          <input className="field" placeholder={t("ops.fleet.name-ph")} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          <input className="field" dir="ltr" placeholder={t("ops.fleet.phone-ph")} value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} />
          <button className="btn-secondary col-span-2">{t("ops.fleet.add-driver")}</button>
        </form>
        <ul className="text-sm font-bold divide-y divide-united-dark/5">
          {q.data?.drivers.map((x) => (
            <li key={x.id} className={`py-1 flex justify-between ${x.active ? "" : "text-united-muted line-through"}`}>
              <span>{x.name}{x.phone ? <> · <span dir="ltr">{x.phone}</span></> : null}</span>
              <button type="button" className="text-xs underline" onClick={() => toggle("drivers", x)}>{x.active ? t("ops.fleet.disable") : t("ops.fleet.enable")}</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
