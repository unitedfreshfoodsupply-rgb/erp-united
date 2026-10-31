"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import type { OrderItemDTO } from "@/lib/client-types";
import { QuantityInput } from "@/components/QuantityInput";
import { qty as qtyLabel, unitLabel } from "@/lib/format";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

type Mode = "display" | "prepare" | "load";

export function ItemRow({
  item,
  mode,
  onConfirm,
  busy,
  supervisorEdit,
}: {
  item: OrderItemDTO;
  mode: Mode;
  onConfirm?: (quantity: number) => Promise<void>;
  busy?: boolean;
  supervisorEdit?: { onSave: (qty: number, reason: string) => Promise<void> };
}) {
  const { t, locale } = useLocale();
  const startValue =
    mode === "load"
      ? item.loadedQuantity ?? item.preparedQuantity ?? item.requiredQuantity
      : item.preparedQuantity ?? item.requiredQuantity;
  const [qty, setQty] = useState(startValue);

  // The input was seeded once and then never looked at the item again, so after a
  // confirm — or after another tablet changed the same line — it kept showing a value
  // the server no longer held, and the next confirm would send it back. Re-seed when
  // the server's own numbers change, but never while the operator is mid-entry
  // (touched), so their typing is never yanked out from under them.
  const [touched, setTouched] = useState(false);
  // The server's new value when another tablet saved this line while the operator was typing.
  const [remoteValue, setRemoteValue] = useState<number | null>(null);
  const lastVersion = useRef(item.version);
  const draft = useRef({ touched, qty });
  draft.current = { touched, qty };
  useEffect(() => {
    // item.version changes exactly when the server accepted a write to this line — by this
    // operator (their value is now the server's) or by another tablet. Re-seed, unless the
    // operator is mid-entry with a different value: then keep their typing and say that the
    // line changed elsewhere, so a confirm never silently overwrites it either way.
    if (lastVersion.current !== item.version) {
      lastVersion.current = item.version;
      if (draft.current.touched && draft.current.qty !== startValue) {
        setRemoteValue(startValue);
      } else {
        setQty(startValue);
        setTouched(false);
        setRemoteValue(null);
      }
    }
  }, [item.version, startValue]);
  const [editingRequired, setEditingRequired] = useState(false);
  const [reqQty, setReqQty] = useState(String(item.requiredQuantity));
  const [reqReason, setReqReason] = useState("");
  const [outlierConfirmed, setOutlierConfirmed] = useState(false);

  // A typo (50 instead of 5, or vice versa) is easy to make on a tablet and hard to
  // notice at a glance — catch anything wildly off from what was required and make
  // the operator tap twice instead of silently recording it. This is a UI-only nudge
  // (separate from the server's shortage/review threshold) and never blocks a
  // deliberate entry, just asks "are you sure" once.
  const outlierVariance =
    item.requiredQuantity > 0 ? Math.abs(qty - item.requiredQuantity) / item.requiredQuantity : 0;
  const isOutlier = outlierVariance > 0.2;

  function handleQtyChange(next: number) {
    setQty(next);
    setTouched(true);
    setOutlierConfirmed(false);
  }

  const done = mode === "load" ? item.loadingStatus === "done" : item.preparationStatus === "done";
  // What is still owed at THIS stage. Loading is measured against what was actually
  // prepared, not the original ask — you cannot load what was never picked.
  const stageTarget = mode === "load" ? item.preparedQuantity ?? item.requiredQuantity : item.requiredQuantity;
  const stageActual = mode === "load" ? item.loadedQuantity : item.preparedQuantity;
  const remaining = done ? 0 : Math.max(0, Math.round((stageTarget - (stageActual ?? 0)) * 1000) / 1000);
  const short =
    mode === "prepare"
      ? item.preparedQuantity != null && item.preparedQuantity < item.requiredQuantity
      : mode === "load"
      ? item.loadedQuantity != null && item.loadedQuantity < item.requiredQuantity
      : false;
  const mismatch =
    mode === "load" &&
    item.loadedQuantity != null &&
    item.preparedQuantity != null &&
    item.loadedQuantity !== item.preparedQuantity &&
    item.loadedQuantity >= item.requiredQuantity;

  // Figure component that uses t() for its label
  function Figure({
    labelKey,
    value,
    unit,
    tone = "neutral",
  }: {
    labelKey: Parameters<typeof t>[0];
    value: string;
    unit: string;
    tone?: "neutral" | "done" | "pending" | "short";
  }) {
    const toneClass = {
      neutral: "text-united-dark",
      done: "text-united-green",
      pending: "text-united-dark/40",
      short: "text-united-danger",
    }[tone];
    return (
      <div>
        <div className="text-[11px] text-united-muted mb-0.5">{t(labelKey)}</div>
        <div dir="ltr" className={`font-extrabold text-lg sm:text-xl ${toneClass}`}>
          {value}
          {value !== "—" && <span className="text-[10px] font-bold text-united-dark/40"> {unitLabel(unit)}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={`card p-4 sm:p-5 ${short ? "!border-united-danger/40 border-s-4 !border-s-united-danger" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-lg sm:text-xl font-semibold text-united-dark">{item.stockProduct ? localName(item.stockProduct, locale === "en" ? "en" : "ar") : item.productName}</span>
        {done && (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-united-green text-white" aria-label={t("ui.done")}>
            <Check size={18} strokeWidth={2.5} aria-hidden />
          </span>
        )}
      </div>

      {/* Required / prepared / loaded / remaining — every figure carries its unit, and
          "remaining" is shown rather than left for the operator to subtract. */}
      <div className="grid grid-cols-4 gap-2 text-center mb-3">
        <Figure labelKey={mode === "load" ? "orders.item.remaining.loading" : "orders.item.remaining.prep"} value={qtyLabel(remaining)} unit={item.unit} tone={remaining > 0 ? "short" : "done"} />
        <Figure
          labelKey="orders.item.loaded"
          value={qtyLabel(item.loadedQuantity)}
          unit={item.unit}
          tone={item.loadingStatus === "done" ? "done" : "pending"}
        />
        <Figure
          labelKey="orders.item.prepared"
          value={qtyLabel(item.preparedQuantity)}
          unit={item.unit}
          tone={item.preparationStatus === "done" ? "done" : "pending"}
        />
        <Figure
          labelKey="orders.item.required"
          value={qtyLabel(item.requiredQuantity)}
          unit={item.unit}
        />
      </div>

      {(mode === "prepare" || mode === "load") && !done && (
        <div className="border-t border-united-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <QuantityInput value={qty} onChange={handleQtyChange} disabled={busy} />
            <button
              disabled={busy}
              onClick={() => {
                if (isOutlier && !outlierConfirmed) {
                  setOutlierConfirmed(true);
                  return;
                }
                onConfirm?.(qty);
              }}
              className={`px-6 text-lg btn-primary ${isOutlier && !outlierConfirmed ? "!bg-united-warn" : ""}`}
            >
              {busy
                ? t("orders.item.confirm_recording")
                : isOutlier && !outlierConfirmed
                ? t("orders.item.outlier_confirm")
                : mode === "prepare"
                ? t("orders.item.done_prep")
                : t("orders.item.done_load")}
            </button>
          </div>
          {remoteValue !== null && (
            <div role="status" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-united-warn/10 px-3 py-2 text-sm font-medium text-united-warn">
              <span>{t("orders.item.changed_elsewhere", { qty: qtyLabel(remoteValue), unit: unitLabel(item.unit) })}</span>
              <button type="button" className="btn-secondary btn-sm" onClick={() => { setQty(remoteValue); setTouched(false); setRemoteValue(null); }}>
                {t("orders.item.use_server_value")}
              </button>
            </div>
          )}
          {/* Inline prepared-vs-ordered comparison — updates immediately on every keystroke. */}
          <div className="flex items-center gap-2 mt-2 text-sm font-bold">
            <span className="text-united-muted">{t("orders.item.req_label")}</span>
            <span dir="ltr" className="text-united-dark">{qtyLabel(item.requiredQuantity)} {unitLabel(item.unit)}</span>
            <span className="text-united-muted">{t("orders.item.prep_label")}</span>
            <span dir="ltr" className={qty > item.requiredQuantity ? "text-united-warn" : "text-united-green"}>{qtyLabel(qty)} {unitLabel(item.unit)}</span>
          </div>
          {qty > item.requiredQuantity && (
            <p className="text-united-danger font-bold text-sm mt-1">
              {t("orders.item.excess_warning", { qty: qtyLabel(qty), required: qtyLabel(item.requiredQuantity) })}
            </p>
          )}
          {isOutlier && (
            <p className="text-united-warn font-bold text-sm mt-2">
              {t("orders.item.outlier_warning", {
                required: qtyLabel(item.requiredQuantity),
                unit: unitLabel(item.unit),
                msg: outlierConfirmed ? t("orders.item.outlier_confirmed_msg") : t("orders.item.outlier_pending_msg"),
              })}
            </p>
          )}
        </div>
      )}

      {short && (
        <p className="mt-2 flex items-start gap-1.5 font-semibold text-united-danger">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden /> {t("orders.item.shortage_text", { qty: qtyLabel(item.requiredQuantity - (mode === "load" ? item.loadedQuantity! : item.preparedQuantity!)), unit: unitLabel(item.unit) })}
        </p>
      )}
      {!short && mismatch && (
        <p className="text-united-warn font-bold mt-2">{t("orders.item.mismatch_warning")}</p>
      )}

      {supervisorEdit && (
        <div className="border-t border-united-border pt-3 mt-3">
          {!editingRequired ? (
            <button
              onClick={() => setEditingRequired(true)}
              className="inline-flex min-h-[40px] items-center text-sm font-bold text-united-muted underline hover:text-united-dark"
            >
              {t("orders.item.edit_required_btn")}
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  type="number"
                  value={reqQty}
                  onChange={(e) => setReqQty(e.target.value)}
                  className="field w-24 text-center"
                />
                <input
                  placeholder={t("orders.item.reason_placeholder")}
                  value={reqReason}
                  onChange={(e) => setReqReason(e.target.value)}
                  className="field flex-1"
                />
              </div>
              <div className="flex gap-2">
                <button
                  disabled={!reqReason.trim() || !reqQty}
                  onClick={async () => {
                    await supervisorEdit.onSave(Number(reqQty), reqReason);
                    setEditingRequired(false);
                    setReqReason("");
                  }}
                  className="btn-primary flex-1"
                >
                  {t("ui.save")}
                </button>
                <button onClick={() => setEditingRequired(false)} className="btn-secondary">
                  {t("ui.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
