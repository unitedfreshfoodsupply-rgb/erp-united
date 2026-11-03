"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, ApiClientError } from "@/lib/api-client";
import type { OrderDTO } from "@/lib/client-types";
import { invalidateOrderData } from "@/lib/queryInvalidation";
import { useToast } from "@/components/ui/Toast";
import { todayLocalISO } from "@/lib/localDate";
import { useLocale } from "@/lib/locale";
import { Field } from "@/components/ui/Field";

/** Duplicates this order into a brand-new one (new id/number, clean state, no
 * inherited history) — e.g. "same customer wants the same list again tomorrow". */
export function CloneOrderAction({ orderId }: { orderId: string }) {
  const { t } = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayLocalISO());
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-secondary text-sm px-4 py-2">
        {t("orders.clone.btn")}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 bg-united-dark/5 rounded-xl p-3">
      <p className="text-sm font-bold text-united-dark">
        {t("orders.clone.info")}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("orders.delivery-date")} required className="flex-1"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field" /></Field>
        <Field label={t("orders.delivery-time-label")} className="flex-1"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="field" /></Field>
      </div>
      {error && <p className="text-united-danger font-bold text-sm">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={busy || !date}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
              const { order } = await apiPost<{ order: OrderDTO }>(`/api/orders/${orderId}/clone`, {
                delivery_date: date,
                delivery_time: time || undefined,
              });
              await invalidateOrderData(qc);
              toast.show(t("orders.clone.toast_success", { number: order.orderNumber }), "success");
              router.push(`/orders/${order.id}`);
            } catch (err) {
              const msg = err instanceof ApiClientError ? err.message : t("orders.clone.error_generic");
              setError(msg);
              toast.show(msg, "error");
            } finally {
              setBusy(false);
            }
          }}
          className="btn-primary flex-1"
        >
          {busy ? t("orders.clone.saving") : t("orders.clone.confirm_btn")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
          {t("ui.cancel")}
        </button>
      </div>
    </div>
  );
}
