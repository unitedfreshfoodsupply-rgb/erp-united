"use client";

import { useRef, useState } from "react";
import { useLocale } from "@/lib/locale";

/** The truck-leaving confirmation — requires driver name, vehicle number, and crate
 * count before it will actually fire, since a dispatched order with a blank manifest
 * is useless. Mirrors the two-step reveal pattern used by ReasonAction. */
export function DispatchButton({
  busy,
  onConfirm,
}: {
  busy?: boolean;
  onConfirm: (info: { vehicle: string; driverName: string; crateCount: number }) => Promise<void>;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [vehicle, setVehicle] = useState("");
  const [driverName, setDriverName] = useState("");
  const [crateCount, setCrateCount] = useState("");
  // Dispatch takes a few seconds (stock issue, trip, documents). The ref stops a second tap in
  // the same frame; `sending` keeps the label honest until the parent's own busy flag is up.
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const working = !!busy || sending;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-dark w-full text-xl">
        {t("orders.dispatch_btn.label")}
      </button>
    );
  }

  const canConfirm = vehicle.trim() && driverName.trim() && Number(crateCount) > 0;

  return (
    <div className="card p-5 flex flex-col gap-3">
      <h2 className="font-extrabold text-united-dark">{t("orders.dispatch_btn.title")}</h2>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-bold text-united-muted">{t("orders.dispatch_btn.driver_label")}</span>
        <input value={driverName} onChange={(e) => setDriverName(e.target.value)} className="field" autoFocus />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-bold text-united-muted">{t("orders.dispatch_btn.vehicle_label")}</span>
        <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} className="field" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-bold text-united-muted">{t("orders.dispatch_btn.crates_label")}</span>
        <input
          type="number"
          inputMode="numeric"
          value={crateCount}
          onChange={(e) => setCrateCount(e.target.value)}
          className="field"
        />
      </label>
      <div className="flex gap-2">
        <button
          disabled={!canConfirm || working}
          aria-busy={working || undefined}
          onClick={async () => {
            if (working || inFlight.current) return;
            inFlight.current = true;
            setSending(true);
            try {
              await onConfirm({ vehicle: vehicle.trim(), driverName: driverName.trim(), crateCount: Number(crateCount) });
            } finally {
              inFlight.current = false;
              setSending(false);
            }
          }}
          className="btn-primary flex-1 text-lg"
        >
          {working ? t("orders.dispatch_btn.busy") : t("orders.dispatch_btn.confirm_btn")}
        </button>
        <button onClick={() => setOpen(false)} disabled={working} className="btn-secondary px-5">
          {t("ui.cancel")}
        </button>
      </div>
    </div>
  );
}
