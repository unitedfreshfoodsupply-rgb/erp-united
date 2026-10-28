"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import { playChime } from "@/lib/sound";
import type { OrderDTO } from "@/lib/client-types";
import { isStalledInProgress } from "@/lib/orderPresentation";
import { useLocale } from "@/lib/locale";

/** The toast text in the operator's language; read through a ref so the polling effects
 * below keep their [orders] dependency and still use the current locale. */
function useAlertText() {
  const { t } = useLocale();
  const ref = useRef(t);
  ref.current = t;
  return (key: string, o: OrderDTO) => ref.current(key, { customer: o.customerName, number: o.orderNumber });
}

/** Notify (toast + chime) when an order this board didn't know about shows up —
 * e.g. a brand-new order arriving from n8n while the tablet just sits there. The
 * first snapshot after mount never alerts (nothing is "new" on page load). */
export function useNewOrderAlert(orders: OrderDTO[] | undefined) {
  const toast = useToast();
  const text = useAlertText();
  const seenIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!orders) return;
    const ids = new Set(orders.map((o) => o.id));
    if (seenIds.current) {
      for (const o of orders) {
        if (!seenIds.current.has(o.id)) {
          toast.show(text("alerts.new-order", o), {
            kind: "info",
            href: `/orders/${o.id}`,
          });
          playChime("new-order");
        }
      }
    }
    seenIds.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);
}

/** Notify when an order this board is watching crosses into "ready for loading" —
 * the loader's key cue that something new needs their attention. */
export function useReadyForLoadingAlert(orders: OrderDTO[] | undefined) {
  const toast = useToast();
  const text = useAlertText();
  const prevStatus = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (!orders) return;
    const current = new Map(orders.map((o) => [o.id, o.status]));
    if (prevStatus.current) {
      for (const o of orders) {
        const before = prevStatus.current.get(o.id);
        if (before && before !== "ready_for_loading" && o.status === "ready_for_loading") {
          toast.show(text("alerts.ready-for-loading", o), {
            kind: "info",
            href: `/orders/${o.id}`,
          });
          playChime("ready");
        }
      }
    }
    prevStatus.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);
}

/** Notify when an order newly needs supervisor review — a shortage/discrepancy
 * just got flagged and someone has to approve it before work can continue. */
export function useAttentionAlert(orders: OrderDTO[] | undefined) {
  const toast = useToast();
  const text = useAlertText();
  const prevFlag = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (!orders) return;
    const current = new Map(orders.map((o) => [o.id, o.needsReview]));
    if (prevFlag.current) {
      for (const o of orders) {
        const before = prevFlag.current.get(o.id);
        if (o.needsReview && before === false) {
          toast.show(text("alerts.needs-review", o), {
            kind: "error",
            href: `/orders/${o.id}`,
          });
          playChime("attention");
        }
      }
    }
    prevFlag.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);
}

/** Notify once when an in-progress order crosses into "stalled" (the same
 * configured orders.stalled_minutes threshold used everywhere else) — fires exactly once per
 * crossing, same false→true dedup pattern as the other alerts, never repeats
 * on every poll tick while it stays stalled. */
export function useStalledAlert(orders: OrderDTO[] | undefined, stalledMinutes?: number) {
  const toast = useToast();
  const text = useAlertText();
  const prevFlag = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (!orders) return;
    const current = new Map(orders.map((o) => [o.id, isStalledInProgress(o.status, o.updatedAt, stalledMinutes)]));
    if (prevFlag.current) {
      for (const o of orders) {
        const isStalled = current.get(o.id) ?? false;
        const before = prevFlag.current.get(o.id);
        if (isStalled && before === false) {
          toast.show(text("alerts.stalled", o), {
            kind: "error",
            href: `/orders/${o.id}`,
          });
          playChime("attention");
        }
      }
    }
    prevFlag.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, stalledMinutes]);
}
