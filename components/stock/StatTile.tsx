import { unitLabel } from "@/lib/format";
export function StatTile({
  label,
  value,
  unit,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: "default" | "good" | "warn" | "bad" | "muted";
}) {
  const toneClass = {
    default: "text-united-dark",
    good: "text-united-green",
    warn: "text-united-warn",
    bad: "text-united-danger",
    muted: "text-united-muted",
  }[tone];
  return (
    <div className="card p-3 flex flex-col justify-between min-h-[86px]">
      <span className="text-xs font-extrabold text-united-muted">{label}</span>
      <div className="flex items-baseline gap-1 mt-1">
        {/* dir="ltr" keeps "12.5 كجم" from having its number and unit swapped by the
            bidi algorithm inside this RTL page. */}
        <span dir="ltr" className={`text-2xl font-extrabold leading-none ${toneClass}`}>
          {value}
        </span>
        {unit && <span className="text-xs font-bold text-united-muted">{unitLabel(unit)}</span>}
      </div>
      {sub && <span className="text-[11px] font-bold text-united-muted mt-1">{sub}</span>}
    </div>
  );
}
