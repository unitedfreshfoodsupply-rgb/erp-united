import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { dailyOperationsSummary } from "@/lib/orders-service";
import { STATUS_LABEL, STATUS_LABEL_EN, STATUS_DOT } from "@/lib/orderPresentation";
import { printDir, printIntl, printLocale, printT } from "@/lib/locale/print";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/types";
import { PrintBar } from "@/components/print/PrintBar";

const OPEN_ORDER: OrderStatus[] = ["new", "preparing", "ready_for_loading", "loading", "loaded"];

export default async function DailyReportPrintPage({ searchParams }: { searchParams?: { lang?: string } }) {
  const locale = printLocale(searchParams);
  const t = printT(locale);
  const statusLabel = (s: OrderStatus) => (locale === "en" ? STATUS_LABEL_EN : STATUS_LABEL)[s] ?? s;
  /** A code's dictionary wording, or the server's own text for a code not listed. */
  const byKey = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const gate = await requirePagePermission("reports.view");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  const data = await dailyOperationsSummary();

  return (
    <main className="min-h-screen bg-white" dir={printDir(locale)} lang={locale}>
      <PrintBar backHref="/supervisor/report" />
      <div className="print-sheet max-w-3xl mx-auto p-6 text-united-dark">
        <div className="flex items-center justify-between border-b-4 border-united-dark pb-4 mb-5">
          <div>
            <div className="font-extrabold text-xl">{t("report.title")}</div>
          </div>
          <div className="text-sm font-bold" dir="ltr">
            {data.date}
          </div>
        </div>

        <div className="border-2 border-united-dark/20 rounded-lg p-3 mb-5 print-break-inside-avoid">
          <div className="font-extrabold">
            {byKey(`report.health.${data.health.level}`, data.health.level)}
            {data.health.reasons.length > 0 && (
              <span className="font-normal text-sm text-united-dark/60"> — {(data.health.reasonKeys?.length ? data.health.reasonKeys.map((r) => t(r.key, { count: r.count })) : data.health.reasons).join(" · ")}</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-5 gap-3 mb-6 print-break-inside-avoid">
          <div className="border border-united-dark/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-extrabold">{data.ordersReceivedToday}</div>
            <div className="text-xs text-united-dark/60">{t("report.received-today")}</div>
          </div>
          <div className="border border-united-dark/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-extrabold">{data.dispatchedToday}</div>
            <div className="text-xs text-united-dark/60">{t("report.dispatched-today")}</div>
          </div>
          <div className="border border-united-dark/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-extrabold">{data.exceptionsActive}</div>
            <div className="text-xs text-united-dark/60">{t("report.exceptions")}</div>
          </div>
          <div className="border border-united-dark/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-extrabold">{data.completionPct != null ? `${data.completionPct}%` : "—"}</div>
            <div className="text-xs text-united-dark/60">{t("report.completion")}</div>
          </div>
          <div className="border border-united-dark/20 rounded-lg p-3 text-center">
            <div className="text-2xl font-extrabold">{data.stalledCount}</div>
            <div className="text-xs text-united-dark/60">{t("report.stalled")}</div>
          </div>
        </div>

        <h2 className="font-extrabold mb-2 print-break-inside-avoid">{t("report.open-now")}</h2>
        <table className="w-full text-sm border-collapse mb-6">
          <tbody>
            <tr className="border-b border-united-border">
              {OPEN_ORDER.map((s) => (
                <td key={s} className="p-2 text-center">
                  <div className="font-extrabold text-lg">{data.pipelineNow[s] ?? 0}</div>
                  <div className="text-[11px] text-united-dark/50">
                    {STATUS_DOT[s]} {statusLabel(s)}
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        <h2 className="font-extrabold mb-2 print-break-inside-avoid">{t("report.today-by-status")}</h2>
        <table className="w-full text-sm border-collapse mb-6">
          <tbody>
            <tr className="border-b border-united-border">
              {ORDER_STATUSES.map((s) => (
                <td key={s} className="p-2 text-center">
                  <div className="font-extrabold text-lg">{data.byStatusToday[s] ?? 0}</div>
                  <div className="text-[11px] text-united-dark/50">
                    {STATUS_DOT[s]} {statusLabel(s)}
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        <h2 className="font-extrabold mb-2 print-break-inside-avoid">{t("report.quantities")}</h2>
        <table className="w-full text-sm border-collapse mb-6">
          <tbody>
            <tr className="border-b border-united-border">
              <td className="p-2 text-center">
                <div className="font-extrabold text-lg">{data.quantitiesToday.required}</div>
                <div className="text-[11px] text-united-dark/50">{t("report.required")}</div>
              </td>
              <td className="p-2 text-center">
                <div className="font-extrabold text-lg">{data.quantitiesToday.prepared}</div>
                <div className="text-[11px] text-united-dark/50">{t("report.prepared")}</div>
              </td>
              <td className="p-2 text-center">
                <div className="font-extrabold text-lg">{data.quantitiesToday.loaded}</div>
                <div className="text-[11px] text-united-dark/50">{t("report.loaded")}</div>
              </td>
            </tr>
          </tbody>
        </table>

        {data.bottleneck.byStage.length > 0 && (
          <>
            <h2 className="font-extrabold mb-2 print-break-inside-avoid">{t("report.bottleneck")}</h2>
            <table className="w-full text-sm border-collapse mb-6">
              <thead>
                <tr className="bg-united-dark text-white">
                  <th className="p-2 text-start">{t("report.col.stage")}</th>
                  <th className="p-2 text-center">{t("report.col.count")}</th>
                  <th className="p-2 text-center">{t("report.col.avg")}</th>
                  <th className="p-2 text-center">{t("report.col.max")}</th>
                </tr>
              </thead>
              <tbody>
                {data.bottleneck.byStage.map((b) => (
                  <tr
                    key={b.status}
                    className={`border-b border-united-border print-break-inside-avoid ${
                      b.status === data.bottleneck.currentBottleneckStage ? "bg-amber-50" : ""
                    }`}
                  >
                    <td className="p-2 text-start font-bold">
                      {STATUS_DOT[b.status]} {statusLabel(b.status)}
                      {b.status === data.bottleneck.currentBottleneckStage && t("report.current-bottleneck")}
                    </td>
                    <td className="p-2 text-center">{b.count}</td>
                    <td className="p-2 text-center">{b.avgMinutes}</td>
                    <td className="p-2 text-center">{b.maxMinutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {data.needsAttention.length > 0 && (
          <>
            <h2 className="font-extrabold mb-2 print-break-inside-avoid">
              {t("report.needs-action", { count: data.needsAttentionTotal })}
            </h2>
            <table className="w-full text-sm border-collapse mb-6">
              <thead>
                <tr className="bg-united-dark text-white">
                  <th className="p-2 text-start">{t("report.col.order")}</th>
                  <th className="p-2 text-start">{t("report.col.reason")}</th>
                  <th className="p-2 text-start">{t("report.col.action")}</th>
                  <th className="p-2 text-center">{t("report.col.since")}</th>
                </tr>
              </thead>
              <tbody>
                {data.needsAttention.map((n) => (
                  <tr key={n.id} className="border-b border-united-border print-break-inside-avoid">
                    <td className="p-2 text-start font-bold">
                      {n.customerName} ({n.orderNumber})
                    </td>
                    <td className="p-2 text-start">{byKey(`attention.reason.${n.reason}`, n.reasonLabel)}</td>
                    <td className="p-2 text-start">{byKey(`attention.action.${n.reason}`, n.recommendedAction)}</td>
                    <td className="p-2 text-center">{n.minutesInStage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {data.exceptionsInformational > 0 && (
          <p className="text-sm text-united-dark/60 mb-6 print-break-inside-avoid">
            {t("report.informational", { count: data.exceptionsInformational })}
          </p>
        )}

        <div className="grid grid-cols-2 gap-6 mt-10 text-sm print-break-inside-avoid">
          <div>
            <div className="border-b border-united-dark h-14" />
            <div className="text-united-dark/60 mt-1">{t("report.supervisor-sign")}</div>
          </div>
          <div>
            <div className="border-b border-united-dark h-14" />
            <div className="text-united-dark/60 mt-1">{t("report.date-time")}</div>
          </div>
        </div>

        <p className="text-[10px] text-united-dark/30 mt-8">{t("report.printed-at", { when: new Date().toLocaleString(printIntl(locale)) })}</p>
      </div>
    </main>
  );
}
