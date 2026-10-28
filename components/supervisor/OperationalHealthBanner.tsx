import { CheckCircle2, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { OperationalHealthDTO } from "@/lib/client-types";
import { useLocale } from "@/lib/locale";

const LEVEL: Record<OperationalHealthDTO["level"], { icon: LucideIcon; text: string; frame: string }> = {
  healthy: { icon: CheckCircle2, text: "text-united-green", frame: "border-united-border" },
  attention: { icon: TriangleAlert, text: "text-united-warn", frame: "border-[#F3D9AE] bg-[#FFFBF3]" },
  critical: { icon: OctagonAlert, text: "text-united-danger", frame: "border-[#F5C6C1] bg-[#FFF7F6]" },
};

function levelLabel(t: (k: string) => string, level: OperationalHealthDTO["level"]): string {
  const map: Record<string, string> = {
    healthy: t("health.healthy"),
    attention: t("health.attention"),
    critical: t("health.critical"),
  };
  return map[level] ?? level;
}

/** A rule-based (never a decorative score) read on "is the operation healthy
 * right now" — every word here maps to a real, visible count. One line: the verdict,
 * why, and the counts behind it. */
export function OperationalHealthBanner({ health }: { health: OperationalHealthDTO }) {
  const { t } = useLocale();
  const { level, reasons, reasonKeys, counts } = health;
  const shownReasons = reasonKeys?.length ? reasonKeys.map((r) => t(r.key, { count: r.count })) : reasons;
  const L = LEVEL[level];
  const Icon = L.icon;
  const stats: [number, string][] = [
    [counts.activeOrders, t("health.active-orders")],
    [counts.readyLoadingBacklog, t("health.ready-loading")],
    [counts.blockedApprovals, t("health.blocked")],
    [counts.stalledOrders, t("health.stalled")],
    [counts.deliveryRisk, t("health.delivery-risk")],
  ];
  return (
    <section className={`card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between ${L.frame}`} role="status">
      <div className="flex items-start gap-2.5">
        <Icon size={22} className={`mt-0.5 shrink-0 ${L.text}`} aria-hidden />
        <div>
          <div className={`text-base font-bold ${L.text}`}>{levelLabel(t, level)}</div>
          {shownReasons.length > 0 && <div className="text-sm text-united-dark">{shownReasons.join(" · ")}</div>}
        </div>
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1">
        {stats.map(([n, label]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="order-2 text-xs text-united-muted">{label}</dt>
            <dd className={`order-1 text-lg font-bold ${n > 0 ? "text-united-dark" : "text-united-muted"}`}>{n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
