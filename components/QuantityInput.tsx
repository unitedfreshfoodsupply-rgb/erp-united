"use client";

import { useLocale } from "@/lib/locale";
import { toLatinDigits } from "@/lib/numerals";
import { stepQuantity } from "@/lib/quantity";

export function QuantityInput({
  value,
  onChange,
  disabled,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  step?: number;
}) {
  const { t } = useLocale();
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={t("ui.qty.decrease")}
        disabled={disabled}
        onClick={() => onChange(stepQuantity(value, -step))}
        className="tap-target w-14 rounded-xl bg-united-dark/10 text-2xl font-extrabold disabled:opacity-40"
      >
        −
      </button>
      <input
        type="number"
        inputMode="decimal"
        aria-label={t("ui.qty.value")}
        disabled={disabled}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          // I18N-02: an Arabic keyboard types ١٢٫٥ — the same number, not NaN → 0.
          const n = Number(toLatinDigits(e.target.value));
          onChange(Number.isFinite(n) ? Math.max(0, n) : 0);
        }}
        className="tap-target w-24 text-center text-2xl font-extrabold border-2 border-united-dark/10 rounded-xl focus:border-united-green outline-none disabled:opacity-50"
      />
      <button
        type="button"
        aria-label={t("ui.qty.increase")}
        disabled={disabled}
        onClick={() => onChange(stepQuantity(value, step))}
        className="tap-target w-14 rounded-xl bg-united-green/20 text-united-dark text-2xl font-extrabold disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
