import { fmtYield, yieldTone } from "@/lib/stockPresentation";
import { useLocale } from "@/lib/locale";

/** Yield as a bar plus its number. Renders an explicit "no deliveries yet" state
 * rather than an empty 0% bar, which would read as a catastrophically bad day. */
export function YieldMeter({ pct, label }: { pct: number | null; label?: string }) {
  const { t } = useLocale();
  const tone = yieldTone(pct);
  const barClass = {
    good: "bg-united-green",
    warn: "bg-united-warn",
    bad: "bg-united-danger",
    none: "bg-united-dark/15",
  }[tone];
  const textClass = {
    good: "text-united-green",
    warn: "text-united-warn",
    bad: "text-united-danger",
    none: "text-united-muted",
  }[tone];

  return (
    <div>
      <div className="flex items-center justify-between text-sm font-bold mb-1">
        <span className="text-united-dark">{label ?? t("stock.yield-percentage")}</span>
        <span dir="ltr" className={textClass}>
          {fmtYield(pct)}
        </span>
      </div>
      <div className="h-2 rounded-full bg-united-dark/10 overflow-hidden">
        <div className={`h-full transition-all ${barClass}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}
