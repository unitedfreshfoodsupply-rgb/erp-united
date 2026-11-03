"use client";

import { useState } from "react";
import { useLocale } from "@/lib/locale";
import { Field } from "@/components/ui/Field";

export function ReasonAction({
  label,
  confirmLabel,
  className,
  onConfirm,
}: {
  label: string;
  confirmLabel?: string;
  className?: string;
  /** Resolve false (or reject) when the action was refused: the prompt then stays open
   *  with the reason still typed, so the user can correct and retry. */
  onConfirm: (reason: string) => Promise<boolean | void>;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={className ?? "px-4 py-2 rounded-xl bg-united-dark/10 font-bold text-sm"}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 bg-united-dark/5 rounded-xl p-3">
      <Field label={t("form.reason")} required>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="field"
        />
      </Field>
      <div className="flex gap-2">
        <button
          disabled={!reason.trim() || busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            try {
              const ok = await onConfirm(reason);
              if (ok === false) return;
              setOpen(false);
              setReason("");
            } finally {
              setBusy(false);
            }
          }}
          className="btn-primary flex-1"
        >
          {confirmLabel ?? t("ui.confirm")}
        </button>
        <button onClick={() => setOpen(false)} className="btn-secondary">
          {t("ui.cancel")}
        </button>
      </div>
    </div>
  );
}