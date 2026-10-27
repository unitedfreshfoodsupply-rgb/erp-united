import type { OperationalHealthDTO } from "@/lib/client-types";
import { useLocale } from "@/lib/locale";

const LEVEL_STYLE: Record<OperationalHealthDTO["level"], string> = {
  healthy: "bg-united-green/10 border-united-green/30 text-united-dark",
  attention: "bg-amber-50 border-united-warn/40 text-united-dark",
  critical: "bg-red-50 border-united-danger/40 text-united-dark",
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
 * right now" — every word here maps to a real, visible count. */
export function OperationalHealthBanner({ health }: { health: OperationalHealthDTO }) {
  const { t } = useLocale();
  const { level, reasons, reasonKeys, counts } = health;
  const shownReasons = reasonKeys?.length ? reasonKeys.map((r) => t(r.key, { count: r.count })) : reasons;
  return (
    <div className={`card p-4 border-2 ${LEVEL_STYLE[level]}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="font-extrabold text-lg">{levelLabel(t, level)}</span>
        {shownReasons.length > 0 && (
          <span className="text-sm font-bold text-united-dark/70">{shownReasons.join(" · ")}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs font-bold text-united-dark/60">
        <span>{counts.activeOrders} {t("health.active-orders")}</span>
        <span>{counts.readyLoadingBacklog} {t("health.ready-loading")}</span>
        <span>{counts.blockedApprovals} {t("health.blocked")}</span>
        <span>{counts.stalledOrders} {t("health.stalled")}</span>
        <span>{counts.deliveryRisk} {t("health.delivery-risk")}</span>
      </div>
    </div>
  );
}
